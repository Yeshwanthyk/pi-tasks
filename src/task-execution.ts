import { randomUUID } from "node:crypto";
import { Clock, Effect, Result } from "effect";
import type { SubagentRpcError } from "./effect-errors.js";
import type {
  ReasoningEffort,
  SpawnSubagentRequest,
  SubagentClientCancelResult,
  SubagentClientSettledEvent,
  SubagentClientSnapshot,
} from "./subagent-adapter.js";
import { boundedOutput, executionAgentId, openBlockers, terminalExecutionResult } from "./task-projections.js";
import type { TaskStore } from "./task-store.js";
import type { Task } from "./types.js";

export interface CascadeConfig {
  additionalContext?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface TaskExecutionDeps {
  getStore(): TaskStore;
  currentWorkspaceRoot(): string;
  spawnSubagent(request: SpawnSubagentRequest): Effect.Effect<SubagentClientSnapshot, SubagentRpcError>;
  cancelSubagent(agentId: string): Effect.Effect<SubagentClientCancelResult, SubagentRpcError>;
  listSubagents: Effect.Effect<SubagentClientSnapshot[], SubagentRpcError>;
  writeOutput(taskId: string, content: string | undefined): string | undefined;
  notify(message: string): void;
  taskNotification(taskId: string, status: string, summary: string, outputFile?: string): string;
  onTaskActivated(taskId: string, active?: boolean): void;
  onTasksChanged(): void;
  onTaskCompleted(taskId: string): void;
  onCascadeBlocked(): void;
  isAutoCascadeEnabled(): boolean;
  getCascadeConfig(): CascadeConfig | undefined;
  subscribeSettled(handler: (data: SubagentClientSettledEvent) => void): () => void;
}

export interface ExecuteTasksOptions extends CascadeConfig {}

export interface ExecutionSummary {
  launched: Array<{ taskId: string; agentId: string }>;
  skipped: Array<{ taskId: string; reason: string }>;
}

export interface OutputResult {
  taskId: string;
  status: Task["status"];
  agentId: string;
  result?: string;
  outputFile?: string;
}

const PREREQUISITE_RESULT_LIMIT = 4000;

type ExecutionRef = { taskId: string; executionId: string };

export class TaskExecution {
  private agentTaskMap = new Map<string, ExecutionRef>();
  private pendingSettlements = new Map<string, SubagentClientSettledEvent[]>();

  constructor(private deps: TaskExecutionDeps) {}

  reset(): void {
    this.agentTaskMap.clear();
    this.pendingSettlements.clear();
  }

  buildTaskPrompt(
    task: { id: string; subject: string; description: string; blockedBy?: string[] },
    additionalContext?: string,
  ): string {
    let prompt = `You are executing task #${task.id}: "${task.subject}"\n\n${task.description}`;

    if (task.blockedBy && task.blockedBy.length > 0) {
      const depResults: string[] = [];
      for (const depId of task.blockedBy) {
        const dep = this.deps.getStore().get(depId);
        const result = dep?.execution && (dep.execution.status === "completed" || dep.execution.status === "stopped")
          ? dep.execution.result
          : typeof dep?.metadata?.result === "string" ? dep.metadata.result : undefined;
        if (dep && result) {
          const body = result.length > PREREQUISITE_RESULT_LIMIT
            ? result.slice(0, PREREQUISITE_RESULT_LIMIT) + "\n\n[... truncated — use TaskGet for full output]"
            : result;
          depResults.push(`### Task #${depId}: ${dep.subject}\n${body}`);
        }
      }
      if (depResults.length > 0) {
        prompt += `\n\n## Prerequisite task results\n\n${depResults.join("\n\n")}`;
      }
    }

    if (additionalContext) prompt += `\n\n${additionalContext}`;
    prompt += `\n\nComplete this task fully. Do not attempt to manage tasks yourself.`;
    return prompt;
  }

  syncRunning(options: { markMissing: boolean }): Effect.Effect<void, SubagentRpcError> {
    const self = this;
    return Effect.gen(function* () {
      const snapshots = yield* self.deps.listSubagents;
      const live = snapshots.filter(snapshot => snapshot.status === "running");
      let changed = false;
      let missing = false;

      for (const task of self.deps.getStore().list()) {
        const execution = task.execution;
        if (
          task.status !== "in_progress" ||
          !task.harness ||
          (execution?.status !== "running" && execution?.status !== "stopping")
        ) continue;

        const snapshot = live.find(candidate =>
          candidate.correlationId === execution.executionId &&
          candidate.harness === task.harness &&
          (execution.agentId === null || execution.agentId === candidate.id)
        );
        if (snapshot) {
          self.agentTaskMap.set(snapshot.id, {
            taskId: task.id,
            executionId: snapshot.correlationId,
          });
          if (execution.agentId === null) {
            self.deps.getStore().update(task.id, {
              owner: snapshot.id,
              execution: { ...execution, agentId: snapshot.id },
            });
            changed = true;
          }
          continue;
        }
        if (!options.markMissing) continue;

        self.deps.getStore().update(task.id, {
          status: "pending",
          execution: {
            status: "failed",
            executionId: execution.executionId,
            agentId: execution.agentId,
            failedAt: yield* Clock.currentTimeMillis,
            error: "Subagent is no longer running after session reload",
          },
        });
        self.deps.onTaskActivated(task.id, false);
        changed = true;
        missing = true;
      }

      if (missing) self.deps.onCascadeBlocked();
      if (changed) self.deps.onTasksChanged();
    });
  }

  executeTasks(taskIds: string[], options: ExecuteTasksOptions = {}): Effect.Effect<ExecutionSummary> {
    const self = this;
    return Effect.gen(function* () {
      const summary: ExecutionSummary = { launched: [], skipped: [] };

      for (const taskId of taskIds) {
        const task = self.deps.getStore().get(taskId);
        if (!task) {
          summary.skipped.push({ taskId, reason: "not found" });
          continue;
        }
        const launched = yield* self.launchTask(task, options);
        if (launched.success) summary.launched.push({ taskId, agentId: launched.agentId });
        else summary.skipped.push({ taskId, reason: launched.reason });
      }

      self.deps.onTasksChanged();
      return summary;
    });
  }

  private launchTask(task: Task, options: ExecuteTasksOptions): Effect.Effect<{ success: true; agentId: string } | { success: false; reason: string }> {
    const self = this;
    return Effect.gen(function* () {
      if (task.status !== "pending") return { success: false as const, reason: `not pending (status: ${task.status})` };
      if (!task.harness) return { success: false as const, reason: "no harness set — create with the harness parameter" };
      if (task.project && task.project.root !== self.deps.currentWorkspaceRoot()) {
        return { success: false as const, reason: "belongs to workspace " + task.project.root };
      }

      const blockers = openBlockers(task, id => self.deps.getStore().get(id));
      if (blockers.length > 0) {
        return { success: false as const, reason: `blocked by ${blockers.map(id => "#" + id).join(", ")}` };
      }

      const executionId = randomUUID();
      const startedAt = yield* Clock.currentTimeMillis;
      self.deps.getStore().update(task.id, {
        status: "in_progress",
        execution: { status: "running", executionId, agentId: null, startedAt },
      });

      const spawned = yield* self.deps.spawnSubagent({
        correlationId: executionId,
        harness: task.harness,
        name: task.subject,
        prompt: self.buildTaskPrompt(task, options.additionalContext),
        cwd: self.deps.currentWorkspaceRoot(),
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      }).pipe(Effect.result);

      if (Result.isFailure(spawned)) {
        self.pendingSettlements.delete(executionId);
        const failedAt = yield* Clock.currentTimeMillis;
        self.deps.getStore().update(task.id, {
          status: "pending",
          execution: {
            status: "failed",
            executionId,
            agentId: null,
            failedAt,
            error: spawned.failure.message,
          },
        });
        return { success: false as const, reason: `spawn failed — ${spawned.failure.message}` };
      }

      const snapshot = spawned.success;
      if (snapshot.correlationId !== executionId || snapshot.harness !== task.harness) {
        self.pendingSettlements.delete(executionId);
        const failedAt = yield* Clock.currentTimeMillis;
        self.deps.getStore().update(task.id, {
          status: "pending",
          execution: {
            status: "failed",
            executionId,
            agentId: null,
            failedAt,
            error: "Spawn reply correlation did not match the requested execution",
          },
        });
        return { success: false as const, reason: "spawn failed — reply correlation mismatch" };
      }

      const agentId = snapshot.id;
      self.agentTaskMap.set(agentId, { taskId: task.id, executionId });
      self.deps.getStore().update(task.id, {
        owner: agentId,
        execution: { status: "running", executionId, agentId, startedAt },
      });
      self.deps.onTaskActivated(task.id, true);

      const earlySettlement = self.pendingSettlements.get(executionId)?.find(event => event.agentId === agentId);
      self.pendingSettlements.delete(executionId);
      if (earlySettlement) yield* self.handleSettled(earlySettlement);

      return { success: true as const, agentId };
    });
  }

  handleSettled(data: SubagentClientSettledEvent): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const execution = self.findTaskForSettlement(data);
      if (!execution) {
        const awaitingAgent = self.deps.getStore().list().some(task =>
          task.status === "in_progress" &&
          task.execution?.status === "running" &&
          task.execution.executionId === data.correlationId &&
          task.execution.agentId === null
        );
        if (awaitingAgent) {
          const queued = self.pendingSettlements.get(data.correlationId) ?? [];
          queued.push(data);
          self.pendingSettlements.set(data.correlationId, queued);
        }
        return;
      }

      const mapped = self.agentTaskMap.get(data.agentId);
      if (mapped?.executionId === data.correlationId) self.agentTaskMap.delete(data.agentId);
      const task = self.deps.getStore().get(execution.taskId);
      if (!task) return;

      switch (data.outcome) {
        case "completed": {
          const completedAt = yield* Clock.currentTimeMillis;
          const outputFile = self.deps.writeOutput(task.id, data.result);
          self.deps.getStore().update(task.id, {
            status: "completed",
            execution: {
              status: "completed",
              executionId: data.correlationId,
              agentId: data.agentId,
              completedAt,
              result: data.result,
              outputFile,
            },
          });
          self.deps.notify(self.deps.taskNotification(task.id, "completed", `Task "${task.subject}" completed`, outputFile));
          self.deps.onTaskActivated(task.id, false);

          if (self.deps.isAutoCascadeEnabled()) {
            const cascadeConfig = self.deps.getCascadeConfig();
            if (cascadeConfig) {
              const unblocked = self.deps.getStore().list().filter(candidate =>
                candidate.status === "pending" &&
                candidate.harness &&
                candidate.blockedBy.includes(task.id) &&
                candidate.blockedBy.every(depId => self.deps.getStore().get(depId)?.status === "completed")
              );
              for (const next of unblocked) yield* self.launchTask(next, cascadeConfig);
            }
          }

          self.deps.onTaskCompleted(task.id);
          break;
        }
        case "failed": {
          const failedAt = yield* Clock.currentTimeMillis;
          const outputFile = self.deps.writeOutput(task.id, data.result);
          self.deps.getStore().update(task.id, {
            status: "pending",
            execution: {
              status: "failed",
              executionId: data.correlationId,
              agentId: data.agentId,
              failedAt,
              error: data.error ?? "Subagent failed",
              result: data.result,
              outputFile,
            },
          });
          self.deps.notify(self.deps.taskNotification(task.id, "failed", `Task "${task.subject}" failed: ${data.error ?? "Subagent failed"}`, outputFile));
          self.deps.onTaskActivated(task.id, false);
          self.deps.onCascadeBlocked();
          break;
        }
        case "cancelled": {
          const stoppedAt = yield* Clock.currentTimeMillis;
          const existingResult = task.execution?.status === "stopped" ? task.execution.result : undefined;
          const finalResult = data.result ?? existingResult;
          const outputFile = self.deps.writeOutput(task.id, finalResult);
          const wasAlreadyStopped = task.execution?.status === "stopped";
          self.deps.getStore().update(task.id, {
            status: "pending",
            execution: {
              status: "stopped",
              executionId: data.correlationId,
              agentId: data.agentId,
              stoppedAt,
              result: finalResult,
              outputFile,
            },
          });
          self.deps.notify(self.deps.taskNotification(task.id, "stopped", `Task "${task.subject}" was stopped`, outputFile));
          self.deps.onTaskActivated(task.id, false);
          if (!wasAlreadyStopped) self.deps.onCascadeBlocked();
          break;
        }
      }
      self.deps.onTasksChanged();
    });
  }

  private findTaskForSettlement(data: SubagentClientSettledEvent): ExecutionRef | undefined {
    const acceptsStatus = (task: Task, execution: NonNullable<Task["execution"]>): boolean => {
      if (task.status === "in_progress") {
        return execution.status === "running" || execution.status === "stopping";
      }
      return data.outcome === "cancelled" &&
        task.status === "pending" &&
        execution.status === "stopped";
    };
    const mapped = this.agentTaskMap.get(data.agentId);
    if (mapped) {
      if (mapped.executionId !== data.correlationId) return undefined;
      const task = this.deps.getStore().get(mapped.taskId);
      const execution = task?.execution;
      return task &&
        execution &&
        execution.executionId === data.correlationId &&
        execution.agentId === data.agentId &&
        acceptsStatus(task, execution)
        ? mapped
        : undefined;
    }
    const task = this.deps.getStore().list().find(candidate => {
      const execution = candidate.execution;
      return execution?.executionId === data.correlationId &&
        execution.agentId === data.agentId &&
        acceptsStatus(candidate, execution);
    });
    return task ? { taskId: task.id, executionId: data.correlationId } : undefined;
  }

  output(taskOrAgentId: string, block: boolean, timeout: number): Effect.Effect<OutputResult | undefined> {
    const self = this;
    return Effect.gen(function* () {
      let resolvedId = self.resolveTaskId(taskOrAgentId);
      let task = self.deps.getStore().get(resolvedId);
      let agentId = executionAgentId(task);
      if (!task || !agentId) return undefined;

      if (block && task.status === "in_progress") {
        const executionId = task.execution?.executionId;
        const waitForSettlement = Effect.callback<void>((resume) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            unsubscribe();
            resume(Effect.void);
          };
          const unsubscribe = self.deps.subscribeSettled(event => {
            if (event.agentId === agentId && event.correlationId === executionId) queueMicrotask(finish);
          });
          const current = self.deps.getStore().get(resolvedId);
          if (current && current.status !== "in_progress") finish();
          return Effect.sync(unsubscribe);
        }).pipe(Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.void }));
        yield* waitForSettlement;
        task = self.deps.getStore().get(resolvedId) ?? task;
        agentId = executionAgentId(task) ?? agentId;
      }

      const { result: rawResult, outputFile } = terminalExecutionResult(task.execution);
      const result = rawResult === undefined ? undefined : boundedOutput(rawResult);
      return { taskId: resolvedId, status: task.status, agentId, result, outputFile };
    });
  }

  stop(taskOrAgentId: string): Effect.Effect<
    { stopped: true; taskId: string } | { stopped: false },
    SubagentRpcError
  > {
    const self = this;
    return Effect.gen(function* () {
      const resolvedId = self.resolveTaskId(taskOrAgentId);
      const task = self.deps.getStore().get(resolvedId);
      const agentId = executionAgentId(task);
      if (!task || !agentId || task.status !== "in_progress") return { stopped: false as const };

      const execution = task.execution;
      const executionId = execution?.executionId ?? randomUUID();
      const stopRequestedAt = yield* Clock.currentTimeMillis;
      self.deps.getStore().update(resolvedId, {
        status: "in_progress",
        execution: {
          status: "stopping",
          executionId,
          agentId,
          stopRequestedAt,
        },
      });
      const startedAt = execution?.status === "running"
        ? execution.startedAt
        : stopRequestedAt;
      const cancelResult = yield* self.deps.cancelSubagent(agentId).pipe(
        Effect.tapError(() => Effect.sync(() => {
          self.deps.getStore().update(resolvedId, {
            status: "in_progress",
            execution: {
              status: "running",
              executionId,
              agentId,
              startedAt,
            },
          });
          self.deps.onTasksChanged();
        })),
      );
      if (!cancelResult.cancelled) return { stopped: false as const };

      self.agentTaskMap.delete(agentId);
      const current = self.deps.getStore().get(resolvedId);
      if (current?.execution?.executionId === executionId && current.execution.status === "stopping") {
        const stoppedAt = yield* Clock.currentTimeMillis;
        self.deps.getStore().update(resolvedId, {
          status: "pending",
          execution: {
            status: "stopped",
            executionId,
            agentId,
            stoppedAt,
          },
        });
        self.deps.onCascadeBlocked();
        self.deps.onTaskActivated(resolvedId, false);
        self.deps.onTasksChanged();
      }
      return { stopped: true as const, taskId: resolvedId };
    });
  }

  private resolveTaskId(taskOrAgentId: string): string {
    if (this.deps.getStore().get(taskOrAgentId)) return taskOrAgentId;
    for (const [agentId, execution] of this.agentTaskMap) {
      if (agentId === taskOrAgentId || agentId.startsWith(taskOrAgentId)) return execution.taskId;
    }
    return this.deps.getStore().list().find(task => {
      const agentId = executionAgentId(task);
      return agentId && (agentId === taskOrAgentId || agentId.startsWith(taskOrAgentId));
    })?.id ?? taskOrAgentId;
  }
}

import { randomUUID } from "node:crypto";
import { Clock, Effect, Result } from "effect";
import type { SubagentRpcError } from "./effect-errors.js";
import { boundedOutput, executionAgentId, openBlockers, terminalExecutionResult } from "./task-projections.js";
import type { TaskStore } from "./task-store.js";
import type { Task } from "./types.js";

export interface CascadeConfig {
  additionalContext?: string;
  model?: string;
  maxTurns?: number;
}

export interface TaskExecutionDeps {
  getStore(): TaskStore;
  currentWorkspaceRoot(): string;
  spawnSubagent(type: string, prompt: string, options?: unknown): Effect.Effect<string, SubagentRpcError>;
  stopSubagent(agentId: string): Effect.Effect<void>;
  writeOutput(taskId: string, content: string | undefined): string | undefined;
  notify(message: string): void;
  taskNotification(taskId: string, status: string, summary: string, outputFile?: string): string;
  onTaskActivated(taskId: string, active?: boolean): void;
  onTasksChanged(): void;
  onTaskCompleted(taskId: string): void;
  onCascadeBlocked(): void;
  isAutoCascadeEnabled(): boolean;
  getCascadeConfig(): CascadeConfig | undefined;
  subscribeSubagentEvent(event: "subagents:completed" | "subagents:failed", handler: (data: unknown) => void): () => void;
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

export class TaskExecution {
  private agentTaskMap = new Map<string, { taskId: string; executionId: string }>();

  constructor(private deps: TaskExecutionDeps) {}

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

  findTaskForAgent(agentId: string, opts?: { allowStopped?: boolean }): { taskId: string; executionId?: string } | undefined {
    const mapped = this.agentTaskMap.get(agentId);
    if (mapped) {
      const task = this.deps.getStore().get(mapped.taskId);
      const statusMatches = task?.status === "in_progress" || (opts?.allowStopped && task?.execution?.status === "stopped");
      if (statusMatches && task.execution?.executionId === mapped.executionId) return mapped;
      return undefined;
    }
    const task = this.deps.getStore().list().find(t => {
      const execution = t.execution;
      const legacyAgentId = executionAgentId(t);
      return (execution?.agentId === agentId &&
        (execution.status === "running" || execution.status === "stopping" || (opts?.allowStopped && execution.status === "stopped"))) ||
        (!execution && t.status === "in_progress" && legacyAgentId === agentId);
    });
    return task ? { taskId: task.id, executionId: task.execution?.executionId } : undefined;
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
      if (!task.agentType) return { success: false as const, reason: "no agentType set — create with agentType parameter" };
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

      const prompt = self.buildTaskPrompt(task, options.additionalContext);
      const spawned = yield* self.deps.spawnSubagent(task.agentType, prompt, {
        description: task.subject,
        isBackground: true,
        maxTurns: options.maxTurns,
        ...(options.model ? { model: options.model } : {}),
      }).pipe(Effect.result);

      if (Result.isFailure(spawned)) {
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

      const agentId = spawned.success;
      self.agentTaskMap.set(agentId, { taskId: task.id, executionId });
      self.deps.getStore().update(task.id, {
        owner: agentId,
        execution: { status: "running", executionId, agentId, startedAt },
      });
      self.deps.onTaskActivated(task.id, true);
      return { success: true as const, agentId };
    });
  }

  handleCompleted(data: { id: string; result?: string }): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const execution = self.findTaskForAgent(data.id);
      if (!execution) return;
      self.agentTaskMap.delete(data.id);
      const task = self.deps.getStore().get(execution.taskId);
      if (!task) return;
      const executionId = task.execution?.executionId ?? randomUUID();
      const completedAt = yield* Clock.currentTimeMillis;

      const outputFile = self.deps.writeOutput(task.id, data.result);
      self.deps.getStore().update(task.id, {
        status: "completed",
        execution: {
          status: "completed",
          executionId,
          agentId: data.id,
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
          const unblocked = self.deps.getStore().list().filter(t =>
            t.status === "pending" &&
            t.agentType &&
            t.blockedBy.includes(task.id) &&
            t.blockedBy.every(depId => self.deps.getStore().get(depId)?.status === "completed")
          );
          for (const next of unblocked) yield* self.launchTask(next, cascadeConfig);
        }
      }

      self.deps.onTaskCompleted(task.id);
      self.deps.onTasksChanged();
    });
  }

  handleFailed(data: { id: string; error?: string; result?: string; status: string }): void {
    const execution = this.findTaskForAgent(data.id, { allowStopped: data.status === "stopped" });
    if (!execution) return;
    this.agentTaskMap.delete(data.id);
    const task = this.deps.getStore().get(execution.taskId);
    if (!task) return;
    const executionId = task.execution?.executionId ?? randomUUID();

    if (data.status === "stopped") {
      const wasAlreadyStopped = task.execution?.status === "stopped";
      const finalResult = data.result || (task.execution && (task.execution.status === "completed" || task.execution.status === "stopped") ? task.execution.result : undefined);
      const outputFile = this.deps.writeOutput(task.id, finalResult);
      this.deps.getStore().update(task.id, {
        status: "pending",
        execution: {
          status: "stopped",
          executionId,
          agentId: data.id,
          stoppedAt: Date.now(),
          result: finalResult,
          outputFile,
        },
      });
      this.deps.notify(this.deps.taskNotification(task.id, "stopped", `Task "${task.subject}" was stopped`, outputFile));
      if (!wasAlreadyStopped) this.deps.onCascadeBlocked();
    } else {
      this.deps.getStore().update(task.id, {
        status: "pending",
        execution: {
          status: "failed",
          executionId,
          agentId: data.id,
          failedAt: Date.now(),
          error: data.error || data.status,
        },
      });
      this.deps.notify(this.deps.taskNotification(task.id, "failed", `Task "${task.subject}" failed: ${data.error || data.status}`));
      this.deps.onCascadeBlocked();
    }
    this.deps.onTaskActivated(task.id, false);
    this.deps.onTasksChanged();
  }

  output(taskOrAgentId: string, block: boolean, timeout: number): Effect.Effect<OutputResult | undefined> {
    const self = this;
    return Effect.gen(function* () {
      let resolvedId = taskOrAgentId;
      if (!self.deps.getStore().get(resolvedId)) {
        for (const [agentId, execution] of self.agentTaskMap) {
          if (agentId === taskOrAgentId || agentId.startsWith(taskOrAgentId)) {
            resolvedId = execution.taskId;
            break;
          }
        }
        if (!self.deps.getStore().get(resolvedId)) {
          const matched = self.deps.getStore().list().find(t => {
            const agentId = executionAgentId(t);
            return agentId && (agentId === taskOrAgentId || agentId.startsWith(taskOrAgentId));
          });
          if (matched) resolvedId = matched.id;
        }
      }
      let task = self.deps.getStore().get(resolvedId);
      let agentId = executionAgentId(task);
      if (!task || !agentId) return undefined;

      if (block && task.status === "in_progress") {
        const waitForSettlement = Effect.callback<void>((resume) => {
          let settled = false;
          let unsubOk = () => {};
          let unsubFail = () => {};
          const finish = () => {
            if (settled) return;
            settled = true;
            unsubOk();
            unsubFail();
            resume(Effect.void);
          };
          unsubOk = self.deps.subscribeSubagentEvent("subagents:completed", d => {
            if ((d as { id?: string }).id === agentId) finish();
          });
          unsubFail = self.deps.subscribeSubagentEvent("subagents:failed", d => {
            if ((d as { id?: string }).id === agentId) finish();
          });
          const current = self.deps.getStore().get(resolvedId);
          if (current && current.status !== "in_progress") finish();
          return Effect.sync(() => {
            unsubOk();
            unsubFail();
          });
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

  stop(taskOrAgentId: string): Effect.Effect<{ stopped: true; taskId: string } | { stopped: false }> {
    const self = this;
    return Effect.gen(function* () {
      let resolvedId = taskOrAgentId;
      if (!self.deps.getStore().get(resolvedId)) {
        for (const [agentId, execution] of self.agentTaskMap) {
          if (agentId === taskOrAgentId || agentId.startsWith(taskOrAgentId)) {
            resolvedId = execution.taskId;
            break;
          }
        }
      }
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
      yield* self.deps.stopSubagent(agentId);
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
      }
      self.deps.onCascadeBlocked();
      self.deps.onTaskActivated(resolvedId, false);
      self.deps.onTasksChanged();
      return { stopped: true as const, taskId: resolvedId };
    });
  }
}

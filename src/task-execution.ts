import { randomUUID } from "node:crypto";
import type { TaskStore } from "./task-store.js";
import type { Task } from "./types.js";

export interface CascadeConfig {
  additionalContext?: string;
  model?: string;
  maxTurns?: number;
}

export interface TaskExecutionDeps {
  getStore(): TaskStore;
  spawnSubagent(type: string, prompt: string, options?: unknown): Promise<string>;
  stopSubagent(agentId: string): Promise<void>;
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

function boundedOutput(content: unknown, maxChars = 50_000): string {
  const text = typeof content === "string" ? content : "";
  return text.length > maxChars ? text.slice(0, maxChars) + "\n\n[... truncated]" : text;
}

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
          : undefined;
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

  findTaskForAgent(agentId: string, opts?: { allowCompleted?: boolean }): { taskId: string; executionId?: string } | undefined {
    const mapped = this.agentTaskMap.get(agentId);
    if (mapped) {
      const task = this.deps.getStore().get(mapped.taskId);
      const statusMatches = task?.status === "in_progress" || (opts?.allowCompleted && task?.status === "completed");
      if (statusMatches && task.execution?.executionId === mapped.executionId) return mapped;
      return undefined;
    }
    const task = this.deps.getStore().list().find(t => {
      const execution = t.execution;
      const legacyAgentId = typeof t.metadata?.agentId === "string" ? t.metadata.agentId : undefined;
      return (execution?.agentId === agentId &&
        (execution.status === "running" || execution.status === "stopping" || (opts?.allowCompleted && t.status === "completed"))) ||
        (!execution && t.status === "in_progress" && legacyAgentId === agentId);
    });
    return task ? { taskId: task.id, executionId: task.execution?.executionId } : undefined;
  }

  async executeTasks(taskIds: string[], options: ExecuteTasksOptions = {}): Promise<ExecutionSummary> {
    const summary: ExecutionSummary = { launched: [], skipped: [] };

    for (const taskId of taskIds) {
      const task = this.deps.getStore().get(taskId);
      if (!task) {
        summary.skipped.push({ taskId, reason: "not found" });
        continue;
      }
      const launched = await this.launchTask(task, options);
      if (launched.success) summary.launched.push({ taskId, agentId: launched.agentId });
      else summary.skipped.push({ taskId, reason: launched.reason });
    }

    this.deps.onTasksChanged();
    return summary;
  }

  private async launchTask(task: Task, options: ExecuteTasksOptions): Promise<{ success: true; agentId: string } | { success: false; reason: string }> {
    if (task.status !== "pending") return { success: false, reason: `not pending (status: ${task.status})` };
    if (!task.agentType) return { success: false, reason: "no agentType set — create with agentType parameter" };

    const openBlockers = task.blockedBy.filter(bid => {
      const blocker = this.deps.getStore().get(bid);
      return !blocker || blocker.status !== "completed";
    });
    if (openBlockers.length > 0) return { success: false, reason: `blocked by ${openBlockers.map(id => "#" + id).join(", ")}` };

    const executionId = randomUUID();
    this.deps.getStore().update(task.id, {
      status: "in_progress",
      execution: { status: "running", executionId, agentId: null, startedAt: Date.now() },
    });

    try {
      const prompt = this.buildTaskPrompt(task, options.additionalContext);
      const agentId = await this.deps.spawnSubagent(task.agentType, prompt, {
        description: task.subject,
        isBackground: true,
        maxTurns: options.maxTurns,
        ...(options.model ? { model: options.model } : {}),
      });
      this.agentTaskMap.set(agentId, { taskId: task.id, executionId });
      this.deps.getStore().update(task.id, {
        owner: agentId,
        execution: { status: "running", executionId, agentId, startedAt: Date.now() },
      });
      this.deps.onTaskActivated(task.id, true);
      return { success: true, agentId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.getStore().update(task.id, {
        status: "pending",
        execution: { status: "failed", executionId, agentId: null, failedAt: Date.now(), error: message },
      });
      return { success: false, reason: `spawn failed — ${message}` };
    }
  }

  async handleCompleted(data: { id: string; result?: string }): Promise<void> {
    const execution = this.findTaskForAgent(data.id);
    if (!execution) return;
    this.agentTaskMap.delete(data.id);
    const task = this.deps.getStore().get(execution.taskId);
    if (!task) return;
    const executionId = task.execution?.executionId ?? randomUUID();

    const outputFile = this.deps.writeOutput(task.id, data.result);
    this.deps.getStore().update(task.id, {
      status: "completed",
      execution: {
        status: "completed",
        executionId,
        agentId: data.id,
        completedAt: Date.now(),
        result: data.result,
        outputFile,
      },
    });
    this.deps.notify(this.deps.taskNotification(task.id, "completed", `Task "${task.subject}" completed`, outputFile));
    this.deps.onTaskActivated(task.id, false);

    if (this.deps.isAutoCascadeEnabled()) {
      const cascadeConfig = this.deps.getCascadeConfig();
      if (cascadeConfig) {
        const unblocked = this.deps.getStore().list().filter(t =>
          t.status === "pending" &&
          t.agentType &&
          t.blockedBy.includes(task.id) &&
          t.blockedBy.every(depId => this.deps.getStore().get(depId)?.status === "completed")
        );
        for (const next of unblocked) await this.launchTask(next, cascadeConfig);
      }
    }

    this.deps.onTaskCompleted(task.id);
    this.deps.onTasksChanged();
  }

  handleFailed(data: { id: string; error?: string; result?: string; status: string }): void {
    const execution = this.findTaskForAgent(data.id, { allowCompleted: data.status === "stopped" });
    if (!execution) return;
    this.agentTaskMap.delete(data.id);
    const task = this.deps.getStore().get(execution.taskId);
    if (!task) return;
    const executionId = task.execution?.executionId ?? randomUUID();

    if (data.status === "stopped") {
      const finalResult = data.result || (task.execution && (task.execution.status === "completed" || task.execution.status === "stopped") ? task.execution.result : undefined);
      const outputFile = this.deps.writeOutput(task.id, finalResult);
      this.deps.getStore().update(task.id, {
        status: "completed",
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
      this.deps.onTaskCompleted(task.id);
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

  async output(taskOrAgentId: string, block: boolean, timeout: number, signal?: AbortSignal): Promise<OutputResult | undefined> {
    let resolvedId = taskOrAgentId;
    if (!this.deps.getStore().get(resolvedId)) {
      for (const [agentId, execution] of this.agentTaskMap) {
        if (agentId === taskOrAgentId || agentId.startsWith(taskOrAgentId)) {
          resolvedId = execution.taskId;
          break;
        }
      }
    }
    let task = this.deps.getStore().get(resolvedId);
    let agentId = task?.execution?.agentId ?? (typeof task?.metadata?.agentId === "string" ? task.metadata.agentId : undefined);
    if (!task || !agentId) return undefined;

    if (block && task.status === "in_progress") {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubOk();
          unsubFail();
          resolve();
        };
        const timer = setTimeout(finish, timeout);
        const unsubOk = this.deps.subscribeSubagentEvent("subagents:completed", d => {
          if ((d as { id?: string }).id === agentId) finish();
        });
        const unsubFail = this.deps.subscribeSubagentEvent("subagents:failed", d => {
          if ((d as { id?: string }).id === agentId) finish();
        });
        const current = this.deps.getStore().get(resolvedId);
        if (current && current.status !== "in_progress") finish();
        signal?.addEventListener("abort", finish, { once: true });
      });
      task = this.deps.getStore().get(resolvedId) ?? task;
      agentId = task.execution?.agentId ?? agentId;
    }

    const execution = task.execution;
    const result = execution && (execution.status === "completed" || execution.status === "stopped") ? boundedOutput(execution.result) : undefined;
    const outputFile = execution && (execution.status === "completed" || execution.status === "stopped") ? execution.outputFile : undefined;
    return { taskId: resolvedId, status: task.status, agentId, result, outputFile };
  }

  async stop(taskOrAgentId: string): Promise<{ stopped: true; taskId: string } | { stopped: false }> {
    let resolvedId = taskOrAgentId;
    if (!this.deps.getStore().get(resolvedId)) {
      for (const [agentId, execution] of this.agentTaskMap) {
        if (agentId === taskOrAgentId || agentId.startsWith(taskOrAgentId)) {
          resolvedId = execution.taskId;
          break;
        }
      }
    }
    const task = this.deps.getStore().get(resolvedId);
    const agentId = task?.execution?.agentId ?? (typeof task?.metadata?.agentId === "string" ? task.metadata.agentId : undefined);
    if (!task || !agentId || task.status !== "in_progress") return { stopped: false };

    const execution = task.execution;
    const executionId = execution?.executionId ?? randomUUID();
    this.deps.getStore().update(resolvedId, {
      status: "completed",
      execution: {
        status: "stopping",
        executionId,
        agentId,
        stopRequestedAt: Date.now(),
      },
    });
    this.deps.onTaskCompleted(resolvedId);
    await this.deps.stopSubagent(agentId);
    this.deps.onTaskActivated(resolvedId, false);
    this.deps.onTasksChanged();
    return { stopped: true, taskId: resolvedId };
  }
}

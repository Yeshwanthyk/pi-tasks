import type { Task } from "./types.js";

export const DEFAULT_OUTPUT_LIMIT = 50_000;

export function boundedOutput(content: unknown, maxChars = DEFAULT_OUTPUT_LIMIT): string {
  const text = typeof content === "string" ? content : "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[... truncated]` : text;
}

export function executionAgentId(task: Pick<Task, "execution" | "metadata"> | undefined): string | undefined {
  return task?.execution?.agentId ?? (typeof task?.metadata?.agentId === "string" ? task.metadata.agentId : undefined);
}

export function terminalExecutionResult(execution: Task["execution"]): { result?: string; outputFile?: string } {
  if (
    !execution ||
    (execution.status !== "completed" &&
      execution.status !== "failed" &&
      execution.status !== "stopped")
  ) return {};
  return { result: execution.result, outputFile: execution.outputFile };
}

export function openBlockers(task: Pick<Task, "blockedBy">, getTask: (id: string) => Task | undefined): string[] {
  return task.blockedBy.filter(blockerId => getTask(blockerId)?.status !== "completed");
}

export function openExistingBlockers(task: Pick<Task, "blockedBy">, getTask: (id: string) => Task | undefined): string[] {
  return task.blockedBy.filter(blockerId => {
    const blocker = getTask(blockerId);
    return blocker && blocker.status !== "completed";
  });
}

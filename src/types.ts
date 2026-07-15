/**
 * types.ts — Type definitions for the task management system.
 */

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskProject {
  name: string;
  root: string;
  remote?: string;
  branch?: string;
}

export type TaskExecutionState =
  | { status: "running"; executionId: string; agentId: string | null; startedAt: number }
  | { status: "completed"; executionId: string; agentId: string; completedAt: number; result?: string; outputFile?: string }
  | { status: "failed"; executionId: string; agentId: string | null; failedAt: number; error: string }
  | { status: "stopping"; executionId: string; agentId: string; stopRequestedAt: number }
  | { status: "stopped"; executionId: string; agentId: string; stoppedAt: number; result?: string; outputFile?: string };

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  agentType?: string;
  execution?: TaskExecutionState;
  project?: TaskProject;
  sessionId?: string;
  metadata: Record<string, unknown>;
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

/** Serialized store format on disk. */
export interface TaskStoreData {
  nextId: number;
  /** Highest numeric task ID ever assigned. Preserved across deletes/clears. */
  highWaterMark?: number;
  tasks: Task[];
}

/** Background process associated with a task. */
export interface BackgroundProcess {
  taskId: string;
  pid: number;
  command?: string;
  outputFile?: string;
  output: string[];
  status: "running" | "completed" | "error" | "stopped";
  exitCode?: number;
  startedAt: number;
  completedAt?: number;
  proc: import("node:child_process").ChildProcess;
  abortController: AbortController;
  waiters: Array<() => void>;
  watchdogTimer?: ReturnType<typeof setInterval>;
}

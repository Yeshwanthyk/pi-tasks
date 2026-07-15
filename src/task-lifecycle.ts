import type { TaskStore } from "./task-store.js";
import type { Task, TaskProject, TaskStatus } from "./types.js";

export interface TaskLifecycleDeps {
  getStore(): TaskStore;
  currentTurn(): number;
  onTaskActivated(taskId: string, active?: boolean): void;
  onTasksChanged(): void;
  onTaskCompleted(taskId: string, turn: number): void;
  onBatchCountdownReset(): void;
}

export interface TaskUpdateFields {
  status?: TaskStatus | "deleted";
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  agentType?: string;
  execution?: Task["execution"];
  metadata?: Record<string, unknown>;
  addBlocks?: string[];
  addBlockedBy?: string[];
}

export class TaskLifecycle {
  constructor(private deps: TaskLifecycleDeps) {}

  create(
    subject: string,
    description: string,
    activeForm?: string,
    metadata?: Record<string, unknown>,
    agentType?: string,
    project?: TaskProject,
    sessionId?: string,
  ): Task {
    this.deps.onBatchCountdownReset();
    const task = this.deps.getStore().create(subject, description, activeForm, metadata, agentType, project, sessionId);
    this.deps.onTasksChanged();
    return task;
  }

  update(taskId: string, fields: TaskUpdateFields): { task: Task | undefined; changedFields: string[]; warnings: string[] } {
    const result = this.deps.getStore().update(taskId, fields);
    if (result.task || result.changedFields.includes("deleted")) {
      this.applyStatusSideEffects(taskId, fields.status);
      this.deps.onTasksChanged();
    }
    return result;
  }

  markCompleted(taskId: string): { task: Task | undefined; changedFields: string[]; warnings: string[] } {
    return this.update(taskId, { status: "completed" });
  }

  private applyStatusSideEffects(taskId: string, status: TaskUpdateFields["status"]): void {
    if (status === "in_progress") {
      this.deps.onTaskActivated(taskId);
      this.deps.onBatchCountdownReset();
    } else if (status === "pending") {
      this.deps.onBatchCountdownReset();
    } else if (status === "completed" || status === "deleted") {
      this.deps.onTaskActivated(taskId, false);
      if (status === "completed") this.deps.onTaskCompleted(taskId, this.deps.currentTurn());
    }
  }
}

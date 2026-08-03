import { Schema } from "effect";
import { TASK_HARNESSES } from "./types.js";

export const TaskStatusSchema = Schema.Literals(["pending", "in_progress", "completed"]);
export const TaskHarnessSchema = Schema.Literals(TASK_HARNESSES);

export const TaskProjectSchema = Schema.Struct({
  name: Schema.String,
  root: Schema.String,
  remote: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
});

const RunningExecutionSchema = Schema.Struct({
  status: Schema.Literal("running"),
  executionId: Schema.String,
  agentId: Schema.NullOr(Schema.String),
  startedAt: Schema.Finite,
});

const CompletedExecutionSchema = Schema.Struct({
  status: Schema.Literal("completed"),
  executionId: Schema.String,
  agentId: Schema.String,
  completedAt: Schema.Finite,
  result: Schema.optional(Schema.String),
  outputFile: Schema.optional(Schema.String),
});

const FailedExecutionSchema = Schema.Struct({
  status: Schema.Literal("failed"),
  executionId: Schema.String,
  agentId: Schema.NullOr(Schema.String),
  failedAt: Schema.Finite,
  error: Schema.String,
  result: Schema.optional(Schema.String),
  outputFile: Schema.optional(Schema.String),
});

const StoppingExecutionSchema = Schema.Struct({
  status: Schema.Literal("stopping"),
  executionId: Schema.String,
  agentId: Schema.String,
  stopRequestedAt: Schema.Finite,
});

const StoppedExecutionSchema = Schema.Struct({
  status: Schema.Literal("stopped"),
  executionId: Schema.String,
  agentId: Schema.String,
  stoppedAt: Schema.Finite,
  result: Schema.optional(Schema.String),
  outputFile: Schema.optional(Schema.String),
});

export const TaskExecutionStateSchema = Schema.Union([
  RunningExecutionSchema,
  CompletedExecutionSchema,
  FailedExecutionSchema,
  StoppingExecutionSchema,
  StoppedExecutionSchema,
]);

export const TaskSchema = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  description: Schema.String,
  status: TaskStatusSchema,
  activeForm: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.String),
  harness: Schema.optional(TaskHarnessSchema),
  execution: Schema.optional(TaskExecutionStateSchema),
  project: Schema.optional(TaskProjectSchema),
  sessionId: Schema.optional(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  blocks: Schema.mutable(Schema.Array(Schema.String)),
  blockedBy: Schema.mutable(Schema.Array(Schema.String)),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});

export const TaskStoreDataSchema = Schema.Struct({
  nextId: Schema.Finite,
  highWaterMark: Schema.optional(Schema.Finite),
  tasks: Schema.mutable(Schema.Array(TaskSchema)),
});

const TaskStoreJsonSchema = Schema.fromJsonString(TaskStoreDataSchema);

/** Migrate the legacy agentType field without keeping it in the public task model. */
export function decodeTaskStoreData(json: string) {
  const raw = JSON.parse(json) as { tasks?: Array<Record<string, unknown>> };
  for (const task of raw.tasks ?? []) {
    const metadata = task.metadata && typeof task.metadata === "object"
      ? task.metadata as Record<string, unknown>
      : undefined;
    const legacyAgentType = typeof task.agentType === "string" || typeof metadata?.agentType === "string";
    if (task.harness === undefined && legacyAgentType) task.harness = "pi";
    delete task.agentType;
    if (metadata) delete metadata.agentType;
  }
  return Schema.decodeUnknownSync(TaskStoreDataSchema)(raw);
}

export const encodeTaskStoreData = Schema.encodeSync(TaskStoreJsonSchema);

export const TasksConfigSchema = Schema.Struct({
  taskScope: Schema.optional(Schema.Literals(["memory", "session", "project"])),
  autoCascade: Schema.optional(Schema.Boolean),
  autoClearCompleted: Schema.optional(Schema.Literals(["never", "on_list_complete", "on_task_complete"])),
});

const TasksConfigJsonSchema = Schema.fromJsonString(TasksConfigSchema);

export const decodeTasksConfig = Schema.decodeUnknownSync(TasksConfigJsonSchema);
export const encodeTasksConfig = Schema.encodeSync(TasksConfigJsonSchema);

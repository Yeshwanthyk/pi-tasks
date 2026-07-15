import { Schema } from "effect";

export const TaskStatusSchema = Schema.Literals(["pending", "in_progress", "completed"]);

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
  agentType: Schema.optional(Schema.String),
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

export const decodeTaskStoreData = Schema.decodeUnknownSync(TaskStoreJsonSchema);
export const encodeTaskStoreData = Schema.encodeSync(TaskStoreJsonSchema);

export const TasksConfigSchema = Schema.Struct({
  taskScope: Schema.optional(Schema.Literals(["memory", "session", "project"])),
  autoCascade: Schema.optional(Schema.Boolean),
  autoClearCompleted: Schema.optional(Schema.Literals(["never", "on_list_complete", "on_task_complete"])),
});

const TasksConfigJsonSchema = Schema.fromJsonString(TasksConfigSchema);

export const decodeTasksConfig = Schema.decodeUnknownSync(TasksConfigJsonSchema);
export const encodeTasksConfig = Schema.encodeSync(TasksConfigJsonSchema);

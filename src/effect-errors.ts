import { Schema } from "effect";

export class SubagentRpcError extends Schema.TaggedErrorClass<SubagentRpcError>()("SubagentRpcError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

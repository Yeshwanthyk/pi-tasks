import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { SubagentRpcError } from "./effect-errors.js";
import { TASK_HARNESSES, type TaskHarness } from "./types.js";

export const SUBAGENT_CLIENT_ID = "pi-tasks";
export const SUBAGENT_CLIENT_PROTOCOL_VERSION = 1;

export const SUBAGENT_CLIENT_CHANNELS = {
  ping: "subagents:client:ping",
  spawn: "subagents:client:spawn",
  cancel: "subagents:client:cancel",
  list: "subagents:client:list",
  ready: "subagents:client:ready",
  settled: "subagents:client:settled",
} as const;

export const SUBAGENT_HARNESSES = TASK_HARNESSES;
export type SubagentHarness = TaskHarness;

export const REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface SubagentClientSnapshot {
  id: string;
  clientId: string;
  correlationId: string;
  harness: SubagentHarness;
  name: string;
  status: "running" | "done" | "error";
  cwd: string;
}

export interface SubagentClientCancelResult {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  cancelled: boolean;
}

export interface SubagentClientSettledEvent {
  version: number;
  clientId: string;
  correlationId: string;
  agentId: string;
  outcome: "completed" | "failed" | "cancelled";
  result?: string;
  error?: string;
}

export interface SpawnSubagentRequest {
  correlationId: string;
  harness: SubagentHarness;
  name: string;
  prompt: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export type SubagentEventBus = {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
};

export interface SubagentAdapterOptions {
  debug?: (...args: unknown[]) => void;
}

type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

function isCancelResult(value: unknown): value is SubagentClientCancelResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<SubagentClientCancelResult>;
  return typeof result.id === "string" &&
    typeof result.title === "string" &&
    (result.status === "running" || result.status === "done" || result.status === "error") &&
    typeof result.cancelled === "boolean";
}

function isSnapshot(value: unknown): value is SubagentClientSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<SubagentClientSnapshot>;
  return typeof snapshot.id === "string" &&
    snapshot.clientId === SUBAGENT_CLIENT_ID &&
    typeof snapshot.correlationId === "string" &&
    SUBAGENT_HARNESSES.includes(snapshot.harness as SubagentHarness) &&
    typeof snapshot.name === "string" &&
    (snapshot.status === "running" || snapshot.status === "done" || snapshot.status === "error") &&
    typeof snapshot.cwd === "string";
}

export class SubagentAdapter {
  private readonly debug: (...args: unknown[]) => void;
  private available = false;
  private pendingWarning: string | undefined;
  private readonly availableHandlers = new Set<() => void>();
  private readonly cleanups = new Set<() => void>();
  private disposed = false;

  constructor(private events: SubagentEventBus, options: SubagentAdapterOptions = {}) {
    this.debug = options.debug ?? (() => {});
    this.checkVersion();
    this.track(this.events.on(SUBAGENT_CLIENT_CHANNELS.ready, () => this.checkVersion()));
  }

  isAvailable(): boolean {
    return this.available;
  }

  onAvailable(handler: () => void): () => void {
    this.availableHandlers.add(handler);
    if (this.available) queueMicrotask(handler);
    return () => this.availableHandlers.delete(handler);
  }

  takePendingWarning(): string | undefined {
    const warning = this.pendingWarning;
    this.pendingWarning = undefined;
    return warning;
  }

  spawn(request: SpawnSubagentRequest): Effect.Effect<SubagentClientSnapshot, SubagentRpcError> {
    this.debug("spawn:call", { ...request, prompt: undefined });
    return this.rpcCall<SubagentClientSnapshot>(SUBAGENT_CLIENT_CHANNELS.spawn, {
      clientId: SUBAGENT_CLIENT_ID,
      ...request,
    }, 30_000).pipe(
      Effect.flatMap(snapshot => isSnapshot(snapshot)
        ? Effect.succeed(snapshot)
        : Effect.fail(new SubagentRpcError({
          operation: SUBAGENT_CLIENT_CHANNELS.spawn,
          message: "Invalid spawn reply from pi-subagents",
        }))),
      Effect.tap(snapshot => Effect.sync(() => this.debug("spawn:ok", snapshot))),
    );
  }

  cancel(agentId: string): Effect.Effect<SubagentClientCancelResult, SubagentRpcError> {
    return this.rpcCall<unknown>(SUBAGENT_CLIENT_CHANNELS.cancel, {
      clientId: SUBAGENT_CLIENT_ID,
      agentId,
    }, 10_000).pipe(
      Effect.flatMap(result => isCancelResult(result)
        ? Effect.succeed(result)
        : Effect.fail(new SubagentRpcError({
          operation: SUBAGENT_CLIENT_CHANNELS.cancel,
          message: "Invalid cancel reply from pi-subagents",
        }))),
    );
  }

  list(): Effect.Effect<SubagentClientSnapshot[], SubagentRpcError> {
    return Effect.suspend(() => this.rpcCall<unknown>(SUBAGENT_CLIENT_CHANNELS.list, {
      clientId: SUBAGENT_CLIENT_ID,
    }, 10_000)).pipe(
      Effect.flatMap(data => Array.isArray(data) && data.every(isSnapshot)
        ? Effect.succeed(data)
        : Effect.fail(new SubagentRpcError({
          operation: SUBAGENT_CLIENT_CHANNELS.list,
          message: "Invalid list reply from pi-subagents",
        }))),
    );
  }

  subscribeSettled(handler: (data: SubagentClientSettledEvent) => void): () => void {
    return this.track(this.events.on(SUBAGENT_CLIENT_CHANNELS.settled, raw => {
      const event = raw as Partial<SubagentClientSettledEvent>;
      if (event.version !== SUBAGENT_CLIENT_PROTOCOL_VERSION ||
        event.clientId !== SUBAGENT_CLIENT_ID ||
        typeof event.correlationId !== "string" ||
        typeof event.agentId !== "string" ||
        (event.outcome !== "completed" && event.outcome !== "failed" && event.outcome !== "cancelled")) return;
      handler(event as SubagentClientSettledEvent);
    }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of [...this.cleanups]) cleanup();
    this.cleanups.clear();
    this.availableHandlers.clear();
  }

  private track(cleanup: () => void): () => void {
    if (this.disposed) {
      cleanup();
      return () => {};
    }
    let active = true;
    const tracked = () => {
      if (!active) return;
      active = false;
      this.cleanups.delete(tracked);
      cleanup();
    };
    this.cleanups.add(tracked);
    return tracked;
  }

  private rpcCall<T>(channel: string, params: Record<string, unknown>, timeoutMs: number): Effect.Effect<T, SubagentRpcError> {
    const requestId = randomUUID();
    this.debug(`rpc:send ${channel}`, { requestId });
    const request = Effect.callback<T, SubagentRpcError>((resume) => {
      const unsub = this.events.on(`${channel}:reply:${requestId}`, (raw: unknown) => {
        unsub();
        this.debug(`rpc:reply ${channel}`, { requestId, raw });
        const reply = raw as RpcReply<T> | undefined;
        if (reply?.success === true) resume(Effect.succeed(reply.data as T));
        else {
          resume(Effect.fail(new SubagentRpcError({
            operation: channel,
            message: reply?.success === false ? reply.error : `Invalid ${channel} reply`,
          })));
        }
      });
      this.events.emit(channel, { requestId, ...params });
      this.debug(`rpc:emitted ${channel}`, { requestId });
      return Effect.sync(unsub);
    });
    return request.pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => {
          this.debug(`rpc:timeout ${channel}`, { requestId });
          return Effect.fail(new SubagentRpcError({ operation: channel, message: `${channel} timeout` }));
        },
      }),
    );
  }

  private checkVersion(): void {
    if (this.disposed) return;
    const requestId = randomUUID();
    let timer: ReturnType<typeof setTimeout>;
    let unsubscribe = () => {};
    const cleanup = this.track(() => {
      unsubscribe();
      clearTimeout(timer);
    });
    unsubscribe = this.events.on(`${SUBAGENT_CLIENT_CHANNELS.ping}:reply:${requestId}`, (raw: unknown) => {
      cleanup();
      const remoteVersion = (raw as { data?: { version?: number } })?.data?.version;
      if (remoteVersion !== SUBAGENT_CLIENT_PROTOCOL_VERSION) {
        this.available = false;
        this.pendingWarning = remoteVersion === undefined
          ? "pi-subagents does not expose the required client protocol — please update it for task execution support."
          : `pi-subagents client protocol v${remoteVersion} is incompatible with pi-tasks (requires v${SUBAGENT_CLIENT_PROTOCOL_VERSION}).`;
        return;
      }

      const becameAvailable = !this.available;
      this.available = true;
      this.pendingWarning = undefined;
      if (becameAvailable) {
        for (const handler of this.availableHandlers) queueMicrotask(handler);
      }
    });
    timer = setTimeout(cleanup, 5_000);
    timer.unref?.();
    this.events.emit(SUBAGENT_CLIENT_CHANNELS.ping, { requestId, clientId: SUBAGENT_CLIENT_ID });
  }
}

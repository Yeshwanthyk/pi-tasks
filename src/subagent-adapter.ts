import { randomUUID } from "node:crypto";

export type SubagentEvent = "subagents:completed" | "subagents:failed";

export type SubagentEventBus = {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
};

export interface SubagentAdapterOptions {
  protocolVersion?: number;
  debug?: (...args: unknown[]) => void;
}

type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

export class SubagentAdapter {
  private readonly protocolVersion: number;
  private readonly debug: (...args: unknown[]) => void;
  private available = false;
  private pendingWarning: string | undefined;

  constructor(private events: SubagentEventBus, options: SubagentAdapterOptions = {}) {
    this.protocolVersion = options.protocolVersion ?? 2;
    this.debug = options.debug ?? (() => {});
    this.checkVersion();
    this.events.on("subagents:ready", () => this.checkVersion());
  }

  isAvailable(): boolean {
    return this.available;
  }

  takePendingWarning(): string | undefined {
    const warning = this.pendingWarning;
    this.pendingWarning = undefined;
    return warning;
  }

  spawn(type: string, prompt: string, options?: unknown): Promise<string> {
    this.debug("spawn:call", { type, options: { ...(typeof options === "object" && options ? options : {}), prompt: undefined } });
    return this.rpcCall<{ id: string }>("subagents:rpc:spawn", { type, prompt, options }, 30_000)
      .then(d => {
        this.debug("spawn:ok", d);
        return d.id;
      });
  }

  stop(agentId: string): Promise<void> {
    return this.rpcCall<void>("subagents:rpc:stop", { agentId }, 10_000).catch(() => {});
  }

  subscribe(event: SubagentEvent, handler: (data: unknown) => void): () => void {
    return this.events.on(event, handler);
  }

  private rpcCall<T>(channel: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const requestId = randomUUID();
    this.debug(`rpc:send ${channel}`, { requestId });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        this.debug(`rpc:timeout ${channel}`, { requestId });
        reject(new Error(`${channel} timeout`));
      }, timeoutMs);
      const unsub = this.events.on(`${channel}:reply:${requestId}`, (raw: unknown) => {
        unsub();
        clearTimeout(timer);
        this.debug(`rpc:reply ${channel}`, { requestId, raw });
        const reply = raw as RpcReply<T>;
        if (reply.success) resolve(reply.data as T);
        else reject(new Error(reply.error));
      });
      this.events.emit(channel, { requestId, ...params });
      this.debug(`rpc:emitted ${channel}`, { requestId });
    });
  }

  private checkVersion(): void {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      unsub();
    }, 5_000);
    const unsub = this.events.on(`subagents:rpc:ping:reply:${requestId}`, (raw: unknown) => {
      unsub();
      clearTimeout(timer);
      const remoteVersion = (raw as { data?: { version?: number } })?.data?.version;
      if (remoteVersion === undefined) {
        this.available = false;
        this.pendingWarning = "pi-interactive-subagents is outdated — please update for task execution support.";
      } else if (remoteVersion > this.protocolVersion) {
        this.available = false;
        this.pendingWarning =
          `@tintinweb/pi-tasks is outdated (protocol v${this.protocolVersion}, ` +
          `pi-interactive-subagents has v${remoteVersion}) — please update for task execution support.`;
      } else if (remoteVersion < this.protocolVersion) {
        this.available = false;
        this.pendingWarning =
          `pi-interactive-subagents is outdated (protocol v${remoteVersion}, ` +
          `pi-tasks has v${this.protocolVersion}) — please update for task execution support.`;
      } else {
        this.available = true;
      }
    });
    this.events.emit("subagents:rpc:ping", { requestId });
  }
}

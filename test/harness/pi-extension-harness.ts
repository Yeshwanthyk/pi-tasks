import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, vi } from "vitest";
import initExtension from "../../src/index.js";
import type { Task, TaskExecutionState } from "../../src/types.js";
import type { Theme, UICtx } from "../../src/ui/task-widget.js";

export type MockEventBus = {
  on: (channel: string, handler: (data: unknown) => void) => () => void;
  emit: (channel: string, data: unknown) => void;
};

export interface SpawnedSubagent {
  id: string;
  type: string;
  prompt: string;
  options: Record<string, unknown>;
}

export interface HarnessOptions {
  subagents?: "available" | "missing";
  spawnError?: string;
  env?: Record<string, string>;
}

interface UIMockState {
  widgets: Map<string, { content: undefined | ((tui: unknown, theme: Theme) => { render(): string[]; invalidate(): void }); options?: unknown }>;
  statuses: Map<string, string | undefined>;
  notifications: Array<{ message: string; level?: string }>;
}

function createUiMock(): { ctx: UICtx & { notify: ReturnType<typeof vi.fn> }; state: UIMockState } {
  const state: UIMockState = {
    widgets: new Map(),
    statuses: new Map(),
    notifications: [],
  };

  const ctx = {
    setWidget(key: string, content: undefined | ((tui: unknown, theme: Theme) => { render(): string[]; invalidate(): void }), options?: unknown) {
      state.widgets.set(key, { content, options });
    },
    setStatus(key: string, text: string | undefined) {
      state.statuses.set(key, text);
    },
    notify: vi.fn((message: string, level?: string) => {
      state.notifications.push({ message, level });
    }),
  };

  return { ctx, state };
}

function mockTheme(): Theme {
  const identity = (text: string) => text;
  return new Proxy({
    fg: (_color: string, text: string) => text,
    bold: identity,
    strikethrough: (text: string) => `~~${text}~~`,
  }, {
    get(target, prop: keyof Theme) {
      return target[prop] ?? identity;
    },
  }) as Theme;
}

function createMockPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();

  const pi = {
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const h of eventHandlers.get(channel) ?? []) h(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
        eventHandlers.get(channel)!.push(handler);
        return () => {
          const arr = eventHandlers.get(channel);
          if (arr) eventHandlers.set(channel, arr.filter(h => h !== handler));
        };
      },
    },
    sendUserMessage: vi.fn(),
  };

  return { pi, tools, commands, eventHandlers, lifecycleHandlers };
}

function installSubagentsMock(pi: { events: MockEventBus }, opts?: { spawnError?: string }) {
  let idCounter = 0;
  const spawned: SpawnedSubagent[] = [];
  const stopped: string[] = [];

  const unsubPing = pi.events.on("subagents:rpc:ping", (data: unknown) => {
    const { requestId } = data as { requestId: string };
    pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: 2 } });
  });

  const unsubSpawn = pi.events.on("subagents:rpc:spawn", (data: unknown) => {
    const { requestId, type, prompt, options } = data as {
      requestId: string; type: string; prompt: string; options?: Record<string, unknown>;
    };
    if (opts?.spawnError) {
      pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: false, error: opts.spawnError });
      return;
    }
    const id = `agent-${++idCounter}`;
    spawned.push({ id, type, prompt, options: options ?? {} });
    pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: true, data: { id } });
  });

  const unsubStop = pi.events.on("subagents:rpc:stop", (data: unknown) => {
    const { requestId, agentId } = data as { requestId: string; agentId: string };
    stopped.push(agentId);
    pi.events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
  });

  return {
    spawned,
    stopped,
    ready() { pi.events.emit("subagents:ready", {}); },
    dispose() { unsubPing(); unsubSpawn(); unsubStop(); },
  };
}

export class PiTasksHarness {
  readonly tools: Map<string, any>;
  readonly commands: Map<string, any>;
  readonly ui = createUiMock();
  readonly subagents?: ReturnType<typeof installSubagentsMock>;
  private readonly pi: ReturnType<typeof createMockPi>["pi"];
  private readonly lifecycleHandlers: ReturnType<typeof createMockPi>["lifecycleHandlers"];
  private readonly oldEnv: Record<string, string | undefined>;

  private constructor(mock: ReturnType<typeof createMockPi>, options: HarnessOptions) {
    this.pi = mock.pi;
    this.tools = mock.tools;
    this.commands = mock.commands;
    this.lifecycleHandlers = mock.lifecycleHandlers;
    this.oldEnv = { PI_TASKS: process.env.PI_TASKS };
    process.env.PI_TASKS = options.env?.PI_TASKS ?? "off";

    if (options.subagents !== "missing") {
      this.subagents = installSubagentsMock(this.pi, { spawnError: options.spawnError });
    }
    initExtension(this.pi as any);
    this.subagents?.ready();
  }

  static create(options: HarnessOptions = {}): PiTasksHarness {
    return new PiTasksHarness(createMockPi(), { subagents: "available", ...options });
  }

  dispose(): void {
    this.subagents?.dispose();
    if (this.oldEnv.PI_TASKS === undefined) delete process.env.PI_TASKS;
    else process.env.PI_TASKS = this.oldEnv.PI_TASKS;
    rmSync(join(process.cwd(), ".pi", "tasks", "output"), { recursive: true, force: true });
  }

  ctx() {
    return {
      model: { id: "test-model", name: "Test" },
      modelRegistry: {},
      sessionManager: {
        getSessionId: () => "harness-session",
        getEntries: () => [],
      },
      ui: this.ui.ctx,
    };
  }

  async tool<T = any>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool ${name} not registered`);
    return tool.execute("harness-call", params, undefined, undefined, this.ctx());
  }

  async lifecycle(event: string, ...args: unknown[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const h of this.lifecycleHandlers.get(event) ?? []) results.push(await h(...args));
    return results;
  }

  emit(channel: string, data: unknown): void {
    this.pi.events.emit(channel, data);
  }

  async subagentCompleted(agentId: string, result?: string): Promise<void> {
    this.emit("subagents:completed", { id: agentId, result });
    await this.flushEvents();
  }

  async subagentFailed(agentId: string, error: string): Promise<void> {
    this.emit("subagents:failed", { id: agentId, status: "failed", error });
    await this.flushEvents();
  }

  /** The subagents extension reports intentional stops on its failed lifecycle channel. */
  async subagentStopped(agentId: string, result?: string): Promise<void> {
    this.emit("subagents:failed", { id: agentId, status: "stopped", result });
    await this.flushEvents();
  }

  spawned(index = 0): SpawnedSubagent {
    const spawned = this.subagents?.spawned[index];
    if (!spawned) throw new Error(`No spawned subagent at index ${index}`);
    return spawned;
  }

  async task(id: string): Promise<Task> {
    const result = await this.tool("TaskGet", { taskId: id }) as { content: Array<{ text: string }> };
    const text = result.content[0]?.text ?? "";
    const status = text.match(/^Status: (.+)$/m)?.[1] as Task["status"] | undefined;
    const agentType = text.match(/^Agent type: (.+)$/m)?.[1];
    const executionText = text.match(/^Execution: (.+)$/m)?.[1];
    const metadataText = text.match(/^Metadata: (.+)$/m)?.[1];
    return {
      id,
      subject: text.match(new RegExp(`^Task #${id}: (.+)$`, "m"))?.[1] ?? "",
      description: text.match(/^Description: (.+)$/m)?.[1] ?? "",
      status: status ?? "pending",
      agentType,
      execution: executionText ? JSON.parse(executionText) as TaskExecutionState : undefined,
      metadata: metadataText ? JSON.parse(metadataText) as Record<string, unknown> : {},
      blocks: [],
      blockedBy: [],
      createdAt: 0,
      updatedAt: 0,
    };
  }

  async expectTask(id: string, expected: { status?: Task["status"]; agentType?: string; execution?: Partial<TaskExecutionState> }): Promise<void> {
    const task = await this.task(id);
    if (expected.status) expect(task.status).toBe(expected.status);
    if (expected.agentType) expect(task.agentType).toBe(expected.agentType);
    if (expected.execution) expect(task.execution).toMatchObject(expected.execution);
  }

  async flushEvents(): Promise<void> {
    await new Promise(resolve => setImmediate(resolve));
  }

  async expectInvariants(): Promise<void> {
    const list = await this.tool("TaskList", {}) as { content: Array<{ text: string }> };
    const ids = [...(list.content[0]?.text ?? "").matchAll(/^#(\d+) /gm)].map(m => m[1]);
    for (const id of ids) {
      const task = await this.task(id);
      const execution = task.execution;
      if (!execution) continue;
      if (execution.status === "running") expect(task.status).toBe("in_progress");
      if (execution.status === "completed" || execution.status === "stopped" || execution.status === "stopping") expect(task.status).toBe("completed");
      if (execution.status === "failed") expect(task.status).toBe("pending");
      expect(task.metadata).not.toHaveProperty("agentId");
      expect(task.metadata).not.toHaveProperty("agentType");
      expect(task.metadata).not.toHaveProperty("executionId");
    }
  }

  renderWidget(): string[] {
    const entry = this.ui.state.widgets.get("tasks");
    if (!entry?.content) return [];
    const tui = { terminal: { columns: 200 }, requestRender() {} };
    return entry.content(tui, mockTheme()).render();
  }
}

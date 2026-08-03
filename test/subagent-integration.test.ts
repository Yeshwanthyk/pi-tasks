import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SUBAGENT_CLIENT_CHANNELS,
  SUBAGENT_CLIENT_ID,
  SUBAGENT_CLIENT_PROTOCOL_VERSION,
  SubagentAdapter,
  type SubagentEventBus,
} from "../src/subagent-adapter.js";
import { TaskStore } from "../src/task-store.js";
import { PiTasksHarness } from "./harness/pi-extension-harness.js";

const harnesses: PiTasksHarness[] = [];
const files: string[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0).reverse()) harness.dispose();
  for (const file of files.splice(0)) rmSync(file, { force: true });
});

function createHarness(options: Parameters<typeof PiTasksHarness.create>[0] = {}): PiTasksHarness {
  const harness = PiTasksHarness.create(options);
  harnesses.push(harness);
  return harness;
}

function text(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map(item => item.text).join("\n");
}

function settlement(spawned: ReturnType<PiTasksHarness["spawned"]>, fields: {
  outcome: "completed" | "failed" | "cancelled";
  result?: string;
  error?: string;
  agentId?: string;
  correlationId?: string;
  clientId?: string;
  version?: number;
}) {
  return {
    version: fields.version ?? 1,
    clientId: fields.clientId ?? "pi-tasks",
    correlationId: fields.correlationId ?? spawned.correlationId,
    agentId: fields.agentId ?? spawned.id,
    outcome: fields.outcome,
    result: fields.result,
    error: fields.error,
  };
}

describe("pi-subagents version-1 client protocol", () => {
  it("sends the v1 spawn shape with task execution correlation", async () => {
    const h = createHarness();
    await h.tool("TaskCreate", {
      subject: "Explore implementation",
      description: "Inspect the execution path",
      harness: "codex",
    });

    const result = await h.tool("TaskExecute", {
      task_ids: ["1"],
      additional_context: "Focus on persistence.",
      model: "gpt-5-codex",
      reasoning_effort: "high",
    });

    expect(text(result)).toContain("Launched 1 agent");
    expect(h.spawned()).toMatchObject({
      id: "agent-1",
      clientId: "pi-tasks",
      harness: "codex",
      name: "Explore implementation",
      cwd: process.cwd(),
      model: "gpt-5-codex",
      reasoningEffort: "high",
      status: "running",
    });
    expect(h.spawned().correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.spawned().prompt).toContain("Focus on persistence.");
  });

  it("leaves a task pending with a failed execution when spawn is rejected", async () => {
    const h = createHarness({ spawnError: "No active parent session" });
    await h.tool("TaskCreate", { subject: "Cannot start", description: "Do it", harness: "pi" });

    expect(text(await h.tool("TaskExecute", { task_ids: ["1"] }))).toContain("No active parent session");
    await h.expectTask("1", {
      status: "pending",
      execution: { status: "failed", agentId: null, error: "No active parent session" },
    });
  });

  it("maps completed settlements to completed tasks", async () => {
    const h = createHarness();
    await h.tool("TaskCreate", { subject: "Finish", description: "Do it", harness: "pi" });
    await h.tool("TaskExecute", { task_ids: ["1"] });

    await h.subagentCompleted("agent-1", "finished output");

    await h.expectTask("1", {
      status: "completed",
      execution: { status: "completed", agentId: "agent-1", result: "finished output" },
    });
  });

  it("maps failed settlements to pending failed tasks", async () => {
    const h = createHarness();
    await h.tool("TaskCreate", { subject: "Fail", description: "Do it", harness: "claude" });
    await h.tool("TaskExecute", { task_ids: ["1"] });

    await h.subagentFailed("agent-1", "backend crashed", "partial output");

    await h.expectTask("1", {
      status: "pending",
      execution: {
        status: "failed",
        agentId: "agent-1",
        error: "backend crashed",
        result: "partial output",
      },
    });
    expect(text(await h.tool("TaskOutput", {
      task_id: "1",
      block: false,
      timeout: 0,
    }))).toContain("partial output");
  });

  it("maps cancelled settlements to pending stopped tasks and preserves partial output", async () => {
    const h = createHarness();
    await h.tool("TaskCreate", { subject: "Stop", description: "Do it", harness: "pi" });
    await h.tool("TaskExecute", { task_ids: ["1"] });
    await h.tool("TaskStop", { task_id: "1" });

    await h.subagentStopped("agent-1", "partial output");

    await h.expectTask("1", {
      status: "pending",
      execution: { status: "stopped", agentId: "agent-1", result: "partial output" },
    });
    expect(h.subagents?.stopped).toEqual(["agent-1"]);
  });

  it("requires both correlationId and agentId so late retry settlements are ignored", async () => {
    const h = createHarness();
    await h.tool("TaskCreate", { subject: "Retry", description: "Do it", harness: "pi" });
    await h.tool("TaskExecute", { task_ids: ["1"] });
    const first = h.spawned(0);
    await h.subagentFailed(first.id, "retry me");

    await h.tool("TaskExecute", { task_ids: ["1"] });
    const retry = h.spawned(1);
    h.emit(SUBAGENT_CLIENT_CHANNELS.settled, settlement(first, {
      outcome: "completed",
      result: "late result",
    }));
    h.emit(SUBAGENT_CLIENT_CHANNELS.settled, settlement(retry, {
      outcome: "completed",
      agentId: first.id,
      result: "wrong agent",
    }));
    await h.flushEvents();

    await h.expectTask("1", {
      status: "in_progress",
      execution: { status: "running", agentId: retry.id, executionId: retry.correlationId },
    });

    await h.subagentCompleted(retry.id, "current result");
    await h.expectTask("1", { status: "completed", execution: { result: "current result" } });
  });

  it("ignores settlements for another client or protocol version", async () => {
    const h = createHarness();
    await h.tool("TaskCreate", { subject: "Owned", description: "Do it", harness: "pi" });
    await h.tool("TaskExecute", { task_ids: ["1"] });
    const spawned = h.spawned();

    h.emit(SUBAGENT_CLIENT_CHANNELS.settled, settlement(spawned, {
      outcome: "completed",
      clientId: "another-client",
    }));
    h.emit(SUBAGENT_CLIENT_CHANNELS.settled, settlement(spawned, {
      outcome: "completed",
      version: 2,
    }));
    await h.flushEvents();

    await h.expectTask("1", { status: "in_progress", execution: { status: "running" } });
  });

  it("skips blocked tasks without sending a spawn request", async () => {
    const h = createHarness();
    await h.tool("TaskCreate", { subject: "Blocker", description: "First", harness: "pi" });
    await h.tool("TaskCreate", { subject: "Blocked", description: "Second", harness: "pi" });
    await h.tool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    expect(text(await h.tool("TaskExecute", { task_ids: ["2"] }))).toContain("blocked by #1");
    expect(h.subagents?.spawned).toHaveLength(0);
  });

  it("routes cancellation by the current agent ID", async () => {
    const h = createHarness();
    await h.tool("TaskCreate", { subject: "Cancel", description: "Do it", harness: "pi" });
    await h.tool("TaskExecute", { task_ids: ["1"] });

    expect(text(await h.tool("TaskStop", { task_id: "agent-1" }))).toContain("stopped successfully");
    await h.expectTask("1", { status: "pending", execution: { status: "stopped", agentId: "agent-1" } });
  });

  it("reconciles a persisted running execution from the v1 list channel", async () => {
    const sessionId = `reconcile-${Date.now()}`;
    const file = join(process.cwd(), ".pi", "tasks", `tasks-${sessionId}.json`);
    files.push(file, file + ".lock", file + ".tmp", file + ".highwatermark");
    const store = new TaskStore(file);
    store.create("Persisted", "Continue it", undefined, undefined, "pi");
    store.update("1", {
      status: "in_progress",
      execution: {
        status: "running",
        executionId: "persisted-execution",
        agentId: null,
        startedAt: 1,
      },
    });

    const h = createHarness({ useDefaultSessionStore: true, sessionId });
    h.subagents?.spawned.push({
      id: "agent-restored",
      clientId: "pi-tasks",
      correlationId: "persisted-execution",
      harness: "pi",
      name: "Persisted",
      prompt: "Continue it",
      cwd: process.cwd(),
      status: "running",
    });
    await h.lifecycle("session_start", { reason: "resume" }, h.ctx());
    await h.flushEvents();

    await h.expectTask("1", {
      status: "in_progress",
      execution: { status: "running", executionId: "persisted-execution", agentId: "agent-restored" },
    });
  });

  it("returns missing session-scoped executions to pending after reload", async () => {
    const sessionId = `reconcile-missing-${Date.now()}`;
    const file = join(process.cwd(), ".pi", "tasks", `tasks-${sessionId}.json`);
    files.push(file, file + ".lock", file + ".tmp", file + ".highwatermark");
    const store = new TaskStore(file);
    store.create("Interrupted", "Retry it", undefined, undefined, "pi");
    store.update("1", {
      status: "in_progress",
      execution: {
        status: "running",
        executionId: "missing-execution",
        agentId: "missing-agent",
        startedAt: 1,
      },
    });

    const h = createHarness({ useDefaultSessionStore: true, sessionId });
    await h.lifecycle("session_start", { reason: "resume" }, h.ctx());
    await h.flushEvents();

    await h.expectTask("1", {
      status: "pending",
      execution: { status: "failed", executionId: "missing-execution", agentId: "missing-agent" },
    });
    expect(text(await h.tool("TaskGet", { taskId: "1" }))).toContain(
      "Subagent is no longer running after session reload",
    );
  });
});

describe("task harness API and standalone behavior", () => {
  it("exposes harness enums, allows TaskUpdate to clear them, and removes legacy execute fields", async () => {
    const h = createHarness();
    const createSchema = JSON.stringify(h.tools.get("TaskCreate")?.parameters);
    const updateSchema = JSON.stringify(h.tools.get("TaskUpdate")?.parameters);
    const executeSchema = JSON.stringify(h.tools.get("TaskExecute")?.parameters);

    expect(createSchema).toContain('"harness"');
    expect(createSchema).not.toContain("agentType");
    expect(updateSchema).toContain('"harness"');
    expect(executeSchema).toContain("reasoning_effort");
    expect(executeSchema).not.toContain("max_turns");

    await h.tool("TaskCreate", { subject: "Configurable", description: "Desc", harness: "claude" });
    expect(text(await h.tool("TaskGet", { taskId: "1" }))).toContain("Harness: claude");
    await h.tool("TaskUpdate", { taskId: "1", harness: null });
    expect(text(await h.tool("TaskGet", { taskId: "1" }))).not.toContain("Harness:");
  });

  it("keeps all core tools usable without pi-subagents", async () => {
    const h = createHarness({ subagents: "missing" });
    await h.tool("TaskCreate", { subject: "Standalone", description: "Desc", harness: "pi" });
    await h.tool("TaskUpdate", { taskId: "1", owner: "local" });

    expect(text(await h.tool("TaskList"))).toContain("Standalone");
    expect(text(await h.tool("TaskGet", { taskId: "1" }))).toContain("Owner: local");
    expect(text(await h.tool("TaskExecute", { task_ids: ["1"] }))).toContain("currently unavailable");
    await h.expectTask("1", { status: "pending", harness: "pi" });
  });

  it("returns a per-task skip when no harness is configured", async () => {
    const h = createHarness();
    await h.tool("TaskCreate", { subject: "Manual", description: "Desc" });

    expect(text(await h.tool("TaskExecute", { task_ids: ["1"] }))).toContain("no harness set");
  });
});

describe("SubagentAdapter presence handshake", () => {
  function eventBus() {
    const handlers = new Map<string, Array<(data: unknown) => void>>();
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const events: SubagentEventBus = {
      on(channel, handler) {
        const entries = handlers.get(channel) ?? [];
        entries.push(handler);
        handlers.set(channel, entries);
        return () => handlers.set(channel, (handlers.get(channel) ?? []).filter(entry => entry !== handler));
      },
      emit(channel, data) {
        emitted.push({ channel, data });
        for (const handler of handlers.get(channel) ?? []) handler(data);
      },
    };
    return { events, emitted };
  }

  it("uses the scoped v1 ping/reply channel", () => {
    const { events, emitted } = eventBus();
    const adapter = new SubagentAdapter(events);
    const ping = emitted.find(event => event.channel === SUBAGENT_CLIENT_CHANNELS.ping);

    expect(ping?.data).toMatchObject({ clientId: SUBAGENT_CLIENT_ID });
    expect(emitted.some(event => event.channel.startsWith("subagents:rpc:"))).toBe(false);
    const requestId = (ping?.data as { requestId: string }).requestId;
    events.emit(`${SUBAGENT_CLIENT_CHANNELS.ping}:reply:${requestId}`, {
      success: true,
      data: { version: SUBAGENT_CLIENT_PROTOCOL_VERSION },
    });

    expect(adapter.isAvailable()).toBe(true);
  });

  it("removes ready and reply listeners when disposed", () => {
    const { events, emitted } = eventBus();
    const adapter = new SubagentAdapter(events);
    const before = emitted.filter(event => event.channel === SUBAGENT_CLIENT_CHANNELS.ping).length;

    adapter.dispose();
    events.emit(SUBAGENT_CLIENT_CHANNELS.ready, { version: 1 });

    expect(emitted.filter(event => event.channel === SUBAGENT_CLIENT_CHANNELS.ping)).toHaveLength(before);
  });

  it("reports incompatible client protocol versions without affecting standalone tools", () => {
    const { events, emitted } = eventBus();
    const adapter = new SubagentAdapter(events);
    const ping = emitted.find(event => event.channel === SUBAGENT_CLIENT_CHANNELS.ping);
    const requestId = (ping?.data as { requestId: string }).requestId;

    events.emit(`${SUBAGENT_CLIENT_CHANNELS.ping}:reply:${requestId}`, {
      success: true,
      data: { version: 2 },
    });

    expect(adapter.isAvailable()).toBe(false);
    expect(adapter.takePendingWarning()).toContain("pi-subagents client protocol v2 is incompatible");
    expect(adapter.takePendingWarning()).toBeUndefined();
  });
});

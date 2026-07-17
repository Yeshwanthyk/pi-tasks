import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStore } from "../src/task-store.js";
import { PiTasksHarness } from "./harness/pi-extension-harness.js";

const harnesses: PiTasksHarness[] = [];
const pathsToRemove: string[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0).reverse()) harness.dispose();
  for (const path of pathsToRemove.splice(0)) rmSync(path, { force: true });
});

function createHarness(options: Parameters<typeof PiTasksHarness.create>[0] = {}): PiTasksHarness {
  const harness = PiTasksHarness.create(options);
  harnesses.push(harness);
  return harness;
}

function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> } | undefined)?.content ?? [];
  return content.map(item => item.text ?? "").join("\n");
}

async function fireToolResult(harness: PiTasksHarness, toolName: string): Promise<string> {
  const [result] = await harness.lifecycle("tool_result", {
    toolName,
    content: [{ type: "text", text: "original" }],
  });
  return resultText(result);
}

describe("stale-task reminder cadence", () => {
  it("counts submitted requests rather than Pi turn/tool loops and resets after injection", async () => {
    const h = createHarness();
    await h.lifecycle("before_agent_start", {}, h.ctx()); // request 1
    await h.toolCall("TaskCreate");
    await h.tool("TaskCreate", { subject: "Actionable", description: "Desc" });
    await fireToolResult(h, "TaskCreate");

    for (let request = 2; request <= 4; request++) {
      await h.lifecycle("before_agent_start", {}, h.ctx());
      for (let loop = 0; loop < 6; loop++) await h.lifecycle("turn_start", {}, h.ctx());
      expect(await fireToolResult(h, "read")).not.toContain("<system-reminder>");
    }

    await h.lifecycle("before_agent_start", {}, h.ctx()); // request 5
    expect(await fireToolResult(h, "read")).toContain("<system-reminder>");
    expect(await fireToolResult(h, "bash")).not.toContain("<system-reminder>");

    for (let request = 6; request <= 8; request++) {
      await h.lifecycle("before_agent_start", {}, h.ctx());
      expect(await fireToolResult(h, "read")).not.toContain("<system-reminder>");
    }
    await h.lifecycle("before_agent_start", {}, h.ctx()); // request 9
    expect(await fireToolResult(h, "read")).toContain("<system-reminder>");
  });

  it("resets cadence on task-tool use", async () => {
    const h = createHarness();
    await h.tool("TaskCreate", { subject: "Actionable", description: "Desc" });
    for (let request = 1; request <= 4; request++) await h.lifecycle("before_agent_start", {}, h.ctx());

    await h.toolCall("TaskList");
    await fireToolResult(h, "TaskList");
    expect(await fireToolResult(h, "read")).not.toContain("<system-reminder>");
    for (let request = 5; request <= 7; request++) {
      await h.lifecycle("before_agent_start", {}, h.ctx());
      expect(await fireToolResult(h, "read")).not.toContain("<system-reminder>");
    }
    await h.lifecycle("before_agent_start", {}, h.ctx());
    expect(await fireToolResult(h, "read")).toContain("<system-reminder>");
  });

  it("suppresses a faster sibling result when a task tool was preflighted", async () => {
    const h = createHarness();
    await h.tool("TaskCreate", { subject: "Actionable", description: "Desc" });
    for (let request = 1; request <= 4; request++) await h.lifecycle("before_agent_start", {}, h.ctx());

    // Pi preflights in source order, then sibling tools complete in arbitrary order.
    await h.toolCall("TaskList", "task-call");
    await h.toolCall("read", "read-call");
    expect(await fireToolResult(h, "read")).not.toContain("<system-reminder>");
    await fireToolResult(h, "TaskList");
  });

  it("requires pending or in-progress tasks", async () => {
    const empty = createHarness();
    for (let request = 1; request <= 4; request++) await empty.lifecycle("before_agent_start", {}, empty.ctx());
    expect(await fireToolResult(empty, "read")).not.toContain("<system-reminder>");

    const completed = createHarness();
    await completed.tool("TaskCreate", { subject: "Done", description: "Desc" });
    await completed.tool("TaskUpdate", { taskId: "1", status: "completed" });
    for (let request = 1; request <= 4; request++) await completed.lifecycle("before_agent_start", {}, completed.ctx());
    expect(await fireToolResult(completed, "read")).not.toContain("<system-reminder>");
  });
});

describe("real file-backed session lifecycle", () => {
  function sessionPaths(sessionId: string) {
    const file = join(process.cwd(), ".pi", "tasks", `tasks-${sessionId}.json`);
    pathsToRemove.push(file, file + ".lock", file + ".tmp", file + ".highwatermark");
    return { file, highWaterMark: file + ".highwatermark" };
  }

  it("removes the default session file after automatic and last-task cleanup while preserving IDs", async () => {
    const sessionId = `stale-lifecycle-${Date.now()}`;
    const { file, highWaterMark } = sessionPaths(sessionId);
    const h = createHarness({ useDefaultSessionStore: true, sessionId });
    await h.lifecycle("before_agent_start", {}, h.ctx());

    await h.tool("TaskCreate", { subject: "Done", description: "Desc" });
    await h.tool("TaskUpdate", { taskId: "1", status: "completed" });
    for (let turn = 1; turn <= 4; turn++) await h.lifecycle("turn_start", {}, h.ctx());

    expect(existsSync(file)).toBe(false);
    expect(readFileSync(highWaterMark, "utf-8")).toBe("1");

    const created = await h.tool("TaskCreate", { subject: "Delete me", description: "Desc" }) as { content: Array<{ text: string }> };
    expect(created.content[0].text).toContain("Task #2");
    await h.tool("TaskUpdate", { taskId: "2", status: "deleted" });
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(highWaterMark, "utf-8")).toBe("2");
  });

  it.each(["startup", "reload", "resume"])(
    "rehydrates completed tasks on %s with no message entries",
    async reason => {
      const resumeId = `stale-${reason}-${Date.now()}`;
      const resumePaths = sessionPaths(resumeId);
      const resumeStore = new TaskStore(resumePaths.file);
      resumeStore.create("Persisted done", "Desc");
      resumeStore.update("1", { status: "completed" });

      const resumed = createHarness({
        useDefaultSessionStore: true,
        sessionId: resumeId,
        sessionEntries: [],
      });
      await resumed.lifecycle("session_start", { reason }, resumed.ctx());
      for (let turn = 1; turn <= 3; turn++) await resumed.lifecycle("turn_start", {}, resumed.ctx());
      expect(existsSync(resumePaths.file)).toBe(true);
      await resumed.lifecycle("turn_start", {}, resumed.ctx());
      expect(existsSync(resumePaths.file)).toBe(false);
    },
  );

  it("clears completed-only state only on an explicit new-session signal", async () => {
    const newId = `stale-new-${Date.now()}`;
    const newPaths = sessionPaths(newId);
    mkdirSync(join(process.cwd(), ".pi", "tasks"), { recursive: true });
    const newStore = new TaskStore(newPaths.file);
    newStore.create("Old completed", "Desc");
    newStore.update("1", { status: "completed" });

    const fresh = createHarness({ useDefaultSessionStore: true, sessionId: newId, sessionEntries: [] });
    await fresh.lifecycle("session_start", { reason: "new" }, fresh.ctx());
    expect(existsSync(newPaths.file)).toBe(false);
  });

  it("rehydrates both automatic mode transitions through /tasks settings", async () => {
    const configPath = join(process.cwd(), ".pi", "tasks-config.json");
    pathsToRemove.push(configPath);
    mkdirSync(join(process.cwd(), ".pi"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ taskScope: "memory", autoClearCompleted: "on_task_complete" }));

    const h = createHarness({
      selectResponses: ["Settings", undefined],
      settingsModeChanges: ["on_list_complete", "on_task_complete"],
    });
    await h.tool("TaskCreate", { subject: "Done", description: "Desc" });
    await h.tool("TaskUpdate", { taskId: "1", status: "completed" });
    await h.lifecycle("turn_start", {}, h.ctx());
    await h.lifecycle("turn_start", {}, h.ctx());

    await h.command("tasks");

    for (let turn = 3; turn <= 5; turn++) await h.lifecycle("turn_start", {}, h.ctx());
    expect((await h.tool("TaskGet", { taskId: "1" }) as { content: Array<{ text: string }> }).content[0].text).toContain("Status: completed");
    await h.lifecycle("turn_start", {}, h.ctx());
    expect((await h.tool("TaskGet", { taskId: "1" }) as { content: Array<{ text: string }> }).content[0].text).toContain("not found");
  });

  it("registered TaskUpdate does not restart cleanup for repeated or rejected updates", async () => {
    const h = createHarness();
    await h.tool("TaskCreate", { subject: "Done", description: "Desc" });
    await h.tool("TaskUpdate", { taskId: "1", status: "completed" });
    await h.lifecycle("turn_start", {}, h.ctx());
    await h.lifecycle("turn_start", {}, h.ctx());
    await h.tool("TaskUpdate", { taskId: "1", status: "completed" });
    await h.lifecycle("turn_start", {}, h.ctx());
    await h.lifecycle("turn_start", {}, h.ctx());
    expect((await h.tool("TaskGet", { taskId: "1" }) as { content: Array<{ text: string }> }).content[0].text).toContain("not found");

    await h.tool("TaskCreate", { subject: "Rejected", description: "Desc" });
    await h.tool("TaskUpdate", { taskId: "2", status: "completed", addBlockedBy: ["missing"] });
    for (let turn = 0; turn < 5; turn++) await h.lifecycle("turn_start", {}, h.ctx());
    expect((await h.tool("TaskGet", { taskId: "2" }) as { content: Array<{ text: string }> }).content[0].text).toContain("Status: pending");
  });

  it("preserves in-progress tasks across restoration, request cycles, and agent boundaries", async () => {
    const sessionId = `stale-in-progress-${Date.now()}`;
    const paths = sessionPaths(sessionId);
    const store = new TaskStore(paths.file);
    store.create("Still working", "Desc");
    store.update("1", { status: "in_progress" });

    const h = createHarness({
      useDefaultSessionStore: true,
      sessionId,
      sessionEntries: [{ type: "message" }],
    });
    await h.lifecycle("session_start", { reason: "startup" }, h.ctx());
    for (let cycle = 0; cycle < 8; cycle++) {
      await h.lifecycle("before_agent_start", { prompt: `topic ${cycle}` }, h.ctx());
      await h.lifecycle("turn_start", {}, h.ctx());
      await h.lifecycle("agent_end", {}, h.ctx());
    }

    const task = await h.tool("TaskGet", { taskId: "1" }) as { content: Array<{ text: string }> };
    expect(task.content[0].text).toContain("Status: in_progress");
    expect(existsSync(paths.file)).toBe(true);
  });

  it("does not treat an explicit PI_TASKS store as the default session store", async () => {
    const file = join(tmpdir(), `pi-tasks-explicit-${Date.now()}.json`);
    pathsToRemove.push(file, file + ".lock", file + ".tmp", file + ".highwatermark");
    const h = createHarness({ env: { PI_TASKS: file } });
    await h.lifecycle("before_agent_start", {}, h.ctx());

    await h.tool("TaskCreate", { subject: "Explicit", description: "Desc" });
    await h.tool("TaskUpdate", { taskId: "1", status: "deleted" });

    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf-8")).tasks).toEqual([]);
  });
});

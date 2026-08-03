import { describe, expect, it, vi } from "vitest";
import { TaskLifecycle } from "../src/task-lifecycle.js";
import { TaskStore } from "../src/task-store.js";

function setup() {
  const store = new TaskStore();
  const deps = {
    getStore: () => store,
    currentTurn: () => 7,
    onTaskActivated: vi.fn(),
    onTasksChanged: vi.fn(),
    onTaskCompleted: vi.fn(),
    onBatchCountdownReset: vi.fn(),
  };
  return { store, deps, lifecycle: new TaskLifecycle(deps) };
}

describe("TaskLifecycle status side effects", () => {
  it("runs completion side effects only for a real status transition", () => {
    const { store, deps, lifecycle } = setup();
    store.create("Task", "Desc");

    expect(lifecycle.update("1", { status: "completed" }).changedFields).toContain("status");
    expect(deps.onTaskCompleted).toHaveBeenCalledOnce();
    expect(deps.onTaskCompleted).toHaveBeenCalledWith("1", 7);

    expect(lifecycle.update("1", { status: "completed" }).changedFields).not.toContain("status");
    expect(deps.onTaskCompleted).toHaveBeenCalledOnce();
    expect(deps.onTasksChanged).toHaveBeenCalledOnce();
  });

  it("does not run status side effects for a rejected update", () => {
    const { store, deps, lifecycle } = setup();
    store.create("Task", "Desc");

    const result = lifecycle.update("1", { status: "completed", addBlockedBy: ["missing"] });

    expect(result.warnings).toContain("#missing does not exist");
    expect(store.get("1")?.status).toBe("pending");
    expect(deps.onTaskCompleted).not.toHaveBeenCalled();
    expect(deps.onTaskActivated).not.toHaveBeenCalled();
    expect(deps.onTasksChanged).not.toHaveBeenCalled();
  });

  it("requires active subagents to stop before status or harness changes", () => {
    const { store, deps, lifecycle } = setup();
    store.create("Task", "Desc", undefined, undefined, "pi");
    store.update("1", {
      status: "in_progress",
      execution: {
        status: "running",
        executionId: "execution-1",
        agentId: "agent-1",
        startedAt: 1,
      },
    });

    const result = lifecycle.update("1", {
      status: "completed",
      harness: "codex",
    });

    expect(result.warnings).toEqual([
      "stop the active subagent before changing task status",
      "stop the active subagent before changing its harness",
    ]);
    expect(store.get("1")).toMatchObject({
      status: "in_progress",
      harness: "pi",
      execution: { status: "running" },
    });
    expect(deps.onTasksChanged).not.toHaveBeenCalled();
  });

  it("runs deletion side effects only when a task was deleted", () => {
    const { store, deps, lifecycle } = setup();
    store.create("Task", "Desc");

    expect(lifecycle.update("1", { status: "deleted" }).changedFields).toEqual(["deleted"]);
    expect(deps.onTaskActivated).toHaveBeenCalledWith("1", false);

    lifecycle.update("1", { status: "deleted" });
    expect(deps.onTaskActivated).toHaveBeenCalledOnce();
  });
});

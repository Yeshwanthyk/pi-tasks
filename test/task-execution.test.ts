import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { TaskExecution } from "../src/task-execution.js";
import { TaskStore } from "../src/task-store.js";

describe("TaskExecution workspace safety", () => {
  it("refuses to execute a task from another project", async () => {
    const store = new TaskStore();
    store.create(
      "Run elsewhere",
      "Must run in its origin workspace",
      undefined,
      undefined,
      "general-purpose",
      { name: "other", root: "/code/other" },
    );
    const spawnSubagent = vi.fn(() => Effect.succeed("agent-1"));
    const execution = new TaskExecution({
      getStore: () => store,
      currentWorkspaceRoot: () => "/code/current",
      spawnSubagent,
      stopSubagent: () => Effect.void,
      writeOutput: () => undefined,
      notify: () => {},
      taskNotification: () => "",
      onTaskActivated: () => {},
      onTasksChanged: () => {},
      onTaskCompleted: () => {},
      onCascadeBlocked: () => {},
      isAutoCascadeEnabled: () => false,
      getCascadeConfig: () => undefined,
      subscribeSubagentEvent: () => () => {},
    });

    const result = await Effect.runPromise(execution.executeTasks(["1"]));

    expect(result.launched).toEqual([]);
    expect(result.skipped).toEqual([{ taskId: "1", reason: "belongs to workspace /code/other" }]);
    expect(spawnSubagent).not.toHaveBeenCalled();
    expect(store.get("1")?.status).toBe("pending");
  });
});

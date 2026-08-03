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
      "pi",
      { name: "other", root: "/code/other" },
    );
    const spawnSubagent = vi.fn(() => Effect.succeed({
      id: "agent-1",
      clientId: "pi-tasks",
      correlationId: "execution-1",
      harness: "pi" as const,
      name: "Run elsewhere",
      status: "running" as const,
      cwd: "/code/other",
    }));
    const execution = new TaskExecution({
      getStore: () => store,
      currentWorkspaceRoot: () => "/code/current",
      spawnSubagent,
      cancelSubagent: () => Effect.succeed({
        id: "agent-1",
        title: "Run elsewhere",
        status: "error" as const,
        cancelled: true,
      }),
      listSubagents: Effect.succeed([]),
      writeOutput: () => undefined,
      notify: () => {},
      taskNotification: () => "",
      onTaskActivated: () => {},
      onTasksChanged: () => {},
      onTaskCompleted: () => {},
      onCascadeBlocked: () => {},
      isAutoCascadeEnabled: () => false,
      getCascadeConfig: () => undefined,
      subscribeSettled: () => () => {},
    });

    const result = await Effect.runPromise(execution.executeTasks(["1"]));

    expect(result.launched).toEqual([]);
    expect(result.skipped).toEqual([{ taskId: "1", reason: "belongs to workspace /code/other" }]);
    expect(spawnSubagent).not.toHaveBeenCalled();
    expect(store.get("1")?.status).toBe("pending");
  });
});

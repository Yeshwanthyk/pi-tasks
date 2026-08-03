import { describe, expect, it } from "vitest";
import {
  decodeTaskStoreData,
  decodeTasksConfig,
  encodeTaskStoreData,
  encodeTasksConfig,
} from "../src/task-schemas.js";
import type { TaskStoreData } from "../src/types.js";

describe("Effect persistence schemas", () => {
  it("round-trips task data with absent optional fields", () => {
    const data: TaskStoreData = {
      nextId: 2,
      highWaterMark: 1,
      tasks: [
        {
          id: "1",
          subject: "Verify migration",
          description: "Run the full suite",
          status: "pending",
          activeForm: undefined,
          owner: undefined,
          harness: undefined,
          execution: undefined,
          project: { name: "pi-tasks", root: "/code/pi-tasks" },
          sessionId: undefined,
          metadata: {},
          blocks: [],
          blockedBy: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };

    expect(decodeTaskStoreData(encodeTaskStoreData(data))).toEqual(data);
  });

  it("migrates persisted agentType configuration to the pi harness", () => {
    const migrated = decodeTaskStoreData(JSON.stringify({
      nextId: 2,
      tasks: [{
        id: "1",
        subject: "Legacy task",
        description: "Run it",
        status: "pending",
        agentType: "general-purpose",
        metadata: { agentType: "general-purpose" },
        blocks: [],
        blockedBy: [],
        createdAt: 1,
        updatedAt: 1,
      }],
    }));

    expect(migrated.tasks[0].harness).toBe("pi");
    expect(migrated.tasks[0]).not.toHaveProperty("agentType");
    expect(migrated.tasks[0].metadata).not.toHaveProperty("agentType");
  });

  it("rejects malformed task stores", () => {
    expect(() => decodeTaskStoreData('{"nextId":2,"tasks":[{"id":1}]}')).toThrow();
  });

  it("round-trips settings and rejects unknown enum values", () => {
    const config = { taskScope: "project" as const, autoCascade: true, autoClearCompleted: "on_task_complete" as const };

    expect(decodeTasksConfig(encodeTasksConfig(config))).toEqual(config);
    expect(() => decodeTasksConfig('{"taskScope":"global"}')).toThrow();
  });
});

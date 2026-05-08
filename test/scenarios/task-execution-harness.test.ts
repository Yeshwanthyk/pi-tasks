import { afterEach, describe, expect, it } from "vitest";
import { PiTasksHarness } from "../harness/pi-extension-harness.js";

let h: PiTasksHarness | undefined;

afterEach(() => {
  h?.dispose();
  h = undefined;
});

describe("PiTasksHarness scenarios", () => {
  it("executes a subagent task through real extension tools and lifecycle events", async () => {
    h = PiTasksHarness.create();

    await h.tool("TaskCreate", {
      subject: "Review auth flow",
      description: "Find risks",
      agentType: "Explore",
    });

    const execute = await h.tool("TaskExecute", { task_ids: ["1"] }) as { content: Array<{ text: string }> };
    expect(execute.content[0].text).toContain("#1 → agent agent-1");
    expect(h.spawned()).toMatchObject({ type: "Explore" });
    expect(h.spawned().prompt).toContain("Review auth flow");

    await h.expectTask("1", {
      status: "in_progress",
      agentType: "Explore",
      execution: { status: "running", agentId: "agent-1" },
    });

    await h.subagentCompleted("agent-1", "looks good");

    await h.expectTask("1", {
      status: "completed",
      execution: { status: "completed", agentId: "agent-1", result: "looks good" },
    });
    await h.expectInvariants();
  });

  it("records failed execution and leaves the task retryable", async () => {
    h = PiTasksHarness.create();

    await h.tool("TaskCreate", {
      subject: "Try risky work",
      description: "May fail",
      agentType: "general-purpose",
    });
    await h.tool("TaskExecute", { task_ids: ["1"] });
    await h.subagentFailed("agent-1", "boom");

    await h.expectTask("1", {
      status: "pending",
      execution: { status: "failed", agentId: "agent-1", error: "boom" },
    });
    await h.expectInvariants();
  });

  it("injects prerequisite results when executing an unblocked dependent task", async () => {
    h = PiTasksHarness.create();

    await h.tool("TaskCreate", { subject: "A", description: "Produce", agentType: "general-purpose" });
    await h.tool("TaskCreate", { subject: "B", description: "Consume", agentType: "general-purpose" });
    await h.tool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await h.tool("TaskExecute", { task_ids: ["1"] });
    await h.subagentCompleted("agent-1", "The answer is 42");
    await h.tool("TaskExecute", { task_ids: ["2"] });

    expect(h.spawned(1).prompt).toContain("Prerequisite task results");
    expect(h.spawned(1).prompt).toContain("The answer is 42");
    await h.expectTask("1", { status: "completed", execution: { status: "completed" } });
    await h.expectTask("2", { status: "in_progress", execution: { status: "running" } });
    await h.expectInvariants();
  });

  it("stops a running subagent task through TaskStop", async () => {
    h = PiTasksHarness.create();

    await h.tool("TaskCreate", { subject: "Stop me", description: "Long run", agentType: "general-purpose" });
    await h.tool("TaskExecute", { task_ids: ["1"] });

    const stopped = await h.tool("TaskStop", { task_id: "1" }) as { content: Array<{ text: string }> };
    expect(stopped.content[0].text).toContain("stopped successfully");
    expect(h.subagents?.stopped).toEqual(["agent-1"]);

    await h.expectTask("1", {
      status: "completed",
      execution: { status: "stopping", agentId: "agent-1" },
    });
    await h.expectInvariants();
  });

  it("renders widget state from real tool calls", async () => {
    h = PiTasksHarness.create();

    await h.lifecycle("turn_start", {}, h.ctx());
    await h.tool("TaskCreate", { subject: "Visible", description: "Render me", agentType: "general-purpose" });
    await h.tool("TaskExecute", { task_ids: ["1"] });

    const lines = h.renderWidget();
    expect(lines.join("\n")).toContain("Visible");
    expect(lines.join("\n")).toContain("agent agent");
  });
});

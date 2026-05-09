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

    await h.tool("TaskExecute", { task_ids: ["1"] });
    expect(h.spawned(1)).toMatchObject({ id: "agent-2", type: "general-purpose" });
    await h.expectTask("1", {
      status: "in_progress",
      execution: { status: "running", agentId: "agent-2" },
    });
    await h.expectInvariants();
  });

  it("keeps manual lifecycle updates consistent through the extension harness", async () => {
    h = PiTasksHarness.create();

    await h.tool("TaskCreate", { subject: "Manual task", description: "Track by hand" });
    await h.tool("TaskUpdate", { taskId: "1", status: "in_progress" });
    await h.expectTask("1", { status: "in_progress" });

    await h.tool("TaskUpdate", { taskId: "1", status: "completed" });
    await h.expectTask("1", { status: "completed" });
    await h.expectInvariants();
  });

  it("keeps dangling blocker warnings out of read projections", async () => {
    h = PiTasksHarness.create();

    await h.tool("TaskCreate", { subject: "A", description: "Has a dangling blocker" });
    const update = await h.tool("TaskUpdate", { taskId: "1", addBlockedBy: ["9999"] }) as { content: Array<{ text: string }> };
    expect(update.content[0].text).toContain("#9999 does not exist");

    const list = await h.tool("TaskList", {}) as { content: Array<{ text: string }> };
    expect(list.content[0].text).not.toContain("blocked by #9999");

    const get = await h.tool("TaskGet", { taskId: "1" }) as { content: Array<{ text: string }> };
    expect(get.content[0].text).not.toContain("Blocked by: #9999");

    await h.lifecycle("turn_start", {}, h.ctx());
    expect(h.renderWidget().join("\n")).not.toContain("blocked by #9999");
  });

  it("reports unavailable subagent execution through the adapter-backed tool path", async () => {
    h = PiTasksHarness.create({ subagents: "missing" });

    await h.tool("TaskCreate", {
      subject: "Needs agent",
      description: "Should not start",
      agentType: "general-purpose",
    });

    const execute = await h.tool("TaskExecute", { task_ids: ["1"] }) as { content: Array<{ text: string }> };
    expect(execute.content[0].text).toContain("Subagent execution is currently unavailable");
    await h.expectTask("1", { status: "pending", agentType: "general-purpose" });
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
      execution: { status: "stopped", agentId: "agent-1" },
    });

    await h.subagentStopped("agent-1", "partial");
    await h.expectTask("1", {
      status: "completed",
      execution: { status: "stopped", agentId: "agent-1", result: "partial" },
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
    expect(lines.join("\n")).toContain("Visible (agent agent)…");
  });
});

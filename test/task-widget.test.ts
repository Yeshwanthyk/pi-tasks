import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";
import { TaskWidget, type Theme, type UICtx } from "../src/ui/task-widget.js";

/** Create a mock theme that returns raw text (no ANSI escapes). */
function mockTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    strikethrough: (text: string) => `~~${text}~~`,
  };
}

/** Create a mock UICtx that captures setWidget calls. */
function mockUICtx() {
  const state: {
    widgets: Map<string, any>;
    statuses: Map<string, string | undefined>;
  } = {
    widgets: new Map(),
    statuses: new Map(),
  };

  const ctx: UICtx = {
    setWidget(key, content, options) {
      state.widgets.set(key, { content, options });
    },
    setStatus(key, text) {
      state.statuses.set(key, text);
    },
  };

  return { ctx, state };
}

/** Render the widget and return its lines. */
function renderWidget(state: ReturnType<typeof mockUICtx>["state"], options?: { mode?: "regular" | "fullscreen" }): string[] {
  const entry = state.widgets.get("tasks");
  if (!entry?.content) return [];
  const theme = mockTheme();
  const tui = { terminal: { columns: 200 }, requestRender() {}, mode: options?.mode ?? "regular" };
  const result = entry.content(tui, theme);
  return result.render();
}

/** One of the star spinner glyphs. */
const SPINNER_RE = /[✳✴✵✶✷✸✹✺✻✼✽]/;

describe("TaskWidget", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TaskStore();
    widget = new TaskWidget(store);
    ui = mockUICtx();
    widget.setUICtx(ui.ctx);
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  it("shows nothing when no tasks exist", () => {
    widget.update();
    const entry = ui.state.widgets.get("tasks");
    expect(entry?.content).toBeUndefined();
  });

  it("renders a collapsed summary by default", () => {
    store.create("Do something", "Desc");
    widget.update();

    const lines = renderWidget(ui.state);
    // Collapsed: only the summary line — no task rows.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("1 tasks");
    expect(lines[0]).toContain("1 open");
    expect(lines[0]).not.toContain("Do something");
  });

  it("omits zero status counts from the summary", () => {
    store.create("Task A", "Desc");
    store.create("Task B", "Desc");
    store.update("1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[0]).toContain("2 tasks");
    expect(lines[0]).toContain("1 done");
    expect(lines[0]).not.toContain("0 open");
    expect(lines[0]).not.toContain("0 in progress");
  });

  it("shows the running task line only when something is in progress", () => {
    store.create("Done task", "Desc");
    store.update("1", { status: "completed" });
    widget.update();

    let lines = renderWidget(ui.state);
    expect(lines).toHaveLength(1); // no running line

    store.create("Running task", "Desc");
    store.update("2", { status: "in_progress" });
    widget.update();

    lines = renderWidget(ui.state);
    expect(lines).toHaveLength(2); // summary + running line
    expect(lines[1]).toContain("#2");
    expect(lines[1]).toContain("Running task");
    expect(lines[1]).toContain("◼");
  });

  it("expands and collapses with toggleExpanded", () => {
    store.create("Do something", "Desc");
    widget.update();

    widget.toggleExpanded();
    let lines = renderWidget(ui.state);
    expect(lines).toHaveLength(3); // summary + task row + collapse hint
    expect(lines[1]).toContain("◻");
    expect(lines[1]).toContain("Do something");

    widget.toggleExpanded();
    lines = renderWidget(ui.state);
    expect(lines).toHaveLength(1); // back to summary
  });

  it("always renders collapsed in fullscreen mode", () => {
    store.create("Do something", "Desc");
    widget.update();
    widget.toggleExpanded();

    // Expanded in regular mode…
    expect(renderWidget(ui.state)).toHaveLength(3);
    // …but fullscreen forces the summary.
    const lines = renderWidget(ui.state, { mode: "fullscreen" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("1 open");
  });

  it("keeps the expand toggle inert in fullscreen mode", () => {
    store.create("Do something", "Desc");
    widget.update();

    renderWidget(ui.state, { mode: "fullscreen" });
    widget.toggleExpanded(); // should not flip the flag

    expect(renderWidget(ui.state, { mode: "fullscreen" })).toHaveLength(1);
    // And switching back to regular mode stays collapsed.
    expect(renderWidget(ui.state)).toHaveLength(1);
  });

  it("renders in-progress tasks with ◼ icon", () => {
    store.create("Working on it", "Desc");
    store.update("1", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("◼");
    expect(lines[1]).toContain("Working on it");
  });

  it("renders completed tasks with ✔ icon and strikethrough in expanded mode", () => {
    store.create("Done task", "Desc");
    store.update("1", { status: "completed" });
    widget.update();
    widget.toggleExpanded();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("✔");
    expect(lines[1]).toContain("~~Done task~~");
  });

  it("renders active tasks with spinner icon", () => {
    store.create("Running thing", "Desc", "Processing data");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    // Summary running line shows activeForm with a spinner.
    expect(lines[1]).toContain("Processing data");
    expect(lines[1]).toMatch(SPINNER_RE);
    expect(lines[1]).not.toContain("◼");
  });

  it("clears active runtime state when switching stores", () => {
    store.create("Old active", "Desc", "Old running");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    const nextStore = new TaskStore();
    nextStore.create("New task same id", "Desc", "New running");
    nextStore.update("1", { status: "in_progress" });
    widget.setStore(nextStore);
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("◼");
    expect(lines[1]).toContain("New task same id");
    expect(lines[1]).not.toContain("New running");
    expect(lines[1]).not.toMatch(SPINNER_RE);
  });

  it("renders stale manual active tasks as non-spinning in progress", () => {
    const startedAt = Date.now() - 11 * 60 * 1000;
    store.create("Old manual task", "Desc", "Still running");
    store.update("1", { status: "in_progress", metadata: { startedAt } });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("◼");
    expect(lines[1]).toContain("Old manual task");
    expect(lines[1]).toContain("stale 11m");
    expect(lines[1]).not.toContain("Still running");
    expect(lines[1]).not.toMatch(SPINNER_RE);
  });

  it("keeps agent-backed active tasks spinning even after stale threshold", () => {
    const startedAt = Date.now() - 11 * 60 * 1000;
    store.create("Old agent task", "Desc", "Agent running");
    store.update("1", { status: "in_progress", metadata: { startedAt, agentId: "agent-12345" } });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Agent running");
    expect(lines[1]).toMatch(SPINNER_RE);
    expect(lines[1]).not.toContain("stale");
  });

  it("shows blocked-by info for pending tasks in expanded mode", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");
    store.update("2", { addBlockedBy: ["1"] });
    widget.update();
    widget.toggleExpanded();

    const lines = renderWidget(ui.state);
    const blockedLine = lines.find(l => l.includes("Blocked"));
    expect(blockedLine).toContain("blocked by #1");
  });

  it("hides completed blockers in blocked-by suffix", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");
    store.update("2", { addBlockedBy: ["1"] });
    store.update("1", { status: "completed" });
    widget.update();
    widget.toggleExpanded();

    const lines = renderWidget(ui.state);
    const blockedLine = lines.find(l => l.includes("Blocked"));
    expect(blockedLine).not.toContain("blocked by");
  });

  it("shows status summary in header", () => {
    store.create("Task A", "Desc");
    store.create("Task B", "Desc");
    store.create("Task C", "Desc");
    store.update("1", { status: "completed" });
    store.update("2", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[0]).toContain("3 tasks");
    expect(lines[0]).toContain("1 done");
    expect(lines[0]).toContain("1 in progress");
    expect(lines[0]).toContain("1 open");
  });

  it("clears widget when all tasks are deleted", () => {
    store.create("Task", "Desc");
    widget.update();
    expect(ui.state.widgets.get("tasks")?.content).toBeDefined();

    store.update("1", { status: "deleted" });
    widget.update();
    expect(ui.state.widgets.get("tasks")?.content).toBeUndefined();
  });

  it("limits visible tasks to MAX_VISIBLE_TASKS when expanded", () => {
    for (let i = 0; i < 15; i++) {
      store.create(`Task ${i + 1}`, "Desc");
    }
    widget.update();
    widget.toggleExpanded();

    const lines = renderWidget(ui.state);
    // summary + 10 tasks + "… and 5 more" + collapse hint
    expect(lines).toHaveLength(13);
    expect(lines[11]).toContain("5 more");
  });

  it("prioritizes active and recently completed tasks when truncated", () => {
    widget.update();
    renderWidget(ui.state);

    for (let i = 0; i < 12; i++) {
      store.create(`Old done ${i + 1}`, "Desc");
      store.update(String(i + 1), { status: "completed" });
    }
    widget.update();
    renderWidget(ui.state);

    vi.advanceTimersByTime(31_000);
    store.create("Running priority", "Desc", "Doing priority"); // #13
    store.update("13", { status: "in_progress" });
    widget.setActiveTask("13", true);
    store.create("Recent done", "Desc"); // #14
    store.update("14", { status: "completed" });
    widget.update();
    widget.toggleExpanded();

    const lines = renderWidget(ui.state);
    expect(lines.some(l => l.includes("Doing priority"))).toBe(true);
    expect(lines.some(l => l.includes("Recent done"))).toBe(true);
    expect(lines.some(l => l.includes("Old done 12"))).toBe(false);
  });

  it("tracks token usage for active tasks in expanded mode", () => {
    store.create("Active task", "Desc", "Running");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.toggleExpanded();

    widget.addTokenUsage(1000, 500);
    widget.addTokenUsage(500, 300);

    const lines = renderWidget(ui.state);
    const activeLine = lines.find(l => l.includes("Running"));
    expect(activeLine).toContain("↑ 1.5k");
    expect(activeLine).toContain("↓ 800");
  });

  it("deactivates a task with setActiveTask(id, false)", () => {
    store.create("Task", "Desc", "Doing work");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    // Should be active (spinner)
    let lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Doing work");
    expect(lines[1]).toMatch(SPINNER_RE);

    widget.setActiveTask("1", false);
    lines = renderWidget(ui.state);
    // Should now show as regular in_progress (◼), without activeForm
    expect(lines[1]).toContain("◼");
    expect(lines[1]).not.toContain("Doing work");
  });

  it("prunes stale active IDs on update", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    // Complete the task externally
    store.update("1", { status: "completed" });
    widget.update();
    widget.toggleExpanded();

    // Should render as completed, not active
    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("✔");
    expect(lines[1]).toContain("~~Task~~");
    expect(lines.some(l => l.includes("stale"))).toBe(false);
  });

  it("supports multiple active tasks simultaneously in expanded mode", () => {
    store.create("Task A", "Desc", "Processing A");
    store.create("Task B", "Desc", "Processing B");
    store.update("1", { status: "in_progress" });
    store.update("2", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.setActiveTask("2", true);
    widget.toggleExpanded();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Processing A");
    expect(lines[2]).toContain("Processing B");
  });

  it("distributes token usage across all active tasks", () => {
    store.create("Task A", "Desc", "A");
    store.create("Task B", "Desc", "B");
    store.update("1", { status: "in_progress" });
    store.update("2", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.setActiveTask("2", true);
    widget.toggleExpanded();

    widget.addTokenUsage(100, 50);

    const lines = renderWidget(ui.state);
    // Both tasks should have the same token counts
    expect(lines[1]).toContain("↑ 100");
    expect(lines[2]).toContain("↑ 100");
  });

  it("dispose clears widget and timer", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.dispose();
    expect(ui.state.widgets.get("tasks")?.content).toBeUndefined();
  });

  it("uses subject as fallback when no activeForm", () => {
    store.create("My Subject", "Desc");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("My Subject");
  });

  it("shows elapsed time but no token arrows when tokens are zero", () => {
    store.create("No tokens", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    // No addTokenUsage calls — tokens stay at 0
    vi.advanceTimersByTime(5000);
    widget.update();

    const lines = renderWidget(ui.state);
    const activeLine = lines.find(l => l.includes("Working"));
    expect(activeLine).toContain("5s");
    expect(activeLine).not.toContain("↑");
    expect(activeLine).not.toContain("↓");
  });

  it("cleans up metrics when stale active IDs are pruned", () => {
    store.create("Task", "Desc", "Running");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.addTokenUsage(100, 50);

    // Delete task externally
    store.update("1", { status: "deleted" });
    widget.update();

    // Reactivate with same ID (new task) — should get fresh metrics
    store.create("Task 2", "Desc", "Running");  // ID 2
    store.update("2", { status: "in_progress" });
    widget.setActiveTask("2", true);
    widget.toggleExpanded();

    const lines = renderWidget(ui.state);
    // Should not carry over old tokens
    expect(lines[1]).not.toContain("↑ 100");
  });

  it("indents task lines under header", () => {
    store.create("Indented task", "Desc");
    widget.update();
    widget.toggleExpanded();

    const lines = renderWidget(ui.state);
    // Task line should start with 2 spaces
    expect(lines[1]).toMatch(/^\s{2}/);
  });

  it("widget is placed aboveEditor", () => {
    store.create("Task", "Desc");
    widget.update();

    const entry = ui.state.widgets.get("tasks");
    expect(entry?.options?.placement).toBe("aboveEditor");
  });
});

describe("formatDuration (via widget rendering)", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TaskStore();
    widget = new TaskWidget(store);
    ui = mockUICtx();
    widget.setUICtx(ui.ctx);
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  it("shows seconds for short durations", () => {
    store.create("Quick", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(30_000); // 30s
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("30s");
  });

  it("shows hours for long durations", () => {
    store.create("Long", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(3_723_000); // 1h 2m 3s → "1h 2m"
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("1h 2m");
  });

  it("shows exact hours without minutes", () => {
    store.create("Exact", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(7_200_000); // 2h exactly
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("2h)");
  });

  it("shows minutes and seconds", () => {
    store.create("Medium", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(169_000); // 2m 49s
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("2m 49s");
  });

  it("formats small token counts without k suffix", () => {
    store.create("Small", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.toggleExpanded();

    widget.addTokenUsage(500, 200);
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("↑ 500");
    expect(lines[1]).toContain("↓ 200");
  });

  it("formats token counts with k suffix and removes .0", () => {
    store.create("Large", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.toggleExpanded();

    widget.addTokenUsage(2000, 4100);
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("↑ 2k");    // 2000 → "2k" (not "2.0k")
    expect(lines[1]).toContain("↓ 4.1k");  // 4100 → "4.1k"
  });
});
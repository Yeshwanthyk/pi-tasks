/**
 * task-widget.ts — Persistent widget showing task list with status icons and progress.
 *
 * Display philosophy: take as little vertical space as possible.
 *
 *   Collapsed (default) — a single summary line:
 *     ● 12 tasks · 8 done · 1 in progress · 3 open
 *   …plus one extra line for the currently running task (spinner + duration):
 *     ✳ #4 Fix pipeline crash… (1m 3s)
 *
 *   Expanded (ctrl+alt+t, regular mode only) — the full list with per-task
 *   status icons, durations, tokens, and blocker info:
 *     ✳ #4 Fix pipeline crash… (1m 3s · ↑4.1k ↓850 · agent a1b2c)
 *     ✔ #12 ~~subject~~
 *     ◼ #3 subject (2m 5s)
 *     ◻ #9 subject › blocked by #2
 *
 * In pi ≥0.84 fullscreen (alt-screen) mode the widget lives in a sticky dock
 * that shrinks widgets to keep the transcript visible, so the widget always
 * renders collapsed there.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { executionAgentId, openExistingBlockers } from "../task-projections.js";
import type { TaskStore } from "../task-store.js";

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Star spinner frames for animated active task indicator (matches Claude Code). */
const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];

const MAX_VISIBLE_TASKS = 10;
const MANUAL_TASK_STALE_AFTER_MS = 10 * 60 * 1000;
const RECENT_COMPLETED_TTL_MS = 30 * 1000;

/** Per-task runtime metrics (elapsed time, token usage). */
export interface TaskMetrics {
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
}

/** Format milliseconds as a human-readable duration (e.g., "2m 49s", "1h 3m"). */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** Format token count with k suffix (e.g., "4.1k", "850"). */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

/** A single task row as returned by the store. */
type TaskRow = ReturnType<TaskStore["list"]>[number];

// ---- Widget ----

export class TaskWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** IDs of tasks currently being actively executed (show spinner). */
  private activeTaskIds = new Set<string>();
  /** Per-task runtime metrics keyed by task ID. */
  private metrics = new Map<string, TaskMetrics>();
  /** Completion transition timestamps, used to keep just-finished tasks visible briefly. */
  private completionTimestamps = new Map<string, number>();
  /** Completed task IDs seen on the previous update/render. */
  private previousCompletedIds = new Set<string>();
  /** Avoid treating already-completed persisted tasks as newly completed. */
  private observedCompletionSnapshot = false;
  /** Cached TUI instance for requestRender() calls. */
  private tui: any | undefined;
  /** Whether the widget callback is currently registered. */
  private widgetRegistered = false;
  /** Full-list mode (collapsed by default). Ignored in fullscreen mode. */
  private expanded = false;
  /** Last seen TUI mode, used to keep the collapse toggle inert in fullscreen. */
  private lastMode: "regular" | "fullscreen" | undefined;

  constructor(private store: TaskStore) {}

  setStore(store: TaskStore) {
    this.store = store;
    this.resetRuntimeState();
  }

  /** Clear transient animation/metrics state that must not survive store/session switches. */
  resetRuntimeState() {
    this.activeTaskIds.clear();
    this.metrics.clear();
    this.completionTimestamps.clear();
    this.previousCompletedIds.clear();
    this.observedCompletionSnapshot = false;
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
  }

  setUICtx(ctx: UICtx) {
    this.uiCtx = ctx;
  }

  /** Toggle between the one-line summary and the full list. */
  toggleExpanded() {
    // Fullscreen mode auto-compacts the widget; keep the toggle inert there so
    // the flag doesn't silently flip for the next regular-mode session.
    if (this.lastMode === "fullscreen") return;
    this.expanded = !this.expanded;
    this.update();
  }

  /** Add or remove a task from the active spinner set. */
  setActiveTask(taskId: string | undefined, active = true) {
    if (taskId && active) {
      this.activeTaskIds.add(taskId);
      if (!this.metrics.has(taskId)) {
        this.metrics.set(taskId, { startedAt: Date.now(), inputTokens: 0, outputTokens: 0 });
      }
      this.ensureTimer();
    } else if (taskId) {
      this.activeTaskIds.delete(taskId);
    }
    this.update();
  }

  /** Record token usage for the currently active task(s). */
  addTokenUsage(inputTokens: number, outputTokens: number) {
    // Distribute to all currently active tasks
    for (const id of this.activeTaskIds) {
      const m = this.metrics.get(id);
      if (m) {
        m.inputTokens += inputTokens;
        m.outputTokens += outputTokens;
      }
    }
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 150);
    }
  }

  /** Track task transitions into completed for relevance ordering. */
  private observeCompletionTransitions(tasks: Array<{ id: string; status: string }>) {
    const completedIds = new Set(tasks.filter(t => t.status === "completed").map(t => t.id));
    const now = Date.now();

    if (!this.observedCompletionSnapshot) {
      this.previousCompletedIds = completedIds;
      this.observedCompletionSnapshot = true;
      return;
    }

    for (const id of completedIds) {
      if (!this.previousCompletedIds.has(id) && !this.completionTimestamps.has(id)) {
        this.completionTimestamps.set(id, now);
      }
    }
    for (const id of this.completionTimestamps.keys()) {
      if (!completedIds.has(id)) this.completionTimestamps.delete(id);
    }
    this.previousCompletedIds = completedIds;
  }

  /** Relevance ordering for the constrained widget view. */
  private visibleTasks(tasks: ReturnType<TaskStore["list"]>) {
    if (tasks.length <= MAX_VISIBLE_TASKS) return tasks;

    const now = Date.now();
    const byId = (a: (typeof tasks)[number], b: (typeof tasks)[number]) => Number(a.id) - Number(b.id);
    const isRecentlyCompleted = (id: string) => {
      const ts = this.completionTimestamps.get(id);
      return ts !== undefined && now - ts < RECENT_COMPLETED_TTL_MS;
    };
    const hasOpenBlockers = (task: (typeof tasks)[number]) => openExistingBlockers(task, id => this.store.get(id)).length > 0;

    const recentCompleted = tasks.filter(t => t.status === "completed" && isRecentlyCompleted(t.id)).sort(byId);
    const inProgress = tasks.filter(t => t.status === "in_progress").sort(byId);
    const pendingUnblocked = tasks.filter(t => t.status === "pending" && !hasOpenBlockers(t)).sort(byId);
    const pendingBlocked = tasks.filter(t => t.status === "pending" && hasOpenBlockers(t)).sort(byId);
    const olderCompleted = tasks.filter(t => t.status === "completed" && !isRecentlyCompleted(t.id)).sort(byId);

    return [...recentCompleted, ...inProgress, ...pendingUnblocked, ...pendingBlocked, ...olderCompleted].slice(0, MAX_VISIBLE_TASKS);
  }

  /** Resolve when a task started, preferring live execution state. */
  private startedAtOf(task: TaskRow) {
    const metric = this.metrics.get(task.id);
    const legacyStartedAt = typeof task.metadata?.startedAt === "number" ? task.metadata.startedAt : undefined;
    return task.execution?.status === "running" ? task.execution.startedAt : legacyStartedAt ?? metric?.startedAt;
  }

  /** One-line status summary: "● 12 tasks · 8 done · 1 in progress · 3 open". */
  private summaryLine(theme: Theme, tasks: ReturnType<TaskStore["list"]>): string {
    const completed = tasks.filter(t => t.status === "completed").length;
    const inProgress = tasks.filter(t => t.status === "in_progress").length;
    const pending = tasks.filter(t => t.status === "pending").length;

    const parts: string[] = [];
    if (completed > 0) parts.push(theme.fg("success", `${completed} done`));
    if (inProgress > 0) parts.push(theme.fg("accent", `${inProgress} in progress`));
    if (pending > 0) parts.push(theme.fg("dim", `${pending} open`));
    const statusText = theme.fg("accent", `${tasks.length} tasks`) + " · " + parts.join(" · ");

    return theme.fg("accent", "●") + " " + statusText;
  }

  /** Per-task state needed by both render variants. */
  private taskState(task: TaskRow, now: number) {
    const startedAt = this.startedAtOf(task);
    const agentId = executionAgentId(task);
    const isStaleManual = task.status === "in_progress" && !agentId &&
      typeof startedAt === "number" && now - startedAt >= MANUAL_TASK_STALE_AFTER_MS;
    const isActive = this.activeTaskIds.has(task.id) && task.status === "in_progress" && !isStaleManual;
    const elapsed = typeof startedAt === "number" && task.status === "in_progress"
      ? formatDuration(now - startedAt)
      : undefined;
    return { startedAt, agentId, isStaleManual, isActive, elapsed };
  }

  /** Build the collapsed widget: summary line (+ running task line). */
  private renderSummary(tui: any, theme: Theme, tasks: ReturnType<TaskStore["list"]>): string[] {
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);
    const spinnerChar = SPINNER[this.widgetFrame % SPINNER.length];
    const now = Date.now();

    const lines = [truncate(this.summaryLine(theme, tasks))];

    const running = tasks
      .filter(t => t.status === "in_progress")
      .sort((a, b) => Number(this.activeTaskIds.has(b.id)) - Number(this.activeTaskIds.has(a.id)))
      .find(() => true);

    if (running) {
      const state = this.taskState(running, now);
      const icon = state.isActive ? theme.fg("accent", spinnerChar) : theme.fg("accent", "◼");
      const subject = running.activeForm && state.isActive ? running.activeForm : running.subject;
      let suffix = "";
      if (state.isStaleManual) {
        suffix = ` ${theme.fg("warning", `(stale ${state.elapsed})`)}`;
      } else if (state.elapsed) {
        suffix = ` ${theme.fg("dim", `(${state.elapsed})`)}`;
      }
      lines.push(truncate(`  ${icon} ${theme.fg("dim", "#" + running.id)} ${theme.fg("accent", subject)}${suffix}`));
    }

    return lines;
  }

  /** Build the expanded widget: summary line + full task list. */
  private renderExpanded(tui: any, theme: Theme, tasks: ReturnType<TaskStore["list"]>): string[] {
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);
    const spinnerChar = SPINNER[this.widgetFrame % SPINNER.length];
    const now = Date.now();

    const lines: string[] = [truncate(this.summaryLine(theme, tasks))];

    const visible = this.visibleTasks(tasks);
    for (const task of visible) {
      const state = this.taskState(task, now);

      let icon: string;
      if (state.isActive) {
        icon = theme.fg("accent", spinnerChar);
      } else if (task.status === "completed") {
        icon = theme.fg("success", "✔");
      } else if (task.status === "in_progress") {
        icon = theme.fg("accent", "◼");
      } else {
        icon = "◻";
      }

      // Subject, truncated to the remaining width.
      const subject = task.status === "completed"
        ? theme.fg("dim", theme.strikethrough(task.subject))
        : state.isActive && task.activeForm
          ? theme.fg("accent", task.activeForm)
          : task.subject;

      let text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${subject}`;

      // Meta: duration, tokens, agent — only while the task is live.
      if (task.status === "in_progress") {
        const meta: string[] = [];
        if (state.isActive) {
          const m = this.metrics.get(task.id);
          if (m) {
            if (state.elapsed) meta.push(state.elapsed);
            const tokenParts: string[] = [];
            if (m.inputTokens > 0) tokenParts.push(`↑ ${formatTokens(m.inputTokens)}`);
            if (m.outputTokens > 0) tokenParts.push(`↓ ${formatTokens(m.outputTokens)}`);
            if (tokenParts.length > 0) meta.push(tokenParts.join(" "));
          }
          if (state.agentId) meta.push(`agent ${state.agentId.slice(0, 5)}`);
        }
        if (state.isStaleManual) {
          text += theme.fg("warning", ` (stale ${state.elapsed})`);
        } else if (meta.length > 0) {
          text += ` ${theme.fg("dim", `(${meta.join(" · ")})`)}`;
        }
      }

      // Blocked-by hint for pending tasks.
      if (task.status === "pending" && task.blockedBy.length > 0) {
        const blockers = openExistingBlockers(task, id => this.store.get(id));
        if (blockers.length > 0) {
          text += theme.fg("dim", ` › blocked by ${blockers.map(id => "#" + id).join(", ")}`);
        }
      }

      lines.push(truncate(text));
    }

    if (tasks.length > MAX_VISIBLE_TASKS) {
      lines.push(truncate(theme.fg("dim", `    … and ${tasks.length - MAX_VISIBLE_TASKS} more`)));
    }
    lines.push(truncate(theme.fg("dim", "  ctrl+alt+t collapse")));

    return lines;
  }

  /** Build widget lines from current live state. Called from the render callback. */
  private renderWidget(tui: any, theme: Theme): string[] {
    const tasks = this.store.list();
    this.observeCompletionTransitions(tasks);
    this.lastMode = tui?.mode;

    if (tasks.length === 0) return [];
    // In fullscreen mode the dock shrinks widgets; always render the summary there.
    if (this.lastMode === "fullscreen" || !this.expanded) {
      return this.renderSummary(tui, theme, tasks);
    }
    return this.renderExpanded(tui, theme, tasks);
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const tasks = this.store.list();
    this.observeCompletionTransitions(tasks);

    // Transition: visible → hidden
    if (tasks.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("tasks", undefined);
        this.widgetRegistered = false;
      }
      if (this.widgetInterval) {
        clearInterval(this.widgetInterval);
        this.widgetInterval = undefined;
      }
      return;
    }

    // Prune stale active IDs (deleted or no longer in_progress)
    for (const id of this.activeTaskIds) {
      const t = this.store.get(id);
      if (!t || t.status !== "in_progress") {
        this.activeTaskIds.delete(id);
        this.metrics.delete(id);
      }
    }

    // Check if any task needs animation
    const hasActiveSpinner = tasks.some(t => {
      const state = this.taskState(t, Date.now());
      return state.isActive;
    });
    if (hasActiveSpinner) {
      this.ensureTimer();
    } else if (!hasActiveSpinner && this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }

    this.widgetFrame++;

    // Transition: hidden → visible — register widget callback once
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("tasks", (tui, theme) => {
        this.tui = tui;
        this.lastMode = tui?.mode;
        return { render: () => this.renderWidget(tui, theme), invalidate: () => {} };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else if (this.tui) {
      // Widget already registered — just request a re-render
      this.tui.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("tasks", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
  }
}
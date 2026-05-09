/**
 * task-widget.ts — Persistent widget showing task list with status icons and progress.
 *
 * Display style matches Claude Code's task list:
 *   ✔ completed tasks (strikethrough + dim)
 *   ◼ in_progress tasks
 *   ◻ pending tasks
 *   ✳/✽ actively executing task (star spinner with activeForm text)
 */

import { truncateToWidth } from "@mariozechner/pi-tui";
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

  /** Build widget lines from current live state. Called from the render callback. */
  private renderWidget(tui: any, theme: Theme): string[] {
    const tasks = this.store.list();
    this.observeCompletionTransitions(tasks);
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);

    if (tasks.length === 0) return [];

    const completed = tasks.filter(t => t.status === "completed");
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const pending = tasks.filter(t => t.status === "pending");

    const parts: string[] = [];
    if (completed.length > 0) parts.push(`${completed.length} done`);
    if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`);
    if (pending.length > 0) parts.push(`${pending.length} open`);
    const statusText = `${tasks.length} tasks (${parts.join(", ")})`;

    const spinnerChar = SPINNER[this.widgetFrame % SPINNER.length];
    const lines: string[] = [truncate(theme.fg("accent", "●") + " " + theme.fg("accent", statusText))];

    const visible = this.visibleTasks(tasks);
    for (let i = 0; i < visible.length; i++) {
      const task = visible[i];
      const metric = this.metrics.get(task.id);
      const legacyStartedAt = typeof task.metadata?.startedAt === "number" ? task.metadata.startedAt : undefined;
      const startedAt = task.execution?.status === "running" ? task.execution.startedAt : legacyStartedAt ?? metric?.startedAt;
      const agentId = executionAgentId(task);
      const isStaleManual = task.status === "in_progress" && !agentId &&
        typeof startedAt === "number" && Date.now() - startedAt >= MANUAL_TASK_STALE_AFTER_MS;
      const isActive = this.activeTaskIds.has(task.id) && task.status === "in_progress" && !isStaleManual;

      let icon: string;
      if (isActive) {
        icon = theme.fg("accent", spinnerChar);
      } else if (task.status === "completed") {
        icon = theme.fg("success", "✔");
      } else if (task.status === "in_progress") {
        icon = theme.fg("accent", "◼");
      } else {
        icon = "◻";
      }

      let suffix = "";
      if (task.status === "pending" && task.blockedBy.length > 0) {
        const blockers = openExistingBlockers(task, id => this.store.get(id));
        if (blockers.length > 0) {
          suffix = theme.fg("dim", ` › blocked by ${blockers.map(id => "#" + id).join(", ")}`);
        }
      }

      let text: string;
      if (isActive) {
        const form = task.activeForm || task.subject;
        const agentId = executionAgentId(task);
        const agentLabel = agentId ? ` (agent ${agentId.slice(0, 5)})` : "";
        const m = metric;
        let stats = "";
        if (m) {
          const elapsed = formatDuration(Date.now() - m.startedAt);
          const tokenParts: string[] = [];
          if (m.inputTokens > 0) tokenParts.push(`↑ ${formatTokens(m.inputTokens)}`);
          if (m.outputTokens > 0) tokenParts.push(`↓ ${formatTokens(m.outputTokens)}`);
          stats = tokenParts.length > 0
            ? ` ${theme.fg("dim", `(${elapsed} · ${tokenParts.join(" ")})`)}`
            : ` ${theme.fg("dim", `(${elapsed})`)}`;
        }
        text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${theme.fg("accent", form + agentLabel + "…")}${stats}`;
      } else if (task.status === "completed") {
        text = `  ${icon} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}`;
      } else {
        const agentId = executionAgentId(task);
        const agentSuffix = task.status === "in_progress" && agentId
          ? theme.fg("dim", ` (agent ${agentId.slice(0, 5)})`)
          : "";
        const staleSuffix = isStaleManual && typeof startedAt === "number"
          ? theme.fg("warning", ` (stale ${formatDuration(Date.now() - startedAt)})`)
          : "";
        text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${task.subject}${agentSuffix}${staleSuffix}`;
      }

      lines.push(truncate(text + suffix));
    }

    if (tasks.length > MAX_VISIBLE_TASKS) {
      lines.push(truncate(theme.fg("dim", `    … and ${tasks.length - MAX_VISIBLE_TASKS} more`)));
    }

    return lines;
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
      const metric = this.metrics.get(t.id);
      const legacyStartedAt = typeof t.metadata?.startedAt === "number" ? t.metadata.startedAt : undefined;
      const startedAt = t.execution?.status === "running" ? t.execution.startedAt : legacyStartedAt ?? metric?.startedAt;
      const agentId = executionAgentId(t);
      const isStaleManual = !agentId &&
        typeof startedAt === "number" && Date.now() - startedAt >= MANUAL_TASK_STALE_AFTER_MS;
      return this.activeTaskIds.has(t.id) && t.status === "in_progress" && !isStaleManual;
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

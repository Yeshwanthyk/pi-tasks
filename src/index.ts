/**
 * @tintinweb/pi-tasks — A pi extension providing Claude Code-style task tracking and coordination.
 *
 * Tools:
 *   TaskCreate   — Create a structured task
 *   TaskList     — List all tasks with status
 *   TaskGet      — Get full task details
 *   TaskUpdate   — Update task fields, status, dependencies
 *   TaskClaim    — Atomically claim an available task
 *   TaskOutput   — Get output from a background task process
 *   TaskStop     — Stop a running background task process
 *   TaskExecute  — Execute tasks through the optional pi-subagents client protocol
 *
 * Commands:
 *   /tasks       — Interactive task management menu
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AutoClearManager } from "./auto-clear.js";
import { ProcessTracker } from "./process-tracker.js";
import { projectLabel, resolveProjectIdentity } from "./project-identity.js";
import { createPiTasksRuntime, runTaskEffect } from "./runtime.js";
import { REASONING_EFFORTS, SUBAGENT_HARNESSES, SubagentAdapter } from "./subagent-adapter.js";
import { TaskExecution } from "./task-execution.js";
import { TaskLifecycle } from "./task-lifecycle.js";
import { boundedOutput, executionAgentId, openExistingBlockers } from "./task-projections.js";
import { TaskStore } from "./task-store.js";
import { loadTasksConfig } from "./tasks-config.js";
import type { Task, TaskExecutionState } from "./types.js";
import { openSettingsMenu } from "./ui/settings-menu.js";
import { TaskWidget, type UICtx } from "./ui/task-widget.js";

// ---- Debug ----

const DEBUG = !!process.env.PI_TASKS_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-tasks]", ...args);
}

// ---- Helpers ----

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

function taskOutputPath(taskId: string): string {
  return join(process.cwd(), ".pi", "tasks", "output", `task-${taskId}.txt`);
}

function writeTaskOutput(taskId: string, content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  const path = taskOutputPath(taskId);
  mkdirSync(join(process.cwd(), ".pi", "tasks", "output"), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function formatExecution(execution: TaskExecutionState): string {
  if ((execution.status === "completed" || execution.status === "stopped") && execution.result) {
    return JSON.stringify({ ...execution, result: boundedOutput(execution.result, 4000) });
  }
  return JSON.stringify(execution);
}

function taskNotification(taskId: string, status: string, summary: string, outputFile?: string): string {
  return `<task-notification>\n<task_id>${taskId}</task_id>\n<status>${status}</status>` +
    `${outputFile ? `\n<output_file>${outputFile}</output_file>` : ""}\n<summary>${summary}</summary>\n</task-notification>`;
}

/** Task tool names — used to detect task tool usage for reminder suppression. */
const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskClaim", "TaskOutput", "TaskStop", "TaskExecute"]);

/** How many submitted requests without task tool usage before injecting a reminder. */
const REMINDER_INTERVAL = 4;

/** How many turns completed tasks linger before auto-clearing. */
const AUTO_CLEAR_DELAY = 4;

const SYSTEM_REMINDER = `<system-reminder>
The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user
</system-reminder>`;

export default function (pi: ExtensionAPI) {
  // Initialize store and config
  const cfg = loadTasksConfig();
  const piTasks = process.env.PI_TASKS;
  const taskScope = cfg.taskScope ?? "session";

  /** Resolve the task store path from env/config (without session ID). */
  function resolveStorePath(sessionId?: string): string | undefined {
    if (piTasks === "off") return undefined;
    if (piTasks?.startsWith("/")) return piTasks;
    if (piTasks?.startsWith(".")) return resolve(piTasks);
    if (piTasks) return piTasks;
    if (taskScope === "memory") return undefined;
    if (taskScope === "session" && sessionId) {
      return join(process.cwd(), ".pi", "tasks", `tasks-${sessionId}.json`);
    }
    if (taskScope === "session") return undefined; // no session ID yet, start in-memory
    return join(process.cwd(), ".pi", "tasks", "tasks.json");
  }

  // For project scope (or env override), create store immediately.
  // For session scope, start with in-memory and upgrade once we have the session ID.
  let store = new TaskStore(resolveStorePath());
  const isDefaultSessionStore = taskScope === "session" && piTasks === undefined;
  const deleteDefaultSessionFileIfEmpty = () => {
    if (isDefaultSessionStore) store.deleteFileIfEmpty();
  };
  const openBlockersForTask = (task: Pick<Task, "blockedBy">): string[] => openExistingBlockers(task, id => store.get(id));

  // ── Subagent/task execution state ──
  /** Model-visible task notifications waiting to be appended to a tool result. */
  const pendingTaskNotifications: string[] = [];
  const enqueueTaskNotification = (msg: string) => {
    if (!pendingTaskNotifications.includes(msg)) pendingTaskNotifications.push(msg);
  };
  const tracker = new ProcessTracker({
    onStall: (taskId, tail) => enqueueTaskNotification(taskNotification(
      taskId,
      "stalled",
      `Background task #${taskId} appears to be waiting for interactive input. Last output: ${tail.trimEnd()}`,
    )),
  });
  const widget = new TaskWidget(store);

  // ── Subagent integration state ──
  /** Cascade config — set by TaskExecute, consumed by completion listener. */
  let cascadeConfig: { additionalContext?: string; model?: string; reasoningEffort?: typeof REASONING_EFFORTS[number] } | undefined;

  const runtime = createPiTasksRuntime();
  const subagents = new SubagentAdapter(pi.events, { debug });

  const taskExecution = new TaskExecution({
    getStore: () => store,
    currentWorkspaceRoot: () => resolveProjectIdentity().root,
    spawnSubagent: request => subagents.spawn(request),
    cancelSubagent: agentId => subagents.cancel(agentId),
    listSubagents: subagents.list(),
    writeOutput: writeTaskOutput,
    notify: enqueueTaskNotification,
    taskNotification,
    onTaskActivated: (taskId, active = true) => widget.setActiveTask(taskId, active),
    onTasksChanged: () => widget.update(),
    onTaskCompleted: taskId => autoClear.trackCompletion(taskId, currentTurn),
    onCascadeBlocked: () => autoClear.resetBatchCountdown(),
    isAutoCascadeEnabled: () => cfg.autoCascade ?? false,
    getCascadeConfig: () => cascadeConfig,
    subscribeSettled: handler => subagents.subscribeSettled(handler),
  });

  const autoClear = new AutoClearManager(() => store, () => cfg.autoClearCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY);
  const taskLifecycle = new TaskLifecycle({
    getStore: () => store,
    currentTurn: () => currentTurn,
    onTaskActivated: (taskId, active = true) => widget.setActiveTask(taskId, active),
    onTasksChanged: () => {
      deleteDefaultSessionFileIfEmpty();
      widget.update();
    },
    onTaskCompleted: (taskId, turn) => autoClear.trackCompletion(taskId, turn),
    onBatchCountdownReset: () => autoClear.resetBatchCountdown(),
  });

  // ── Subagent lifecycle and persisted execution reconciliation ──
  subagents.subscribeSettled(data => {
    void runTaskEffect(runtime, taskExecution.handleSettled(data)).catch(error => {
      debug("settlement handler failed", error);
    });
  });

  let runningSync: Promise<void> | undefined;
  function syncRunningExecutions(): void {
    if (!storeUpgraded || !subagents.isAvailable() || runningSync) return;
    runningSync = runTaskEffect(runtime, taskExecution.syncRunning({
      // Project stores can contain agents owned by another live Pi process.
      markMissing: taskScope !== "project",
    }))
      .catch(error => {
        debug("subagent sync failed", error);
      })
      .finally(() => {
        runningSync = undefined;
      });
  }
  subagents.onAvailable(syncRunningExecutions);

  // ── Session-scoped store upgrade ──
  // For session scope, the store starts in-memory (no session ID at init time).
  // Upgrade to file-backed on first context arrival (turn_start, before_agent_start,
  // or tool_execution_start — whichever fires first).
  let storeUpgraded = false;
  let persistedTasksShown = false;
  function upgradeStoreIfNeeded(ctx: ExtensionContext) {
    if (storeUpgraded) return;
    if (taskScope === "session" && !piTasks) {
      const sessionId = ctx.sessionManager.getSessionId();
      const path = resolveStorePath(sessionId);
      store = new TaskStore(path);
      widget.setStore(store);
    }
    storeUpgraded = true;
    syncRunningExecutions();
  }

  /** Restore widget on session start/resume if there's unfinished work.
   *  On new sessions, auto-clear if all tasks are completed (clean slate).
   *  On resume, always show tasks (user may want to review).
   *  Only runs once — the first caller wins. */
  function showPersistedTasks(isRestoration = true) {
    if (persistedTasksShown) return;
    persistedTasksShown = true;
    const tasks = store.list();
    if (tasks.length > 0) {
      if (!isRestoration && isDefaultSessionStore && tasks.every(t => t.status === "completed")) {
        store.clearCompleted();
        deleteDefaultSessionFileIfEmpty();
      } else {
        autoClear.rehydrate(currentTurn);
        widget.update();
      }
    }
  }

  // ── Request tracking for system-reminder injection ──
  let currentTurn = 0;
  let currentRequest = 0;
  let lastReminderBaselineRequest = 0;
  let taskToolUsedForRequest: number | null = null;
  let reminderInjectedForRequest: number | null = null;

  pi.on("turn_start", async (_event, ctx) => {
    currentTurn++;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    if (autoClear.onTurnStart(currentTurn)) {
      deleteDefaultSessionFileIfEmpty();
      widget.update();
    }
  });

  // ── Token usage tracking ──
  // Feed per-turn token counts from assistant messages into the widget.
  pi.on("turn_end", async (event) => {
    const msg = event.message as any;
    if (msg?.role === "assistant" && msg.usage) {
      widget.addTokenUsage(msg.usage.input ?? 0, msg.usage.output ?? 0);
    }
  });

  // A manually marked in-progress task means "this is the current work item".
  // The spinner means "the current agent turn is actively working on it". If the
  // agent ends without marking the task completed, keep the task in_progress but
  // stop the active spinner so the UI doesn't imply work is still running.
  pi.on("agent_end", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    for (const task of store.list()) {
      if (task.status === "in_progress" && !executionAgentId(task)) {
        widget.setActiveTask(task.id, false);
      }
    }
    widget.update();
  });

  pi.on("session_shutdown", async () => {
    subagents.dispose();
    widget.dispose();
    await runtime.dispose();
  });

  // Pi preflights sibling calls before parallel execution, so record task-tool
  // use here rather than waiting for completion-order tool_result events.
  pi.on("tool_call", async (event) => {
    if (!TASK_TOOL_NAMES.has(event.toolName)) return;
    taskToolUsedForRequest = currentRequest;
    lastReminderBaselineRequest = currentRequest;
    reminderInjectedForRequest = null;
  });

  // ── System-reminder injection via tool_result event ──
  // Appends a <system-reminder> nudge to non-task tool results when actionable
  // tasks exist but task tools haven't been used in recent submitted requests.
  pi.on("tool_result", async (event) => {
    const extraContent: Array<{ type: "text"; text: string }> = [];
    if (pendingTaskNotifications.length > 0) {
      extraContent.push({ type: "text", text: pendingTaskNotifications.splice(0).join("\n\n") });
    }

    // Task results still drain queued notifications. Reminder suppression was
    // already recorded during preflight, before any sibling could complete.
    if (TASK_TOOL_NAMES.has(event.toolName) || taskToolUsedForRequest === currentRequest) {
      return extraContent.length > 0 ? { content: [...event.content, ...extraContent] } : {};
    }

    // Cheap checks first — avoid store.list() disk I/O when possible.
    if (currentRequest - lastReminderBaselineRequest < REMINDER_INTERVAL) {
      return extraContent.length > 0 ? { content: [...event.content, ...extraContent] } : {};
    }
    if (reminderInjectedForRequest === currentRequest) {
      return extraContent.length > 0 ? { content: [...event.content, ...extraContent] } : {};
    }

    const tasks = store.list();
    if (!tasks.some(task => task.status === "pending" || task.status === "in_progress")) {
      return extraContent.length > 0 ? { content: [...event.content, ...extraContent] } : {};
    }

    // Append system-reminder and use this request as the next cadence baseline.
    reminderInjectedForRequest = currentRequest;
    lastReminderBaselineRequest = currentRequest;
    return {
      content: [...event.content, ...extraContent, { type: "text" as const, text: SYSTEM_REMINDER }],
    };
  });

  // Grab UI context early — before_agent_start fires before any tool calls,
  // so persisted tasks show up immediately on session start.
  pi.on("before_agent_start", async (_event, ctx) => {
    currentRequest++;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    showPersistedTasks();
    const pendingWarning = subagents.takePendingWarning();
    if (pendingWarning) {
      ctx.ui.notify(pendingWarning, "warning");
    }
  });

  function resetSessionRuntime(reason: string | undefined, ctx: ExtensionContext) {
    widget.setUICtx(ctx.ui as UICtx);

    storeUpgraded = false;
    persistedTasksShown = false;
    currentTurn = 0;
    currentRequest = 0;
    lastReminderBaselineRequest = 0;
    taskToolUsedForRequest = null;
    reminderInjectedForRequest = null;
    autoClear.reset();
    widget.resetRuntimeState();
    taskExecution.reset();

    // Memory mode has no file-backed store to switch — clear explicitly on /new
    if (reason === "new" && taskScope === "memory") {
      store.clearAll();
    }

    upgradeStoreIfNeeded(ctx);
    showPersistedTasks(reason !== "new");
  }

  // Current pi emits session_start; older versions emitted session_switch.
  pi.on("session_start", async (event, ctx) => {
    const reason = event.reason as string | undefined;
    const isSessionStart = reason === "startup" || reason === "reload" || reason === "new" ||
      reason === "resume" || reason === "fork";
    if (!isSessionStart) {
      widget.setUICtx(ctx.ui as UICtx);
      return;
    }
    resetSessionRuntime(reason, ctx);
  });

  (pi.on as (event: string, handler: (event: { reason?: string }, ctx: ExtensionContext) => Promise<void>) => void)("session_switch", async (event, ctx) => {
    resetSessionRuntime(event.reason, ctx);
  });

  // Keep latestCtx fresh on every tool execution as well.
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    widget.update();
  });

  // ──────────────────────────────────────────────────
  // Tool 1: TaskCreate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Detailed description of what needs to be done, including context and acceptance criteria
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- Include enough detail in the description for another agent to understand and complete the task
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
- Check TaskList first to avoid creating duplicate tasks
- Include \`harness\` (\`pi\`, \`claude\`, or \`codex\`) to make a task executable via TaskExecute`,
    promptGuidelines: [
      "When working on complex multi-step tasks, use TaskCreate to track progress and TaskUpdate to update status.",
      "Mark tasks as in_progress before starting work and completed when done.",
      "Use TaskList to check for available work after completing a task.",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "A brief title for the task" }),
      description: Type.String({ description: "A detailed description of what needs to be done" }),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress (e.g., 'Running tests')" })),
      harness: Type.Optional(Type.Union(SUBAGENT_HARNESSES.map(harness => Type.Literal(harness)), { description: "Harness used for subagent execution. Tasks with a harness can be started via TaskExecute." })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const meta = params.metadata ?? {};
      const task = taskLifecycle.create(
        params.subject,
        params.description,
        params.activeForm,
        Object.keys(meta).length > 0 ? meta : undefined,
        params.harness,
        resolveProjectIdentity(),
        ctx.sessionManager?.getSessionId(),
      );
      return Promise.resolve(textResult(`Task #${task.id} created successfully: ${task.subject}`));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 2: TaskList
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)

Use TaskGet with a specific task ID to view full details including description and comments.`,
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const tasks = store.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));

      // Sort: pending first (by ID), then in_progress (by ID), then completed (by ID)
      const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
      const sorted = [...tasks].sort((a, b) => {
        const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
        if (so !== 0) return so;
        return Number(a.id) - Number(b.id);
      });

      const lines = sorted.map(task => {
        let line = `#${task.id} [${task.status}] ${task.subject}`;

        if (task.project) {
          line += " {" + projectLabel(task.project) + "}";
        }
        if (task.owner) {
          line += ` (${task.owner})`;
        }

        // Only show non-completed blockers
        if (task.blockedBy.length > 0) {
          const openBlockers = openBlockersForTask(task);
          if (openBlockers.length > 0) {
            line += ` [blocked by ${openBlockers.map(id => "#" + id).join(", ")}]`;
          }
        }

        return line;
      });

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 3: TaskGet
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to retrieve" }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = store.get(params.taskId);
      if (!task) return Promise.resolve(textResult(`Task not found`));

      // Unescape literal \n sequences the LLM may have double-escaped in JSON
      const desc = task.description.replace(/\\n/g, "\n");

      const lines: string[] = [
        `Task #${task.id}: ${task.subject}`,
        `Status: ${task.status}`,
      ];
      if (task.owner) {
        lines.push(`Owner: ${task.owner}`);
      }
      if (task.project) {
        lines.push("Project: " + task.project.name);
        lines.push("Workspace: " + task.project.root);
        if (task.project.remote) lines.push("Remote: " + task.project.remote);
        if (task.project.branch) lines.push("Branch: " + task.project.branch);
      }
      if (task.sessionId) lines.push("Origin session: " + task.sessionId);
      lines.push(`Description: ${desc}`);

      if (task.blockedBy.length > 0) {
        const openBlockers = openBlockersForTask(task);
        if (openBlockers.length > 0) {
          lines.push(`Blocked by: ${openBlockers.map(id => "#" + id).join(", ")}`);
        }
      }
      if (task.blocks.length > 0) {
        lines.push(`Blocks: ${task.blocks.map(id => "#" + id).join(", ")}`);
      }

      if (task.harness) lines.push(`Harness: ${task.harness}`);
      if (task.execution) lines.push(`Execution: ${formatExecution(task.execution)}`);

      // Show metadata if non-empty
      const metaKeys = Object.keys(task.metadata);
      if (metaKeys.length > 0) {
        lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);
      }

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 4: TaskUpdate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Use this tool to update a task in the task list.

## When to Use This Tool

**Before starting work on a task:**
- Mark it in_progress BEFORE beginning — do not start work without updating status first
- After resolving, call TaskList to find your next task

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **harness**: Set the execution harness (\`pi\`, \`claude\`, or \`codex\`), or null to clear it
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using \`TaskGet\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\``,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to update" }),
      status: Type.Optional(Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
        type: "string",
        enum: ["pending", "in_progress", "completed", "deleted"],
        description: "New status for the task",
      })),
      subject: Type.Optional(Type.String({ description: "New subject for the task" })),
      description: Type.Optional(Type.String({ description: "New description for the task" })),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
      owner: Type.Optional(Type.String({ description: "New owner for the task" })),
      harness: Type.Optional(Type.Union([
        ...SUBAGENT_HARNESSES.map(harness => Type.Literal(harness)),
        Type.Null(),
      ], { description: "Execution harness, or null to clear it" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to merge into the task. Set a key to null to delete it." })),
      addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
      addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { taskId, ...fields } = params;
      const { task, changedFields, warnings } = taskLifecycle.update(taskId, fields);

      if (changedFields.length === 0 && !task) {
        return Promise.resolve(textResult(`Task #${taskId} not found`));
      }
      if (warnings.length > 0) {
        return Promise.resolve(textResult("Task #" + taskId + " update rejected: " + warnings.join("; ")));
      }

      let msg = `Updated task #${taskId} ${changedFields.join(", ")}`;
      return Promise.resolve(textResult(msg));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 5: TaskClaim
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskClaim",
    label: "TaskClaim",
    description: `Atomically claim an available task for an owner.

Use this instead of TaskUpdate(owner) when multiple agents or sessions may coordinate through a shared task list. The claim succeeds only when the task exists, is not completed, is not blocked by open dependencies, and is not already owned by someone else.

If checkOwnerBusy is true, the claim also fails when the owner already has another non-completed task.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to claim" }),
      owner: Type.String({ description: "Owner/agent name or ID claiming the task" }),
      checkOwnerBusy: Type.Optional(Type.Boolean({ description: "Fail if owner already owns another non-completed task", default: false })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = store.claim(params.taskId, params.owner, { checkOwnerBusy: params.checkOwnerBusy });
      if (!result.success) {
        switch (result.reason) {
          case "task_not_found": return Promise.resolve(textResult(`Task #${params.taskId} not found`));
          case "already_completed": return Promise.resolve(textResult(`Task #${params.taskId} is already completed`));
          case "already_claimed": return Promise.resolve(textResult(`Task #${params.taskId} is already claimed by ${result.task?.owner}`));
          case "blocked": return Promise.resolve(textResult(`Task #${params.taskId} is blocked by ${result.blockedBy?.map(id => "#" + id).join(", ")}`));
          case "owner_busy": return Promise.resolve(textResult(`${params.owner} is already busy with ${result.busyWith?.map(id => "#" + id).join(", ")}`));
        }
      }
      widget.update();
      return Promise.resolve(textResult(
        result.changedFields.length > 0
          ? `Claimed task #${params.taskId} for ${params.owner}`
          : `Task #${params.taskId} already claimed by ${params.owner}`,
      ));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 6: TaskOutput
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskOutput",
    label: "TaskOutput",
    description: `- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions`,
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID to get output from" }),
      block: Type.Boolean({ description: "Whether to wait for completion", default: true }),
      timeout: Type.Number({ description: "Max wait time in ms", default: 30000, minimum: 0, maximum: 600000 }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const { task_id, block, timeout } = params;

      const processOutput = tracker.getOutput(task_id);
      if (!processOutput) {
        const output = await runTaskEffect(runtime, taskExecution.output(task_id, block, timeout ?? 30000), {
          signal: signal ?? undefined,
          interruptMessage: "Task output wait aborted. The task keeps running.",
        });
        if (!output) {
          if (!store.get(task_id)) throw new Error(`No task found with ID ${task_id}`);
          throw new Error(`No background process for task ${task_id}`);
        }
        const outputFile = output.outputFile ? `\nOutput file: ${output.outputFile}` : "";
        const body = output.result ? `\n\n${output.result}` : "";
        return textResult(`Task #${output.taskId} [${output.status}] — subagent ${output.agentId}${outputFile}${body}`);
      }

      if (block && processOutput.status === "running") {
        const result = await tracker.waitForCompletion(task_id, timeout ?? 30000, signal ?? undefined);
        if (result) {
          return textResult(
            `Task #${task_id} (${result.status})${result.exitCode !== undefined ? ` exit code: ${result.exitCode}` : ""}` +
            `${result.outputFile ? `\nOutput file: ${result.outputFile}` : ""}\n\n${boundedOutput(result.output)}`,
          );
        }
      }

      return textResult(
        `Task #${task_id} (${processOutput.status})${processOutput.exitCode !== undefined ? ` exit code: ${processOutput.exitCode}` : ""}` +
        `${processOutput.outputFile ? `\nOutput file: ${processOutput.outputFile}` : ""}\n\n${boundedOutput(processOutput.output)}`,
      );
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 7: TaskStop
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskStop",
    label: "TaskStop",
    description: `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task`,
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
      shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const taskId = params.task_id ?? params.shell_id;
      if (!taskId) throw new Error("task_id is required");

      const stopped = await tracker.stop(taskId);
      if (!stopped) {
        const subagentStopped = await runTaskEffect(runtime, taskExecution.stop(taskId));
        if (subagentStopped.stopped) return textResult(`Task #${taskId} stopped successfully`);
        throw new Error(`No running background process for task ${taskId}`);
      }

      taskLifecycle.update(taskId, { status: "pending" });
      return textResult(`Task #${taskId} stopped successfully`);
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 8: TaskExecute
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskExecute",
    label: "TaskExecute",
    description: `Execute one or more tasks as subagents.

## When to Use This Tool

- To start execution of tasks that have \`harness\` set (created via TaskCreate or TaskUpdate)
- Tasks must be \`pending\` with all blockedBy dependencies \`completed\`
- Each task runs as an independent background subagent

## Parameters

- **task_ids**: Array of task IDs to execute
- **additional_context**: Extra context appended to each agent's prompt
- **model**: Model override for agents (interpreted by the selected harness)
- **reasoning_effort**: Optional shared effort level (off, minimal, low, medium, high, xhigh, max)`,
    promptGuidelines: [
      "Never use the Agent tool for tasks launched via TaskExecute — agents are already running.",
    ],
    parameters: Type.Object({
      task_ids: Type.Array(Type.String(), { description: "Task IDs to execute as subagents" }),
      additional_context: Type.Optional(Type.String({ description: "Extra context for agent prompts" })),
      model: Type.Optional(Type.String({ description: "Model override for agents" })),
      reasoning_effort: Type.Optional(Type.Union(REASONING_EFFORTS.map(effort => Type.Literal(effort)), { description: "Reasoning effort override for agents" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!subagents.isAvailable()) {
        return textResult(
          "Subagent execution is currently unavailable. " +
          "Ensure the pi-subagents extension is loaded and try again."
        );
      }

      cascadeConfig = {
        additionalContext: params.additional_context,
        model: params.model,
        reasoningEffort: params.reasoning_effort,
      };

      const summary = await runTaskEffect(runtime, taskExecution.executeTasks(params.task_ids, cascadeConfig));

      const lines: string[] = [];
      if (summary.launched.length > 0) {
        lines.push(
          `Launched ${summary.launched.length} agent(s):\n${summary.launched.map(l => `#${l.taskId} → agent ${l.agentId}`).join("\n")}\n` +
          `Use TaskOutput to check progress. Do not spawn additional agents for these tasks.`
        );
      }
      if (summary.skipped.length > 0) lines.push(`Skipped:\n${summary.skipped.map(s => `#${s.taskId}: ${s.reason}`).join("\n")}`);
      if (lines.length === 0) lines.push("No tasks to execute.");

      return textResult(lines.join("\n\n"));
    },
  });

  // ──────────────────────────────────────────────────
  // /tasks command
  // ──────────────────────────────────────────────────

  pi.registerCommand("tasks", {
    description: "Manage tasks — view, create, clear completed",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const ui = ctx.ui;

      const mainMenu = async (): Promise<void> => {
        const tasks = store.list();
        const taskCount = tasks.length;
        const completedCount = tasks.filter(t => t.status === "completed").length;

        const choices: string[] = [
          `View all tasks (${taskCount})`,
          "Create task",
        ];
        if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
        if (taskCount > 0) choices.push(`Clear all (${taskCount})`);
        choices.push("Settings");

        const choice = await ui.select("Tasks", choices);
        if (!choice) return;

        if (choice.startsWith("View")) {
          await viewTasks();
        } else if (choice === "Create task") {
          await createTask();
        } else if (choice === "Settings") {
          await settingsMenu();
        } else if (choice.startsWith("Clear completed")) {
          store.clearCompleted();
          deleteDefaultSessionFileIfEmpty();
          widget.update();
          await mainMenu();
        } else if (choice.startsWith("Clear all")) {
          store.clearAll();
          deleteDefaultSessionFileIfEmpty();
          widget.update();
          await mainMenu();
        }
      };

      const viewTasks = async (): Promise<void> => {
        const tasks = store.list();
        if (tasks.length === 0) {
          await ui.select("No tasks", ["← Back"]);
          return mainMenu();
        }

        const statusIcon = (status: string) => {
          switch (status) {
            case "completed": return "✔";
            case "in_progress": return "◼";
            default: return "◻";
          }
        };

        const choices = tasks.map(t =>
          `${statusIcon(t.status)} #${t.id} [${t.status}] ${t.subject}`
        );
        choices.push("← Back");

        const selected = await ui.select("Tasks", choices);
        if (!selected || selected === "← Back") return mainMenu();

        // Extract task ID from selection
        const match = selected.match(/#(\d+)/);
        if (match) await viewTaskDetail(match[1]);
        else return viewTasks();
      };

      const viewTaskDetail = async (taskId: string): Promise<void> => {
        const task = store.get(taskId);
        if (!task) return viewTasks();

        const actions: string[] = [];

        if (task.status === "pending") {
          actions.push("▸ Start (in_progress)");
        }
        if (task.status === "in_progress") {
          actions.push("✓ Complete");
        }
        actions.push("✗ Delete");
        actions.push("← Back");

        const title = `#${task.id} [${task.status}] ${task.subject}\n${task.description}`;
        const action = await ui.select(title, actions);

        if (action === "▸ Start (in_progress)") {
          taskLifecycle.update(taskId, { status: "in_progress" });
          return viewTasks();
        } else if (action === "✓ Complete") {
          taskLifecycle.markCompleted(taskId);
          return viewTasks();
        } else if (action === "✗ Delete") {
          taskLifecycle.update(taskId, { status: "deleted" });
          return viewTasks();
        }
        return viewTasks();
      };

      const settingsMenu = (): Promise<void> =>
        openSettingsMenu(ui, cfg, mainMenu, AUTO_CLEAR_DELAY, (previousMode, currentMode) => {
          autoClear.onModeChanged(previousMode, currentMode, currentTurn);
        });

      const createTask = async (): Promise<void> => {
        const subject = await ui.input("Task subject");
        if (!subject) return mainMenu();
        const description = await ui.input("Task description");
        if (!description) return mainMenu();

        taskLifecycle.create(
          subject,
          description,
          undefined,
          undefined,
          undefined,
          resolveProjectIdentity(),
          ctx.sessionManager.getSessionId(),
        );
        return mainMenu();
      };

      const viewAllProjects = async (): Promise<void> => {
        const tasks = store.list();
        if (tasks.length === 0) {
          await ui.select("No tasks", ["Close"]);
          return;
        }

        const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
        const sorted = [...tasks].sort((a, b) => {
          const projectOrder = projectLabel(a.project).localeCompare(projectLabel(b.project));
          if (projectOrder !== 0) return projectOrder;
          const stateOrder = statusOrder[a.status] - statusOrder[b.status];
          return stateOrder !== 0 ? stateOrder : Number(a.id) - Number(b.id);
        });

        const choices: string[] = [];
        let currentProject: string | undefined;
        for (const task of sorted) {
          const project = projectLabel(task.project);
          if (project !== currentProject) {
            choices.push("── " + project + " ──");
            currentProject = project;
          }
          const icon = task.status === "completed" ? "✔" : task.status === "in_progress" ? "◼" : "◻";
          choices.push("  " + icon + " #" + task.id + " [" + task.status + "] " + task.subject);
        }
        choices.push("Close");
        await ui.select("All tasks by project", choices);
      };

      if (args.trim() === "all") await viewAllProjects();
      else await mainMenu();
    },
  });
}

# @tintinweb/pi-tasks

A [pi](https://pi.dev) extension that brings **Claude Code-style task tracking and coordination** to pi. Track multi-step work with structured tasks, dependency management, and a persistent visual widget.

> **Status:** Early release.

<img width="600" alt="pi-tasks screenshot" src="https://github.com/tintinweb/pi-tasks/raw/master/media/screenshot.png" />

https://github.com/user-attachments/assets/1d0ee87a-e0a5-4bfa-a9b9-2f9144cb905b



## Features

- **8 LLM-callable tools** — `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskClaim`, `TaskOutput`, `TaskStop`, `TaskExecute` — matching Claude Code's task workflow plus Pi-specific atomic claiming
- **Persistent widget** — live task list above the editor with `✔`/`◼`/`◻` status icons, task numbers (`#1`, `#2`, …), strikethrough for completed tasks, star spinner (`✳✽`) for active tasks with elapsed time and token counts
- **System-reminder injection** — periodic `<system-reminder>` nudges appended to tool results when actionable tasks exist and task tools haven't been used for several submitted requests
- **Prompt guidelines** — workflow contract encoded in tool descriptions, nudging the LLM at the point of tool use
- **Dependency management** — bidirectional `blocks`/`blockedBy` relationships with atomic rejection of cycles, self-dependencies, and dangling references
- **Shared task lists** — multiple pi sessions can share a file-backed task list for agent team coordination
- **File locking** — concurrent access is safe when multiple sessions share a task list
- **Background process tracking** — track spawned processes with output buffering, blocking wait, and graceful stop
- **Subagent integration** — tasks configured with a `pi`, `claude`, or `codex` harness can run via `TaskExecute` when [pi-subagents](https://github.com/Yeshwanthyk/pi-subagents) is loaded. Auto-cascade mode flows through the task DAG automatically when enabled.

## Install

```bash
pi install npm:@tintinweb/pi-tasks
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

## Widget

The extension renders a persistent widget above the editor:

```
● 4 tasks (1 done, 1 in progress, 2 open)
  ✔ #1 Design the flux capacitor
  ✳ #2 Acquiring plutonium… (2m 49s · ↑ 4.1k ↓ 1.2k)
  ◻ #3 Install flux capacitor in DeLorean › blocked by #1
  ◻ #4 Test time travel at 88 mph › blocked by #2, #3
```

| Icon | Meaning |
|------|---------|
| `✔` | Completed (strikethrough + dim) |
| `◼` | In-progress (not actively executing) |
| `◻` | Pending |
| `✳`/`✽` | Animated star spinner — actively executing task (shows `activeForm` text, elapsed time, token counts) |

## Tools

### `TaskCreate`

Create a structured task. Used proactively for complex multi-step work.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subject` | string | yes | Brief imperative title |
| `description` | string | yes | Detailed context and acceptance criteria |
| `activeForm` | string | no | Present continuous form for spinner (e.g., "Running tests") |
| `harness` | `pi` / `claude` / `codex` | no | Harness for subagent execution |
| `metadata` | object | no | Arbitrary key-value pairs |

```
→ Task #1 created successfully: Fix authentication bug
```

### `TaskList`

List all tasks with status, owner, and blocked-by info.

```
#1 [pending] Fix authentication bug
#2 [in_progress] Write unit tests (agent-1)
#3 [pending] Update docs [blocked by #1, #2]
```

Sort order: pending first, then in-progress, then completed (each group by ID).

### `TaskGet`

Get full details for a specific task.

```
Task #2: Write unit tests
Status: in_progress
Owner: agent-1
Description: Add tests for the auth module
Blocked by: #1
Blocks: #3
```

Shows owner (if set) and open (non-completed) dependency edges. Non-empty metadata is displayed as JSON.

### `TaskUpdate`

Update task fields, status, metadata, and dependencies.

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskId` | string | Task ID (required) |
| `status` | `pending` / `in_progress` / `completed` / `deleted` | New status |
| `subject` | string | New title |
| `description` | string | New description |
| `activeForm` | string | Spinner text |
| `owner` | string | Agent name |
| `harness` | `pi` / `claude` / `codex` / `null` | Set or clear the subagent execution harness |
| `metadata` | object | Shallow merge (null values delete keys) |
| `addBlocks` | string[] | Task IDs this task blocks |
| `addBlockedBy` | string[] | Task IDs that block this task |

```
→ Updated task #1 status
→ Updated task #2 owner, status
→ Updated task #3 blocks
→ Task #3 update rejected: dependency would create a cycle between #3 and #1
→ Updated task #1 deleted
```

Setting `status: "deleted"` permanently removes the task.

Dependencies are bidirectional: `addBlocks: ["3"]` on task 1 also adds `blockedBy: ["1"]` to task 3.

### `TaskClaim`

Atomically claim an available task for an owner. Prefer this over `TaskUpdate(owner)` when multiple agents/sessions share a task list.

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskId` | string | Task ID (required) |
| `owner` | string | Owner/agent name or ID claiming the task (required) |
| `checkOwnerBusy` | boolean | If true, fail when the owner already has another non-completed task |

Failure reasons are explicit: task not found, already completed, already claimed, blocked, or owner busy.

### `TaskOutput`

Retrieve output from a background task process.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task_id` | string | — | Task ID or agent ID (required) |
| `block` | boolean | `true` | Wait for completion |
| `timeout` | number | `30000` | Max wait time in ms (max 600000) |

Both task IDs and agent IDs (including partial prefixes) are accepted — agent IDs are resolved via the internal `agentTaskMap`.

### `TaskStop`

Stop a running background task process. Sends SIGTERM, waits 5 seconds, then SIGKILL. For subagent tasks, sends a version-1 client cancellation request.

Stopped execution is recorded separately and the task returns to `pending`, ready to resume or retry.

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_id` | string | Task ID or agent ID to stop |

### `TaskExecute`

Execute one or more tasks as background subagents through [pi-subagents](https://github.com/Yeshwanthyk/pi-subagents).

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_ids` | string[] | Task IDs to execute (required) |
| `additional_context` | string | Extra context appended to each agent's prompt |
| `model` | string | Harness-specific model override |
| `reasoning_effort` | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` | Shared reasoning-effort override |

Tasks must be `pending`, have `harness` set, and all `blockedBy` dependencies `completed`. Each task spawns as an independent background subagent.

Tasks from a named cross-project list can only be executed from their recorded workspace. Use `/tasks all` for cross-project visibility, then open Pi in the owning project to run the task.

With **auto-cascade** enabled (via `/tasks` → Settings), completed tasks automatically trigger execution of their unblocked dependents — flowing through the DAG like a build system. Each cascaded agent receives its prerequisites' stored results in the prompt, so it can build directly on what came before without re-fetching.

## Task Lifecycle

```
pending → in_progress → completed
                      → deleted (permanently removed)
```

Tasks are created as `pending`. Mark `in_progress` before starting work, `completed` when done. `deleted` removes entirely — IDs never reset.

Agent execution has its own state: `running`, `completed`, `failed`, `stopping`, or `stopped`. A successful run completes its task. Failed and stopped runs leave the task pending.

## Dependency Management

- **Bidirectional edges:** `addBlocks`/`addBlockedBy` maintain both sides automatically
- **Dependency validation:** cycles, self-dependencies, and references to non-existent tasks reject the entire update without changing any task fields
- **Display-time filtering:** `TaskList` only shows non-completed blockers in `[blocked by ...]`
- **Raw data preserved:** `TaskGet` shows ALL edges, including completed blockers
- **Cleanup on deletion:** removing a task cleans up all edges pointing to it

## Task Storage

Task storage is controlled by the `taskScope` setting (`/tasks` → Settings → Task storage):

| Mode | File | Behaviour |
|------|------|-----------|
| `memory` | *(none)* | In-memory only — tasks lost when session ends |
| `session` **(default)** | `<cwd>/.pi/tasks/tasks-<sessionId>.json` | Per-session file — isolated between sessions, survives resume |
| `project` | `<cwd>/.pi/tasks/tasks.json` | Shared across all sessions in the project |

On a genuinely new session, a completed-only default session store is auto-cleared for a clean slate. On session resume, all tasks (including completed) are restored and automatic cleanup countdowns restart. Empty default session files are automatically deleted when all tasks are cleared; named and explicit `PI_TASKS` stores remain on disk.

### Auto-clear completed tasks

The `autoClearCompleted` setting controls automatic cleanup of completed tasks:

| Mode | Behaviour |
|------|-----------|
| `never` | Completed tasks stay visible until manually cleared via `/tasks` → Clear completed |
| `on_list_complete` **(default)** | Cleared after all tasks are done and a few idle turns pass |
| `on_task_complete` | Each completed task cleared individually after a few turns |

Both auto-clear modes use a turn-based delay for non-jarring UX — tasks linger briefly so you see the completion before they disappear.

Settings (`taskScope`, `autoCascade`, `autoClearCompleted`) are saved to `<cwd>/.pi/tasks-config.json`.

### Override via environment variables

| Variable | Value | Behaviour |
|----------|-------|-----------|
| `PI_TASKS` | `off` | In-memory only (CI/automation) |
| `PI_TASKS` | `sprint-1` | Named shared list at `~/.pi/tasks/sprint-1.json` |
| `PI_TASKS` | `/abs/path/tasks.json` | Explicit absolute file path |
| `PI_TASKS` | `./tasks.json` | Relative path resolved from cwd |
| *(unset)* | | Uses `taskScope` setting (default: `session`) |
| `PI_TASKS_DEBUG` | `1` | Trace RPC communication (request/reply/timeout) and spawn errors to stderr |

Named and explicit paths use a file-locked store with stale-lock detection — safe for multiple pi sessions coordinating on the same task list.

Every newly created task records its project name, workspace root, git remote, branch, and originating session. Named lists can therefore contain tasks from several projects without losing their origin.

**CI example** (`.envrc`):
```bash
export PI_TASKS=off
```

**Shared team list** (`.envrc`):
```bash
export PI_TASKS=my-project
```

## `/tasks` Command

Interactive menu:

```
Tasks
├─ View all tasks (4)
├─ Create task
├─ Clear completed (1)
├─ Clear all (4)
└─ Settings
```

- **View all tasks** — select a task to see details and take actions (start, complete, delete)
- **Create task** — input prompts for subject and description
- **Clear completed** — remove all completed tasks
- **Clear all** — remove all tasks regardless of status
- **Settings** — configure task storage, auto-cascade, and auto-clear completed tasks (saved to `tasks-config.json`)

Run `/tasks all` to show the current shared list grouped by recorded project.

## Cross-extension Communication with [`pi-subagents`](https://github.com/Yeshwanthyk/pi-subagents)

`pi-tasks` uses version 1 of the pi-subagents client protocol over pi's event bus. Requests and replies use scoped channels correlated as `<channel>:reply:<requestId>`.

| Operation | Channel |
|-----------|---------|
| Presence/version check | `subagents:client:ping` |
| Spawn | `subagents:client:spawn` |
| Cancel | `subagents:client:cancel` |
| Reconcile client-owned agents | `subagents:client:list` |
| Provider ready broadcast | `subagents:client:ready` |
| Terminal lifecycle event | `subagents:client:settled` |

Spawn requests identify `clientId: "pi-tasks"`, use the task execution ID as `correlationId`, and include the selected `harness`, task name, prompt, working directory, and optional model/reasoning effort. Spawn replies return the normalized client snapshot, including both the correlation and agent ID.

A settlement is applied only when both its `correlationId` and `agentId` match the task's current execution. This prevents a late result from an earlier retry from completing the new run. Outcomes map as follows:

| Outcome | Task state |
|---------|------------|
| `completed` | `completed` with stored result |
| `failed` | `pending` with a failed execution record |
| `cancelled` | `pending` with a stopped execution record and partial output, when available |

On session restoration, `pi-tasks` uses `subagents:client:list` to reconnect persisted running executions that still exist in pi-subagents. Reconciliation is additive and does not guess outcomes for agents absent from the list.

### Standalone Mode

If `pi-subagents` is not installed, everything works except `TaskExecute`, which returns a friendly error message. All core task tools, dependencies, persistence, widget behavior, and reminder injection remain independent.

## Architecture

```
src/
├── index.ts            # Extension entry: 8 tools + /tasks command + widget + subagent integration
├── types.ts            # Task, TaskStatus, BackgroundProcess types
├── runtime.ts          # One managed Effect v4 runtime and the Promise boundary used by Pi callbacks
├── effect-errors.ts    # Typed failures for subagent client operations
├── subagent-adapter.ts # Version-1 pi-subagents client protocol adapter
├── task-schemas.ts     # Effect Schema validation for persisted tasks and settings
├── task-store.ts       # File-backed store with CRUD, dependencies, locking
├── task-execution.ts   # Effect workflows for spawn, output waiting, stopping, and cascading
├── auto-clear.ts       # Turn-based auto-clearing of completed tasks (AutoClearManager)
├── tasks-config.ts     # Config persistence (taskScope, autoCascade, autoClearCompleted) → .pi/tasks-config.json
├── process-tracker.ts  # Background process output buffering and stop
├── project-identity.ts  # Git workspace metadata attached to new tasks
└── ui/
    ├── task-widget.ts  # Persistent widget with status icons and spinner
    └── settings-menu.ts  # /tasks → Settings panel (SettingsList TUI component)
```

## Future Work

- **Background Bash auto-task creation** — Claude Code auto-creates tasks when `Bash` runs with `run_in_background: true`. Pi's bash tool currently lacks a `run_in_background` parameter (only `command` + `timeout`), so there's nothing to hook into. Once pi adds background execution support to its bash tool, we can use the `tool_call` event to detect it and auto-create tasks via `TaskStore`/`ProcessTracker`.

## Development

```bash
npm install
npm run typecheck   # Effect TSGO preparation + TypeScript validation
npm test            # Run the isolated unit and scenario suite
npm run build       # Compile the extension
```

The extension keeps one managed Effect v4 runtime for the Pi session. Pi's public callbacks remain Promise-based boundaries; task execution, RPC timeouts, cancellation, and clocks run as Effects. Persisted task and settings files are decoded through Effect Schema instead of trusted JSON casts.

## License

MIT — [tintinweb](https://github.com/tintinweb)

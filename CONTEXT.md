# Pi Tasks

Pi Tasks is a pi extension for coordinating multi-step agent work through durable task lists, live progress display, and optional subagent execution.

## Language

**Task**:
A unit of work tracked by the extension with a subject, description, lifecycle status, dependencies, optional owner, and optional execution metadata.
_Avoid_: Todo, item, job

**Task List**:
The ordered collection of **Tasks** visible to the agent and user during a pi session or project.
_Avoid_: Todo list, queue

**Task Status**:
The lifecycle state of a **Task**: pending, in progress, or completed.
_Avoid_: State, phase

**Blocker**:
A **Task** that must be completed before another **Task** can be claimed or executed.
_Avoid_: Prerequisite, dependency when referring to task ordering

**Owner**:
The agent or actor currently responsible for a **Task**.
_Avoid_: Assignee

**Active Task**:
An in-progress **Task** currently being worked on and shown with live progress in the widget.
_Avoid_: Running task when the work is not backed by a process or subagent

**Task Widget**:
The persistent pi UI surface that summarizes the **Task List** and highlights active work.
_Avoid_: Todo widget, status panel

**Task Scope**:
The persistence mode that determines whether a **Task List** lives in memory, in a session file, or in a project file.
_Avoid_: Storage mode

**Subagent Task**:
A **Task** configured with an agent type to be executed by a pi subagent through the interactive-subagents integration.
_Avoid_: Agent job

**Task Metadata**:
Arbitrary non-execution data attached to a **Task** by users or tools.
_Avoid_: Execution state, agent state

**Task Execution**:
The first-class persisted lifecycle of starting, tracking, stopping, and collecting output for a **Subagent Task**.
_Avoid_: Runner, job execution

**Task Context Footprint**:
The persisted and prompt-injected information attributable to a **Task**, including its stored fields, execution metadata, and any prerequisite results included for a **Subagent Task**.
_Avoid_: Task size, context when the storage or prompt surface is ambiguous

**Task Spec**:
The durable implementation brief for a **Task**, including goal, acceptance criteria, relevant files, constraints, verification steps, and handoff notes.
_Avoid_: Description when the field must be structured enough for independent implementation

**Task Result**:
The outcome produced by **Task Execution**, represented as a bounded summary plus a file-backed full output reference.
_Avoid_: Raw metadata result

**Auto-Cascade**:
The behavior that starts unblocked **Subagent Tasks** automatically after their **Blockers** complete.
_Avoid_: Auto-run, DAG runner

**Auto-Clear**:
The behavior that removes completed **Tasks** after a configured linger period.
_Avoid_: Cleanup

## Relationships

- A **Task List** contains zero or more **Tasks**.
- A **Task** has exactly one **Task Status**.
- A **Task** may have zero or more **Blockers** and may block zero or more other **Tasks**.
- A **Task** may have at most one **Owner**.
- An **Active Task** is a **Task** with in-progress status and live widget activity.
- A **Subagent Task** is a **Task** with agent execution configuration.
- **Task Metadata** does not contain **Task Execution** state.
- **Task Execution** is persisted on a **Task** when that **Task** is configured or run as a **Subagent Task**.
- **Task Execution** may produce output and update the **Task Status**.
- A **Task Context Footprint** may include stored **Task** data, a **Task Spec**, a **Task Result**, and prompt-injected **Blocker** summaries.
- A **Task Spec** should be sufficient for an agent to implement the **Task** independently.
- A **Task Result** should preserve full output without forcing raw output into every model-visible surface.
- **Auto-Cascade** uses **Blockers** to decide when to start **Subagent Tasks**.
- **Auto-Clear** removes completed **Tasks** from the **Task List**.
- A **Task Scope** determines where a **Task List** is persisted.

## Example dialogue

> **Dev:** "When a **Blocker** completes, should its dependent **Subagent Task** start immediately?"
> **Domain expert:** "Only when **Auto-Cascade** is enabled and every **Blocker** for that **Task** is completed. Otherwise it remains pending in the **Task List**."

## Flagged ambiguities

- "dependency" is overloaded with package dependencies; use **Blocker** for task ordering.
- "running task" is ambiguous between an **Active Task**, a background process, and a **Subagent Task**; use the specific term.
- "context" is ambiguous between persisted task data, model prompt content, and widget token usage; use **Task Context Footprint** when discussing per-task measurement.

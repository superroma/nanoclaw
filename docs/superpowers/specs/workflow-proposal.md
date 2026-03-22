# Workflow Engine Proposal

## Summary

Add a declarative workflow engine to NanoClaw that supports long-running, multi-step processes with agent phases and human interaction gates. Workflows are defined in `WORKFLOW.md` + `workflow.yaml` file pairs — analogous to how skills use `SKILL.md` + manifest. The engine manages many concurrent instances of the same workflow, each progressing independently through defined phases.

## Motivation

NanoClaw has the building blocks for multi-step work (scheduled tasks, session continuity, IPC, agent swarms) but no structured workflow orchestration. Use cases like PR review pipelines, customer onboarding flows, or multi-day research tasks all need:

- **Defined phases** with agent or human steps
- **Many concurrent instances** of the same process (e.g., 10 PRs being reviewed simultaneously)
- **Human-in-the-loop gates** (approval, feedback, choices)
- **Durable state** that survives crashes and restarts
- **Timeout and retry** logic per phase
- **Isolated workspace** per instance so they don't interfere

Today you'd have to hack this with scheduled tasks and file-based state — fragile, and relies on Claude "remembering" the protocol. A first-class engine makes it reliable.

## Analogy to Skills

| Concept | Skills | Workflows |
|---------|--------|-----------|
| **Definition** | `SKILL.md` + manifest.yaml | `WORKFLOW.md` + workflow.yaml |
| **What it describes** | How to transform code | How to run a multi-step process |
| **Runtime artifact** | Modified source files | Workflow instances in SQLite |
| **State tracking** | `.nanoclaw/state.yaml` | `workflow_instances` table |
| **Execution** | Claude Code runs SKILL.md once | Agents run each step, engine manages transitions |
| **Many instances?** | No (one-shot) | Yes — many instances of same workflow |

## File Structure

```
workflows/
  pr-review/
    WORKFLOW.md          # Agent instructions per phase (like SKILL.md)
    workflow.yaml        # Machine-readable definition (like manifest.yaml)
  customer-onboarding/
    WORKFLOW.md
    workflow.yaml
  weekly-report/
    WORKFLOW.md
    workflow.yaml
```

## workflow.yaml — Process Definition

```yaml
workflow: pr-review
version: "1.0"
description: "Review PRs: fetch, analyze, collect feedback, post review"
timeout: 72h                    # Max wall-clock time per instance

# Input schema — what's needed to start an instance
input:
  pr_url:
    type: string
    required: true
    description: "GitHub PR URL"
  priority:
    type: enum
    values: [low, normal, urgent]
    default: normal

# Phase definitions — the core of the workflow
phases:
  - id: fetch
    type: agent                  # Agent step — Claude runs autonomously
    timeout: 10m
    retry: { max: 2, delay: 30s }
    next: analyze

  - id: analyze
    type: agent
    timeout: 30m
    next: review_gate

  - id: review_gate
    type: human                  # Human step — wait for user input
    prompt: |
      Analysis complete for {{input.pr_url}}.
      {{steps.analyze.summary}}
      
      Reply: approve / request-changes / skip
    choices:                     # Optional structured choices
      approve: post_review
      request-changes: revise
      skip: close
    timeout: 48h                 # Auto-escalate or close if no response
    timeout_action: close

  - id: revise
    type: agent
    timeout: 20m
    next: review_gate            # Loop back to human

  - id: post_review
    type: agent
    timeout: 10m
    next: close

  - id: close
    type: terminal               # End state
    status: completed

  - id: error
    type: terminal
    status: failed

# What happens on unrecoverable errors
on_error: error

# Optional: schedule for creating instances automatically
trigger:
  type: cron
  value: "0 9 * * 1-5"
  input_from: agent              # Agent determines input at trigger time
```

## WORKFLOW.md — Agent Instructions Per Phase

````markdown
---
name: pr-review
description: Automated PR review with human approval gate
---

# PR Review Workflow

## Phase: fetch

Fetch the PR details from GitHub.

1. Use `WebFetch` to get the PR from {{input.pr_url}}
2. Save the diff to `workspace/pr-diff.txt`
3. Save PR metadata (author, title, description, changed files) to `workspace/pr-meta.json`
4. Set step output:
   - `files_changed`: number of files
   - `diff_size`: lines added + removed

## Phase: analyze

Analyze the PR for issues.

Read `workspace/pr-diff.txt` and `workspace/pr-meta.json`.

Check for:
- Security issues (credential leaks, injection, unsafe deserialization)
- Breaking API changes
- Missing tests for new code
- Style/convention violations per the repo's CLAUDE.md

Write your analysis to `workspace/analysis.md`.

Set step output:
- `summary`: 2-3 sentence summary of findings
- `severity`: critical / warning / clean
- `issues`: array of { file, line, description, severity }

## Phase: revise

The user requested changes to the review. Read their feedback
from `{{steps.review_gate.response}}` and update `workspace/analysis.md`.

## Phase: post_review

Post the review to GitHub using the GitHub API.
Read `workspace/analysis.md` and format as a PR review comment.
````

## SQLite Schema

New tables added alongside the existing `scheduled_tasks` and `messages` tables:

```sql
CREATE TABLE workflow_instances (
  id TEXT PRIMARY KEY,                    -- uuid
  workflow_name TEXT NOT NULL,            -- "pr-review"
  group_folder TEXT NOT NULL,             -- which group owns this
  chat_jid TEXT NOT NULL,                 -- for messaging
  current_phase TEXT NOT NULL,            -- "analyze"
  status TEXT NOT NULL DEFAULT 'active',  -- active | paused | completed | failed | waiting_human
  input TEXT NOT NULL,                    -- JSON: the input params
  step_outputs TEXT DEFAULT '{}',         -- JSON: { "fetch": { "files_changed": 12 }, ... }
  workspace_dir TEXT NOT NULL,            -- isolated dir for this instance's files
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  timeout_at TEXT,                        -- when the current phase times out
  error TEXT
);
CREATE INDEX idx_wf_status ON workflow_instances(status);
CREATE INDEX idx_wf_group ON workflow_instances(group_folder);

CREATE TABLE workflow_phase_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,                   -- running | completed | failed | skipped | timed_out
  output TEXT,                            -- JSON: step outputs
  error TEXT,
  duration_ms INTEGER,
  FOREIGN KEY (instance_id) REFERENCES workflow_instances(id)
);
CREATE INDEX idx_wf_phase_log ON workflow_phase_log(instance_id);
```

## Engine Architecture

The workflow engine fits into NanoClaw's existing architecture as a peer to the task scheduler:

```
Main Process (index.ts)
├── Message Loop          (existing)
├── Task Scheduler        (existing)
├── IPC Watcher           (existing)
└── Workflow Engine        (NEW)
    ├── polls workflow_instances for due agent phases
    ├── polls for timed-out human phases
    ├── spawns agents via existing runContainerAgent()
    └── routes human responses from messages
```

### Key design decisions

1. **Reuses existing agent infrastructure.** Each agent phase calls `runContainerAgent()` just like tasks do. The workflow engine manages *which* prompt to send and *what to do next*.

2. **Each instance gets an isolated workspace.** `data/workflows/{workflow}/{instance-id}/` — separate from group folders, so many instances don't pollute each other.

3. **Human phases are message-driven.** When a workflow hits a `human` phase, the engine sends the prompt to the chat and sets status to `waiting_human`. The message loop recognizes responses to waiting workflows and routes them back.

4. **Template interpolation.** `{{input.pr_url}}`, `{{steps.analyze.summary}}`, `{{steps.review_gate.response}}` are resolved from instance state before being passed to the agent. The WORKFLOW.md acts as a prompt template.

5. **Phase timeout + retry.** The engine's poll loop checks `timeout_at`. Retries re-run the same phase. Timeouts on human phases trigger `timeout_action`.

## MCP Tools

New tools added to `ipc-mcp-stdio.ts` so agents can interact with workflows:

| Tool | Description |
|------|-------------|
| `workflow_start` | Start a new instance of a workflow |
| `workflow_list` | List running instances (with phase, status) |
| `workflow_status` | Get detailed status of one instance |
| `workflow_respond` | Provide human response to a waiting phase |
| `workflow_pause` | Pause an instance |
| `workflow_cancel` | Cancel an instance |
| `workflow_set_output` | Set step output data (called by agent during a phase) |

## Instance Lifecycle

```
workflow_start({ workflow: "pr-review", input: { pr_url: "..." } })
    │
    ▼
┌─────────┐    ┌─────────┐    ┌──────────────┐
│  fetch   │───▶│ analyze │───▶│ review_gate  │
│ (agent)  │    │ (agent) │    │   (human)    │
└─────────┘    └─────────┘    └──────┬───────┘
                                     │
                          ┌──────────┼──────────┐
                          │          │          │
                       approve   request     skip
                          │      changes       │
                          │          │          │
                          ▼          ▼          ▼
                   ┌────────────┐ ┌───────┐ ┌───────┐
                   │post_review │ │revise │ │ close │
                   │  (agent)   │ │(agent)│ │       │
                   └─────┬──────┘ └───┬───┘ └───────┘
                         │            │
                         ▼            └──▶ review_gate (loop)
                      close
```

## Example Usage

User says:
```
@Andy review this PR: https://github.com/org/repo/pull/42
```

1. Agent recognizes this matches the `pr-review` workflow → calls `workflow_start` with `{ pr_url: "..." }`
2. Engine creates instance, writes to SQLite, starts `fetch` phase
3. `fetch` phase: spawns agent with WORKFLOW.md "Phase: fetch" instructions → agent fetches PR, saves files, calls `workflow_set_output`
4. Engine advances to `analyze` → spawns agent again
5. Engine advances to `review_gate` (human) → sends summary message to chat, sets `waiting_human`
6. User replies "approve" → message loop routes to engine → engine advances to `post_review`
7. `post_review` agent posts the review → engine marks instance `completed`

At any time the user can say `@Andy workflow status` and the agent calls `workflow_list` to show all running instances.

## Files Changed

| File | Change |
|------|--------|
| `src/workflow-engine.ts` | **New** — core engine (~400 lines) |
| `src/workflow-types.ts` | **New** — type definitions |
| `src/db.ts` | Add workflow tables migration |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add workflow MCP tools |
| `src/index.ts` | Start workflow engine loop, wire human-response routing |
| `workflows/example/` | **New** — example workflow definition |

## Implementation Strategy

Following NanoClaw philosophy ("customization = code changes", "skills over features"), this would be delivered as a skill: **`/add-workflows`**.

The skill adds the engine only to forks that need it, keeping NanoClaw lean for users who don't run multi-step processes. Users who need workflows run the skill and get a full pipeline engine integrated with existing infrastructure.

## Out of Scope

- Visual workflow editor or dashboard (use `workflow_list` / `workflow_status` via chat)
- Parallel phase execution (phases are sequential; use agent swarms within a phase for parallelism)
- Cross-group workflow instances (each instance belongs to one group)
- Workflow versioning / migration (v1 — keep it simple)

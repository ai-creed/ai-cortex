# Memory Model

Use this document when you want to understand what an ai-cortex memory is before reading the full memory reference.

The memory layer stores project knowledge that should survive across agent sessions but does not naturally belong in source code.

## What A Memory Is

A memory is an explicit project record.

It should capture knowledge an experienced engineer would want a future coding agent to know before acting:

- a decision and the reason behind it
- a gotcha that has caused real mistakes
- a convention the project follows
- a repeated implementation pattern
- a procedure that should be followed in order

A memory is not a transcript dump, chat summary, embedding blob, or hidden thought process. It is an inspectable record with a title, type, body, scope, lifecycle state, and audit trail.

## Built-In Types

ai-cortex ships four memory types:

| Type | Use for |
|---|---|
| `decision` | Architectural choices, conventions, constraints, and "we do X because Y" rules |
| `gotcha` | Known failure modes, brittle edges, races, environment traps, and mistakes to avoid |
| `pattern` | Repeated code or workflow shapes that should be followed consistently |
| `how-to` | Step-by-step procedures that agents should execute in a known order |

These types are intentionally practical. They map to the kinds of knowledge that coding agents often lose between sessions.

## Scope

Memories can be scoped by files and tags.

File scope tells the agent: this memory is likely relevant when working near these files.

Tag scope tells the agent: this memory belongs to this topic, subsystem, or workflow.

Good scope keeps memory precise. A narrowly scoped memory is more useful than a broad memory that appears everywhere.

Examples:

```text
scopeFiles: ["src/lib/update-notifier.ts"]
scopeTags: ["release", "notices"]
```

```text
scopeFiles: ["src/lib/memory/"]
scopeTags: ["memory-lifecycle", "cleanup"]
```

## Project And Global Memory

Most memories start as project memory. They apply to one repository.

Some memories apply across repositories, such as a language quirk, tool behavior, or personal workflow rule. Those can be promoted to global memory.

Use project memory for:

- repo-specific architecture
- local conventions
- release process details
- subsystem gotchas

Use global memory for:

- cross-project tool behavior
- language-specific traps
- durable personal engineering preferences
- agent workflow rules that apply everywhere

## Lifecycle

Memories are lifecycle-managed so the store does not become permanent noise.

The common path is:

```text
candidate -> active -> deprecated or trashed -> purged
```

The important states:

| State | Meaning |
|---|---|
| `candidate` | Extracted or proposed, but not yet trusted |
| `active` | Approved for recall and use |
| `deprecated` | Superseded or no longer applicable, kept for audit |
| `merged_into` | Folded into another memory |
| `trashed` | Soft-deleted and recoverable for a time |
| `purged` | Removed from the memory files, with audit preserved |

This lifecycle is part of the product philosophy. Memory should be durable, but not unbounded.

## Recall And Use

The cardinal pattern is:

```text
recall_memory -> get_memory -> apply the rule
```

`recall_memory` searches. It returns candidates that may be relevant.

`get_memory(id)` consults a specific memory. It records that the memory was actually selected for use.

The split matters because it separates visibility from application. A result appearing in search does not mean it influenced the agent. A `get_memory` call is the stronger signal.

## Explicit Recording

The cleanest memories are often recorded directly when the user states a rule:

```bash
ai-cortex memory record \
  --type decision \
  --title "Use pnpm for package management" \
  --body "Rule: Use pnpm for installs and scripts. Why: The repository uses pnpm-lock.yaml and CI expects pnpm."
```

Auto-extraction can discover candidate memories from captured sessions, but explicit recording produces cleaner project knowledge.

## What Makes A Good Memory

A good memory is:

- specific enough to apply
- durable beyond the current task
- written as a rule, warning, pattern, or procedure
- scoped to the files or topic where it matters
- clear about why the knowledge exists

A weak memory is:

- a vague summary of a conversation
- a one-off task detail
- unscoped trivia
- a fact already obvious from code
- a policy that belongs in public docs instead

## Storage And Control

Memory data lives under `~/.cache/ai-cortex/`, outside the target repository.

The repository is not modified. Memories are local to the developer unless explicitly moved or synced outside ai-cortex.

This keeps the substrate developer-controlled:

- records can be inspected
- lifecycle transitions are auditable
- noisy memories can be deprecated or trashed
- useful project memories can be promoted to global memory
- derived indexes can be rebuilt from source records

## What To Read Next

- [Mental model](./mental-model.md): how memory fits into the broader system.
- [Getting started](../getting-started.md): record and verify a first memory.
- [CLI reference](../reference/cli.md): memory commands and common flags.
- [MCP tools](../reference/mcp-tools.md): agent-facing tools and when to use each one.
- [Storage reference](../reference/storage.md): where memory records and derived indexes live.
- [Limitations](../reference/limitations.md): memory extraction, recall, and surfacing limits.

# Mental Model

Use this document when you understand what `ai-cortex` is, but want the system model before reading command references or architecture notes.

`ai-cortex` is a project knowledge substrate for coding agents. It is not the agent, and it is not a hidden reasoning engine. It gives agents explicit, durable project context through local tools.

## The Job

Coding agents need more than a context window.

They need to know:

- what the project contains
- which files matter for a task
- what prior sessions already established
- which decisions, gotchas, conventions, and patterns should persist

`ai-cortex` stores and retrieves that knowledge so the next agent session does not start from zero.

## The Three Layers

Think of ai-cortex as three layers that build on each other.

### Structural Layer

The structural layer answers: **what is in this repository?**

It indexes the repo and exposes:

- file tree and project shape
- imports and dependencies
- functions and call edges where supported
- task-based file ranking
- blast-radius lookup before changing a function

This is the cold-start layer. It helps an agent orient itself without doing a broad manual scan every session.

### Continuity Layer

The continuity layer answers: **what happened before?**

It captures compacted agent sessions and lets future sessions search:

- user corrections
- prior explanations
- files previously investigated
- decisions made during conversations
- relevant tool calls and session evidence

This is not memory in the durable-rule sense. It is searchable history for recovering context that would otherwise disappear after compaction or session end.

### Memory Layer

The memory layer answers: **what project knowledge should persist as a rule?**

Memories are explicit records such as:

- `decision`: "Use pnpm because CI expects pnpm."
- `gotcha`: "This parser race appears when tests run in parallel."
- `pattern`: "New MCP tools follow this validation and logging shape."
- `how-to`: "To cut a release, run these steps in this order."

Memories are developer-controlled. They can be recorded, recalled, inspected, rewritten, deprecated, merged, trashed, or promoted to a global tier.

## How An Agent Uses It

A typical session looks like this:

```text
start session
  |
  v
rehydrate_project
  |
  v
suggest_files for the task
  |
  v
recall_memory before non-trivial edits
  |
  v
get_memory for the memory being applied
  |
  v
edit with the remembered constraint in view
```

The important split is:

```text
recall_memory -> get_memory -> apply the rule
```

`recall_memory` is a search. It does not claim that a result was used.

`get_memory(id)` is the consult signal. It says the agent selected a specific memory and intends to apply it.

That distinction makes memory usage auditable instead of implied.

## No Hidden Intelligence

`ai-cortex` does not secretly reason about your repository.

It does not make hidden LLM calls. It does not host an assistant. It does not autonomously decide project policy. It does not turn memory into an opaque black box.

The substrate is intentionally explicit:

- project data lives under `~/.cache/ai-cortex/`
- target repositories are read, not modified
- memories have inspectable records and lifecycle state
- retrieval happens through CLI and MCP tools
- agents must choose what they apply

This is the core design principle: **no hidden intelligence in the substrate.**

## What Belongs Where

Use this distinction when deciding what should become a memory.

| Knowledge | Best place |
|---|---|
| Code behavior | Source code and tests |
| Public user instructions | README, manual, or user docs |
| Stable architecture decisions | Project docs or specs |
| Agent-facing project rules | ai-cortex memory |
| Temporary investigation details | Session history |
| Cross-project tool habits | Global memory |

The memory layer is for project knowledge that agents need during work but that does not naturally live in code.

## What To Read Next

- [Getting started](../getting-started.md): install and try the core workflow.
- [Agent integration](../guides/integrate-with-agents.md): configure MCP, hooks, and prompt guidance.
- [Memory model](./memory-model.md): memory types, scope, lifecycle, and recall/use.
- [CLI reference](../reference/cli.md): command groups and common flags.
- [MCP tools](../reference/mcp-tools.md): agent-facing tools and when to use each one.
- [Storage reference](../reference/storage.md): cache layout and local-first boundaries.
- [Limitations](../reference/limitations.md): current bounds and weak spots.
- [Architecture overview](../architecture/overview.md): technical system map and data flow.

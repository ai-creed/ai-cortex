# Architecture Overview

Use this page when you want the technical system map before reading implementation references or detailed design specs.

ai-cortex is a local project knowledge substrate for coding agents. The architecture is intentionally straightforward: build local project knowledge, expose it through tools, and keep the developer in control.

## System Shape

```text
coding agent
  |
  | MCP tools
  v
ai-cortex server and CLI
  |
  | reads repository
  v
target git worktree

ai-cortex server and CLI
  |
  | writes local tool-owned state
  v
~/.cache/ai-cortex/
```

Target repositories are read, not modified. Persistent ai-cortex state lives in the local cache.

The main exception is hook installation, which writes to user-level agent configuration such as `~/.claude/settings.json` or `~/.codex/config.toml`.

## Layers

ai-cortex has three layers.

| Layer | Question | Main surfaces |
|---|---|---|
| Structural | What is in this repo? | `index`, `rehydrate`, `suggest`, `blast_radius` |
| Continuity | What happened before? | history capture, `search_history` |
| Integration | How do agents use it? | MCP server, hooks, prompt guide, briefing |

The memory layer belongs to continuity, but it is important enough to call out separately: it stores durable project rules rather than raw session history.

## Structural Layer

The structural layer builds the project map.

It extracts:

- file tree and hashes
- package metadata
- documentation files
- imports
- functions and methods
- call edges where supported

The output is a local cache used by:

- `rehydrate_project` for session briefings
- `suggest_files` for task-based file discovery
- `blast_radius` for impact analysis
- CLI equivalents such as `rehydrate`, `suggest`, and `suggest-deep`

The structural layer is not a full static analyzer. It is a fast, practical project map for coding agents.

## Continuity Layer

The continuity layer preserves useful context across sessions.

It has two related stores:

| Store | Purpose |
|---|---|
| Session history | Searchable evidence from prior agent sessions |
| Memory | Durable decisions, gotchas, patterns, and how-tos |

Session history answers: what did we already discuss or investigate?

Memory answers: what should future agents treat as project knowledge?

This distinction matters. A session transcript can contain noise, partial reasoning, and one-off details. A memory should be a stable record that is worth surfacing later.

## Integration Layer

The integration layer connects ai-cortex to coding agents.

It includes:

- MCP server tools
- CLI commands
- rehydration briefing
- history capture hooks
- edit-time memory surfacing where supported
- prompt guide installation

MCP is the primary integration surface. Hooks and prompt guidance improve adoption but do not replace the MCP tools.

## Data Flow

Typical session-start flow:

```text
agent starts in repo
  |
  v
rehydrate_project
  |
  v
load structural briefing, memory digest, and notices
```

Typical task flow:

```text
user asks for change
  |
  v
suggest_files
  |
  v
recall_memory
  |
  v
get_memory for selected memory
  |
  v
edit and verify
```

Typical history flow:

```text
agent session ends or compacts
  |
  v
history hook captures session evidence
  |
  v
search_history can recover prior context
  |
  v
extractor may create candidate memories
```

## Canonical And Derived State

Some state is canonical. Some state is derived and rebuildable.

| State | Role |
|---|---|
| Memory markdown records | Canonical memory source |
| Structural index JSON | Derived from repository contents |
| Rehydration briefing Markdown | Derived from index and notices |
| Memory SQLite index | Derived from memory records and lifecycle operations |
| Vector sidecars | Derived retrieval data |
| Session history evidence | Captured source for history search and extraction |

If derived memory indexes drift, use:

```bash
ai-cortex memory rebuild-index
ai-cortex memory reconcile --report
```

If structural cache is stale or suspect, use:

```bash
ai-cortex index --refresh /path/to/repo
```

## No Hidden Intelligence

ai-cortex does not make hidden LLM calls.

The substrate:

- stores local project knowledge
- indexes code structure
- retrieves relevant records
- exposes tools to agents
- records lifecycle and audit history

The agent still decides what to apply. The developer can inspect and change the records.

This keeps the system engineering-friendly: explicit, local, auditable, and developer-controlled.

## Design History

The durable design history for ai-cortex lives under:

```text
docs/superpowers/
```

That subtree is the detailed spec and plan archive. It should remain available for agents and maintainers who need design rationale or implementation history.

User-facing docs should link to curated architecture pages first, then into `docs/superpowers/` only when detailed decision history is needed.

## Related Docs

- [Mental model](../concepts/mental-model.md): conceptual overview for readers before architecture.
- [Storage reference](../reference/storage.md): cache layout, canonical state, and derived state.
- [MCP tools](../reference/mcp-tools.md): agent-facing tool surface.
- [CLI reference](../reference/cli.md): command-line surface.
- [Library API](../reference/library-api.md): public Node.js API for structural indexing and analysis.
- [Limitations](../reference/limitations.md): current bounds and weak spots.
- [Roadmap](../roadmap.md): shipped foundation and future directions.

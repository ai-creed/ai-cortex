# MCP Tools Reference

Use this page when you need to understand which ai-cortex MCP tool an agent should call and when.

This is intentionally not a schema dump. MCP clients already receive schemas from the server. This page explains the tool groups, expected usage patterns, and the practical distinction between similar tools.

## Tool Groups

ai-cortex exposes MCP tools in four groups:

| Group | Tools |
|---|---|
| Project orientation | `rehydrate_project`, `index_project` |
| File discovery and impact | `suggest_files`, `suggest_files_deep`, `suggest_files_semantic`, `blast_radius` |
| Session continuity | `search_history`, `capture_session` |
| Memory | `recall_memory`, `get_memory`, `record_memory`, lifecycle, cleanup, and audit tools |

Most agents should start with project orientation, use file discovery before reading broadly, and consult memory before non-trivial edits.

## Standard Agent Flow

For normal coding work:

```text
rehydrate_project
  -> suggest_files
  -> recall_memory
  -> get_memory
  -> edit
```

When changing a known function:

```text
suggest_files
  -> blast_radius
  -> recall_memory
  -> get_memory
  -> edit and test
```

When a user references earlier discussion:

```text
search_history
  -> recall_memory if the result implies a durable rule
  -> get_memory if applying an existing memory
```

## Path Parameters

Most modern memory tools take `worktreePath`: an absolute path to a directory inside the target git worktree. The server derives the repository identity from that path.

Examples:

```json
{ "worktreePath": "/Users/me/dev/my-project" }
```

Structural tools usually take `path`, also pointing at the repository or a directory inside it.

## Project Orientation

| Tool | Use When |
|---|---|
| `rehydrate_project` | At session start when working in a git repository |
| `index_project` | After large structural changes or when forcing a rebuild |

### `rehydrate_project`

Returns an agent-ready Markdown briefing with project structure, key files, entry points, recent changes, pinned memories, and memory availability.

Agents should call this once near the start of a session.

### `index_project`

Forces a project index rebuild. Usually unnecessary because `rehydrate_project` and discovery tools handle freshness automatically.

Use this after large structural changes, generated-file churn, or when cache state is suspect.

## File Discovery And Impact

| Tool | Use When |
|---|---|
| `suggest_files` | Default first tool for task-specific file discovery |
| `suggest_files_deep` | Same deep ranking with explicit pool-size control |
| `suggest_files_semantic` | Conceptual/fuzzy task where keyword ranking misses |
| `blast_radius` | Before changing a known function or method |

### `suggest_files`

Use before broad file reading. It ranks relevant files using path tokens, function names, import/call graph, trigram fuzzy matching, and content scan.

Fall back to `rg`, grep, or direct file reads when:

- searching for an exact symbol or string
- verifying an edit
- `suggest_files` returns nothing useful

Results may include `relatedMemories` pointers. Those are visibility signals only. The agent should call `get_memory(id)` for any memory it intends to apply.

### `suggest_files_deep`

Use when a broad task needs a larger candidate pool or explicit tuning.

This is most useful on larger repositories where the default pool might be too narrow.

### `suggest_files_semantic`

Use when the task is conceptual and the right files may not share obvious keywords with the prompt.

The first semantic call downloads the local embedding model. Use `suggest_files` first unless you specifically need semantic matching.

### `blast_radius`

Use before modifying a function or class method. It returns affected callers by hop distance and export visibility.

For class methods, use `Class.method` format.

## Session Continuity

| Tool | Use When |
|---|---|
| `search_history` | Recover context from previous or compacted agent sessions |
| `capture_session` | Ingest a host-written transcript into the session history cache |

### `search_history`

Searches compacted session history for decisions, corrections, file paths, prior discussion, and tool-call evidence.

Defaults to current-session scope and auto-broadens to project scope if the current session has no matches. Use explicit project scope when the user asks about prior sessions generally.

History is populated by:

```bash
ai-cortex history install-hooks
```

### `capture_session`

Captures a host-written transcript JSONL into the session history cache. The pipeline parses the transcript, extracts evidence, builds chunks, and feeds the extractor — the same path that `search_history` later reads from.

This tool is host-agnostic: any host that writes a Claude-format transcript can call it, not just Claude Code. It is normally invoked by history hooks rather than directly by an agent.

Parameters:

- `worktreePath`: absolute path to a directory inside the project's git worktree; the server derives the repo identity from it.
- `sessionId`: identifier for the session being captured.
- `transcriptPath`: absolute path to the transcript JSONL the host wrote.
- `embed` (optional): whether to compute chunk embeddings during capture; defaults to enabled.

Capture is incremental and idempotent: it processes only new turns, reports `up-to-date` when nothing changed, and is a no-op (`disabled`) when history is turned off via `ai-cortex history off`.

## Memory Read Tools

| Tool | Use When |
|---|---|
| `recall_memory` | Browse memories before non-trivial edits or recurring issues |
| `get_memory` | Consult and apply a specific memory |
| `list_memories` | Inspect memories by type, status, or file scope |
| `search_memories` | Full-text search memory bodies |
| `audit_memory` | Inspect a memory's version and lifecycle history |

### `recall_memory`

Browse-only memory search. It does not signal that the agent used a result.

Use before:

- unfamiliar non-trivial edits
- debugging recurring symptoms
- applying project conventions
- acting on a user reference to a past decision

Pass `source: "all"` when cross-project global memories may matter.

### `get_memory`

Fetches the full record for one memory and records the consult signal.

Call this after `recall_memory` returns a relevant hit and the agent intends to apply it.

The core rule:

```text
recall_memory -> get_memory -> apply the rule
```

### `list_memories`

Use for inspection, triage, dashboards, and broad browsing by status, type, or scope.

### `search_memories`

Use when exact terms matter more than semantic ranking.

### `audit_memory`

Use when you need provenance, state transitions, or evidence history for a memory.

## Memory Write And Lifecycle Tools

| Tool | Use When |
|---|---|
| `record_memory` | User states a rule, preference, constraint, gotcha, or reusable procedure |
| `update_memory` | Fix title/body/metadata |
| `update_scope` | Change file or tag scope |
| `confirm_memory` | Promote a trusted candidate to active |
| `deprecate_memory` | Rule contradicts current code or direction |
| `restore_memory` | Bring a deprecated memory back |
| `merge_memories` | Combine duplicate or overlapping memories |
| `trash_memory` | Soft-delete a memory |
| `untrash_memory` | Restore from trash |
| `purge_memory` | Permanently delete a trashed memory |

### `record_memory`

Use this when the user states something that should persist.

Good triggers:

- "Always use pnpm here."
- "Do not edit generated files."
- "This race only happens under CI."
- "For releases, run this script first."

Scope the memory when possible. File-scoped memory is easier to surface precisely than unscoped memory.

Set `globalScope: true` only for cross-project rules such as language quirks or tool behavior.

### `deprecate_memory`

Use when an existing memory is no longer true. Deprecation preserves audit history while excluding the memory from normal recall.

Do not silently overwrite contradictory project knowledge. Deprecate or update it with a reason.

### `confirm_memory`

Use for normal candidate memories after the user endorses them or after the agent has used the rule successfully and verified the outcome.

Do not use `confirm_memory` on pending capture rows with `type: "capture"`. Use `rewrite_memory` or `deprecate_memory` for those.

## Memory Graph And Visibility Tools

| Tool | Use When |
|---|---|
| `link_memories` | Connect related memories |
| `unlink_memories` | Remove a relationship |
| `pin_memory` | Force important memory into every briefing |
| `unpin_memory` | Remove briefing pin |
| `promote_to_global` | Move a project memory to global cross-project memory |
| `add_evidence` | Append provenance to an existing memory |

Use `promote_to_global` only when the rule clearly applies beyond the current repository.

## Cleanup And Extraction Tools

| Tool | Use When |
|---|---|
| `extract_session` | Run memory extraction on one captured session |
| `review_pending_captures` | Review raw extracted captures awaiting judgment |
| `list_memories_pending_rewrite` | Find candidates eligible for cleanup rewrite |
| `rewrite_memory` | Turn a raw candidate/capture into a clean memory |
| `sweep_aging` | Preview or apply aging transitions |
| `rebuild_index` | Reconcile memory index from markdown records |

### `review_pending_captures`

Use this when the briefing says there are captures pending confirmation.

For each item:

- keep it by calling `rewrite_memory` with a real type, title, body, and scope
- reject it by calling `deprecate_memory` with a reason

Do not call `confirm_memory` on a `type: "capture"` row.

### `rewrite_memory`

Use after cleaning a raw candidate into a rule card. Rewriting a candidate promotes it to active.

Good rewritten memories include:

- rule
- rationale
- when it applies
- file or tag scope where possible

### `sweep_aging`

Use `dryRun: true` first to preview candidate trashing, deprecated cleanup, and old trash purging.

## Related Docs

- [Agent integration](../guides/integrate-with-agents.md): registering the MCP server with agents.
- [Architecture overview](../architecture/overview.md): where MCP fits in the system.
- [Memory model](../concepts/memory-model.md): memory types, scope, lifecycle, and recall/use.
- [CLI reference](./cli.md): command-line equivalents for many MCP operations.
- [Library API](./library-api.md): public Node.js API for structural indexing and analysis.
- [Language support](./language-support.md): parser-backed language coverage and call graph limits.
- [Storage reference](./storage.md): cache layout and local-first boundaries.
- [Configuration](./config.md): environment variables and config files.
- [Limitations](./limitations.md): current bounds and weak spots.

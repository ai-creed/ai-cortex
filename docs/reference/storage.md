# Storage Reference

Use this page when you need to know where ai-cortex stores data, what is canonical, and what can be rebuilt.

The short version: ai-cortex stores project knowledge outside target repositories under `~/.cache/ai-cortex/`.

## Storage Contract

ai-cortex follows three storage rules:

- Target repositories are read, not modified.
- Tool-owned state lives under `~/.cache/ai-cortex/`.
- Memory markdown records are canonical; indexes and vectors are derived.

The explicit exception is agent hook installation. Commands such as `ai-cortex history install-hooks` can modify user-level agent configuration files such as `~/.claude/settings.json` and `~/.codex/config.toml`. Those files are not inside the target repository, and the installer creates backups.

## Cache Root

Default cache root:

```text
~/.cache/ai-cortex/
```

Override for testing or isolated environments:

```bash
AI_CORTEX_CACHE_HOME=/tmp/ai-cortex-cache ai-cortex rehydrate /path/to/repo
```

Most users should not override the cache root.

## Layout

Current cache layout:

```text
~/.cache/ai-cortex/
  v1/
    <repo-key>/
      <worktree-key>.db
      <worktree-key>.seq.db
      <worktree-key>.meta.json
      <worktree-key>.md
      history/
        manifest.jsonl
        sessions/
          <session-id>/
            session.json
            chunks.jsonl
            .vectors.bin
            .vectors.meta.json
      memory/
        memories/
          <memory-id>.md
        trash/
          <memory-id>.md
        index.sqlite
        .vectors.meta.json
        types.json
        extractor-runs/
          <session-id>.json
    global/
      memory/
        memories/
        trash/
        index.sqlite
        types.json
  models/
```

Important directories:

| Path | Purpose |
|---|---|
| `v1/<repo-key>/` | Per-project cache |
| `<worktree-key>.db` | Structural index store (SQLite, WAL, `user_version = 2`) |
| `<worktree-key>.seq.db` | Sequence sidecar that serializes `indexSeq` assignment across processes; a transient `-journal` file appears beside it during a write |
| `<worktree-key>.meta.json` | Small dashboard metadata sidecar |
| `<worktree-key>.md` | Last rehydration briefing |
| `history/` | Captured agent session evidence |
| `memory/memories/` | Active, candidate, deprecated, and merged memory records |
| `memory/trash/` | Soft-deleted memories |
| `memory/index.sqlite` | Derived memory index, FTS, audit, and lookup data |
| `global/memory/` | Cross-project memory store |
| `models/` | Downloaded local embedding models |

## Repository Identity

ai-cortex derives a repository key from git identity. MCP memory tools usually ask for `worktreePath`, an absolute path inside the target git worktree, and derive the key server-side.

This avoids asking agents to pass raw repo keys around.

Multiple worktrees can have distinct worktree cache files while sharing the same conceptual project identity rules.

## Structural Cache

The structural cache is a per-worktree SQLite store (`<worktree-key>.db`).

It contains:

- files and hashes
- docs
- import edges
- function nodes (`functions`, one row per key)
- call edges where supported (`calls`)
- `symbols`: navigation declarations (functions, methods, classes, interfaces, types, enums, variables, properties, namespaces, and for C-family code structs and macros), each with a declaration range and an identifier (name) range
- `refs`: identifier occurrences (call, new, type, heritage, import, export, member, JSX, decorator) with a resolved `to_key` where the syntactic resolver can determine it
- `reexports`: writer-internal named re-exports that keep one-hop resolution correct across incremental indexes; consumers can ignore it
- package metadata
- `meta` keys `navCapabilities` (emitted kinds, for feature detection), `indexSeq` (increases on every successful write), and `contentFingerprint` (hash of file contents)

The store format is version 2 and the content schema is `3.2`. Stores or legacy `.json` caches from older versions are discarded and reindexed once on first use. See the [index contract](../architecture/cortex-index-contract.md) for the column-level shape.

Known limitations of incremental builds:

- A `calls` row whose target key was removed is swept to the unresolved form `::<qualified name of the stale target>`, while a full build writes `::<raw callee>` or `::<member>`. The unresolved name can therefore differ between an incremental and a full build of the same source.
- C-family calls resolved through companion source files or the repo-wide unique-name fallback are outside the import-based affected set. When such a target moves, an incremental build sweeps the caller's edge to unresolved instead of re-pointing it; `ai-cortex index --refresh` repairs it.
- Re-export chains longer than one hop can leave stale resolution until a full reindex.

Commands that use the structural cache normally refresh when git state changes.

Use stale mode only when you explicitly want cached data:

```bash
ai-cortex rehydrate --stale
ai-cortex suggest "task" --stale
```

Force a rebuild:

```bash
ai-cortex index --refresh /path/to/repo
```

## History Storage

Captured sessions live under:

```text
~/.cache/ai-cortex/v1/<repo-key>/history/
```

History stores compacted evidence, not a polished project rule. It supports `search_history` and memory extraction.

Install capture hooks:

```bash
ai-cortex history install-hooks
```

Prune old captured sessions:

```bash
ai-cortex history prune --before 2026-01-01
```

## Memory Storage

Memory markdown files are the source of truth.

Project memories live under:

```text
~/.cache/ai-cortex/v1/<repo-key>/memory/
```

Global memories live under:

```text
~/.cache/ai-cortex/v1/global/memory/
```

The SQLite index, FTS tables, audit rows, and vector sidecars are derived from memory records and lifecycle operations.

Rebuild derived memory indexes:

```bash
ai-cortex memory rebuild-index
```

Detect memory store drift:

```bash
ai-cortex memory reconcile --report
```

## Local Models

Some features use local embedding models. The first semantic call can download model files under:

```text
~/.cache/ai-cortex/models/
```

The default semantic ranker uses `Xenova/all-MiniLM-L6-v2`.

## Clearing Data

Clear all ai-cortex state:

```bash
rm -rf ~/.cache/ai-cortex/
```

Clear only downloaded models:

```bash
rm -rf ~/.cache/ai-cortex/models/
```

For normal use, prefer targeted commands over deleting the cache:

```bash
ai-cortex index --refresh /path/to/repo
ai-cortex memory rebuild-index
ai-cortex memory reconcile --report
```

## Privacy Boundary

ai-cortex is local-first.

By default:

- no project cache is sent to a hosted ai-cortex service
- no hidden LLM calls are made by the substrate
- target repositories do not receive generated memory files
- stats and memory data stay on the local machine

The user's coding agent may make its own model calls. ai-cortex does not hide those calls or proxy them.

## Related Docs

- [Mental model](../concepts/mental-model.md): how storage fits into the broader system.
- [Architecture overview](../architecture/overview.md): system map, layers, and data flow.
- [Memory model](../concepts/memory-model.md): what memory records represent.
- [Troubleshooting](../guides/troubleshooting.md): cache refresh and local setup recovery paths.
- [CLI reference](./cli.md): rebuild, reconcile, prune, and refresh commands.
- [Configuration](./config.md): environment variables and memory config.
- [MCP tools](./mcp-tools.md): agent-facing tools that use this storage.
- [Limitations](./limitations.md): current bounds around storage, sync, and agent integration.

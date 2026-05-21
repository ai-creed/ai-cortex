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
      <worktree-key>.json
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
| `<worktree-key>.json` | Structural index snapshot |
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

The structural cache is a JSON snapshot of the indexed repository.

It contains:

- files and hashes
- docs
- import edges
- function nodes
- call edges where supported
- package metadata

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

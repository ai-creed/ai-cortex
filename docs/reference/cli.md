# CLI Reference

Use this page when you need the command surface for `ai-cortex`.

For first-time setup, start with [Getting started](../getting-started.md). For memory concepts, read [Memory model](../concepts/memory-model.md).

## Top-Level Commands

```text
ai-cortex <command> [options]
```

| Command | Purpose |
|---|---|
| `index` | Build or refresh the local project index |
| `rehydrate` | Generate an agent-ready project briefing |
| `suggest` | Rank files relevant to a task |
| `suggest-deep` | Run deeper file ranking with a larger candidate pool and content scan |
| `suggest-semantic` | Rank files through semantic path matching |
| `history` | Manage captured agent sessions |
| `memory` | Manage project and global memories |
| `mcp` | Start the MCP server on stdio |
| `stats` | Open or query local adoption and performance stats |
| `version` | Print the installed version |
| `help` | Print top-level help |

## Project Indexing

Index a repository:

```bash
ai-cortex index [path]
```

Force a full reindex:

```bash
ai-cortex index --refresh [path]
```

Use this once per project, or after large structural changes. Other commands auto-refresh stale cache data when needed.

## Rehydration

Generate a Markdown briefing:

```bash
ai-cortex rehydrate [path]
```

Use cached data without refreshing:

```bash
ai-cortex rehydrate --stale [path]
```

Machine-readable output:

```bash
ai-cortex rehydrate --json [path]
```

Use this at the start of an agent session to orient the agent before broad file exploration.

## File Discovery

Fast ranking:

```bash
ai-cortex suggest "<task>" [path]
```

Common options:

```bash
ai-cortex suggest "<task>" --from <file>
ai-cortex suggest "<task>" --limit <n>
ai-cortex suggest "<task>" --stale
ai-cortex suggest "<task>" --json
```

Deep ranking:

```bash
ai-cortex suggest-deep "<task>" [path]
```

Common options:

```bash
ai-cortex suggest-deep "<task>" --from <file>
ai-cortex suggest-deep "<task>" --limit <n>
ai-cortex suggest-deep "<task>" --pool <n>
ai-cortex suggest-deep "<task>" --stale
ai-cortex suggest-deep "<task>" --json
```

Semantic ranking:

```bash
ai-cortex suggest-semantic "<task>" [path]
```

Use `suggest` first for most tasks. Use `suggest-deep` when you need broader candidate search and snippets. Use `suggest-semantic` when the query is conceptual and keyword ranking misses the right area.

## History

Install capture hooks:

```bash
ai-cortex history install-hooks
```

Remove capture hooks:

```bash
ai-cortex history uninstall-hooks
```

Enable or disable capture:

```bash
ai-cortex history on
ai-cortex history off
```

List captured sessions:

```bash
ai-cortex history list [--cwd <dir>] [--repo-key <key>]
```

Capture a specific session:

```bash
ai-cortex history capture --session <id> [--transcript <path>] [--cwd <dir>] [--repo-key <key>]
```

Prune old sessions:

```bash
ai-cortex history prune [--before <iso>] [--cwd <dir>] [--repo-key <key>]
```

Captured sessions feed `search_history` through MCP and can also feed memory extraction.

## Memory

The memory CLI manages explicit project knowledge.

Recall candidates:

```bash
ai-cortex memory recall "<query>" [--type <type>] [--limit <n>] [--scope-file <file>] [--tag <tag>] [--json]
```

Fetch a memory and record the use signal:

```bash
ai-cortex memory get <id> [--json]
```

Record a memory:

```bash
ai-cortex memory record --type <type> --title <title> --body-file <file> [--tag <tag>] [--scope-file <file>] [--source <source>]
```

List or search:

```bash
ai-cortex memory list [--type <type>] [--status <status>] [--scope-file <file>] [--limit <n>] [--json]
ai-cortex memory search "<query>" [--limit <n>] [--json]
```

Lifecycle commands:

```bash
ai-cortex memory update <id> [--title <title>] [--body-file <file>] [--reason <reason>]
ai-cortex memory confirm <id>
ai-cortex memory deprecate <id> --reason <reason>
ai-cortex memory restore <id>
ai-cortex memory merge <src-id> <dst-id> --body-file <file>
ai-cortex memory trash <id> --reason <reason>
ai-cortex memory untrash <id>
ai-cortex memory purge <id> --reason <reason> --yes [--redact]
```

Graph and visibility commands:

```bash
ai-cortex memory link <src-id> <dst-id> --type <type>
ai-cortex memory unlink <src-id> <dst-id> --type <type>
ai-cortex memory pin <id> [--force]
ai-cortex memory unpin <id>
ai-cortex memory promote <id>
```

Maintenance and extraction:

```bash
ai-cortex memory audit <id> [--json]
ai-cortex memory rebuild-index
ai-cortex memory reconcile [--report]
ai-cortex memory bootstrap [--limit-sessions <n>] [--min-confidence <x>] [--re-extract] [--cwd <dir>] [--repo-key <key>]
ai-cortex memory extract <session-id> [--min-confidence <x>] [--re-extract]
ai-cortex memory extractor-log [--session <id>] [--limit <n>]
ai-cortex memory sweep [--dry-run]
```

Prompt guide:

```bash
ai-cortex memory install-prompt-guide
ai-cortex memory uninstall-prompt-guide
```

The key usage pattern is:

```text
recall_memory -> get_memory -> apply the rule
```

`recall` is browse-only. `get` is the consult signal.

## MCP Server

Start the stdio MCP server:

```bash
ai-cortex mcp
```

Users normally do not run this directly. Configure it in an MCP-capable agent instead. See [Integrate with coding agents](../guides/integrate-with-agents.md).

## Stats

Open the stats dashboard:

```bash
ai-cortex stats
```

Use a specific time window:

```bash
ai-cortex stats --window 1h
ai-cortex stats --window 24h
ai-cortex stats --window 7d
ai-cortex stats --window 30d
```

Render one frame and exit:

```bash
ai-cortex stats --once
```

Backfill stats from captured history:

```bash
ai-cortex stats backfill
```

Show per-session memory adoption:

```bash
ai-cortex stats sessions
ai-cortex stats sessions --window 7d
ai-cortex stats sessions --json
```

## Version And Help

```bash
ai-cortex --version
ai-cortex -v
ai-cortex version
ai-cortex --help
ai-cortex -h
ai-cortex help
```

## Related Docs

- [Getting started](../getting-started.md): first setup and verification path.
- [Agent integration](../guides/integrate-with-agents.md): MCP and hook setup.
- [Troubleshooting](../guides/troubleshooting.md): common command, cache, stats, and setup recovery paths.
- [MCP tools](./mcp-tools.md): agent-facing tools and when to use each one.
- [Library API](./library-api.md): public Node.js API for structural indexing and analysis.
- [Language support](./language-support.md): parser-backed language coverage and call graph limits.
- [Benchmarking](./benchmarking.md): performance and ranking-quality benchmark suites.
- [Storage reference](./storage.md): cache layout and rebuildable state.
- [Configuration](./config.md): environment variables and config files.
- [Limitations](./limitations.md): current bounds and weak spots.
- [Memory model](../concepts/memory-model.md): memory types, scope, lifecycle, and recall/use.

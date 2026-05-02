# ai-cortex

`ai-cortex` is a **local-first intelligence layer for AI agents** — fast project rehydration, persistent memory across sessions, and session-history recovery, all delivered via MCP and a CLI.

It gives new agent sessions cached project knowledge without broad repo scans, captures the decisions and gotchas that don't live in code, and never writes into the target repository.

- 🌐 Homepage: <https://ai-creed.dev/projects/ai-cortex/>
- 📦 npm: <https://www.npmjs.com/package/ai-cortex>
- 📂 GitHub: <https://github.com/ai-creed/ai-cortex>

## Commands

```
# Project rehydration & file discovery
ai-cortex index [path]                          # Index a repo into local cache
ai-cortex index --refresh [path]                # Force full reindex
ai-cortex rehydrate [path]                      # Generate briefing from cache
ai-cortex rehydrate --json [path]               # Machine-readable output
ai-cortex suggest "<task>" [path]               # Rank relevant files (fast)
ai-cortex suggest-deep "<task>" [path]          # Deep ranking (trigram + content scan)
ai-cortex suggest-semantic "<task>" [path]      # Semantic embedding ranker

# Session history capture & recovery
ai-cortex history install-hooks                 # Install Claude Code + Codex hooks
ai-cortex history list                          # List captured sessions
ai-cortex history capture --session <id>        # Manually capture a transcript
ai-cortex history on | off                      # Enable / disable globally
ai-cortex history prune --before <YYYY-MM-DD>   # Drop sessions older than cutoff

# Memory layer (decisions, gotchas, patterns, how-tos)
ai-cortex memory install-prompt-guide           # Nudge agent into the recall→get pattern
ai-cortex memory recall "<query>"               # Browse memories (no signal)
ai-cortex memory get <id>                       # Use a memory (counts toward eligibility)
ai-cortex memory list [--status active]         # All memories
ai-cortex memory record --type decision …       # Record a memory explicitly
ai-cortex memory bootstrap                      # Extract from captured history
ai-cortex memory sweep [--dry-run]              # Apply aging transitions
ai-cortex memory promote <id>                   # Project → global tier
# … plus 15+ lifecycle subcommands; see MEMORY_LAYER.md or `ai-cortex memory --help`

# Server & meta
ai-cortex mcp                                   # Start MCP server (stdio)
ai-cortex --version | -v                        # Print version
ai-cortex --help    | -h                        # Command list
```

## Installation

Requires Node ≥ 20 and a git repository to analyze.

### Method A: npm (recommended)

```bash
npm install -g ai-cortex
# or: pnpm add -g ai-cortex
# or: yarn global add ai-cortex
```

Verify:

```bash
ai-cortex --version
```

### Method B: From source (for contributors)

```bash
git clone git@github.com:ai-creed/ai-cortex.git
cd ai-cortex
pnpm install
pnpm build
pnpm link --global
```

### Updating

```bash
npm install -g ai-cortex@latest
# or rebuild from source: cd ai-cortex && git pull && pnpm install && pnpm build
```

ai-cortex prints an upgrade-available notice once a day when a newer version is on npm. Set `AI_CORTEX_NO_UPDATE_CHECK=1` to suppress.

## First use

```bash
# 1. Index the repo (one-time per project)
ai-cortex index /path/to/repo

# 2. Register as an MCP server so the agent can call ai-cortex automatically
claude mcp add -s user ai-cortex -- ai-cortex mcp     # for Codex see MANUAL.md

# 3. (Optional but recommended) Install hooks so every session is captured
ai-cortex history install-hooks

# 4. (Optional but recommended) Nudge your agent into the recall→get pattern
ai-cortex memory install-prompt-guide
```

After this, `rehydrate_project`, `suggest_files`, `recall_memory`, and the rest are available to the agent — no manual steps per session.

## MCP Server

ai-cortex exposes its capabilities as an MCP server so agents call it automatically. **30 tools** across three groups:

### Project rehydration & file discovery

| Tool                     | When to call                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `rehydrate_project`      | Once at session start when working in a git repo                                       |
| `suggest_files`          | Before reading the codebase for a specific task (fast ranking)                         |
| `suggest_files_deep`     | When you need explicit `poolSize` control for tuning                                   |
| `suggest_files_semantic` | When keyword/graph ranking misses the conceptual or fuzzy match                        |
| `index_project`          | After large structural changes to force a rebuild                                      |
| `blast_radius`           | Before modifying a function, to assess impact                                          |
| `search_history`         | When prior-session context (decisions, corrections, file paths) was lost to compaction |

### Memory layer

| Tool                            | When to call                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `recall_memory`                 | **Browse-only.** Before non-trivial edits, when debugging recurring symptoms          |
| `get_memory`                    | **Use signal.** After picking a recall result you intend to apply                     |
| `record_memory`                 | When the user states a rule, preference, or constraint                                |
| `confirm_memory`                | When the user explicitly endorses a candidate                                         |
| `deprecate_memory`              | When a memory contradicts current code or current user direction                      |
| `promote_to_global`             | For cross-project patterns (language quirks, tool gotchas)                            |
| `list_memories_pending_rewrite` | Driving subagent-based cleanup                                                        |
| `rewrite_memory`                | After a subagent rewrites a raw candidate into a rule card                            |
| `sweep_aging`                   | Apply aging transitions (trash stale candidates, purge old trashed)                   |
| _… plus_                        | `list_memories`, `search_memories`, `get_memory`, `audit_memory`, `update_memory`, `update_scope`, `restore_memory`, `merge_memories`, `trash/untrash/purge_memory`, `pin/unpin_memory`, `link/unlink_memories`, `add_evidence`, `rebuild_index`, `extract_session` |

The cardinal pattern: **`recall_memory` is browse-only, `get_memory(id)` is the use signal.** See [MEMORY_LAYER.md](./MEMORY_LAYER.md) for the full guide.

### Setup

```bash
claude mcp add -s user ai-cortex -- ai-cortex mcp
```

`-s user` makes it available in all your projects. Verify with `claude mcp get ai-cortex`. For Codex CLI setup, see [MANUAL.md](./MANUAL.md#setting-up-with-codex-cli).

## History capture

ai-cortex captures compacted summaries of past agent sessions so the `search_history` MCP tool can recover context lost to harness compaction. Both Claude Code and Codex CLI are supported.

```bash
ai-cortex history install-hooks   # one-time setup; wires Claude Code + Codex hooks
ai-cortex history list            # list captured sessions for the current repo
ai-cortex history off             # disable capture globally
```

`install-hooks` edits `~/.claude/settings.json` (Claude Code SessionStart / Stop hooks) and `~/.codex/config.toml` (Codex equivalents) and creates timestamped `.bak.*` backups for any file it modifies. Captures land under `~/.cache/ai-cortex/<repo-key>/history/` and never write into the target repo. Search defaults to the current session and auto-broadens to the whole project when the current-session search returns nothing.

After every capture, the auto-extractor runs over the new session and produces candidate memories — see below.

## Memory

The memory layer captures project knowledge that doesn't live in code: decisions, gotchas, conventions, recurring patterns. Memories surface in agent sessions via the rehydration briefing (a "what's available" digest) and via the `recall_memory` / `get_memory` tools.

```bash
ai-cortex memory install-prompt-guide          # nudge agent into the recall→get pattern
ai-cortex memory recall "package manager"      # browse top-K (no signal generated)
ai-cortex memory get <id>                      # use a specific memory (bumps getCount)
ai-cortex memory list --status active --json   # all active memories
```

**The cardinal pattern.** `recall_memory` is browse-only — it ranks results but doesn't signal usage. `get_memory(id)` is the "I am applying this rule" signal. The split lets ai-cortex measure which memories actually drive agent behavior, which gates cleanup eligibility (only valuable memories earn token-spend on rewrite).

**Two tiers.** Memories start project-scoped (`~/.cache/ai-cortex/<repoKey>/memory/`). Promote to a global cross-project tier (`~/.cache/ai-cortex/global/memory/`) when the rule applies beyond the current repo. Cross-tier recall queries both stores in parallel.

**Lifecycle.** `candidate` → `active` → `deprecated`/`merged_into`/`trashed` → `purged`. Aging sweeps trash old candidates (90d) and purge old trashed memories (90d) automatically. `stale_reference` is never auto-aged.

**Auto-extraction.** Every session captured via the history hooks runs the auto-extractor and produces `candidate` memories from session evidence (corrections + assistant acknowledgments). Re-extraction across sessions raises confidence; repeating signals climb the confidence ladder over time.

**Adoption.** `ai-cortex memory install-prompt-guide` writes a versioned guidance block into `CLAUDE.md` and `AGENTS.md` so the agent's system context teaches the recall→get pattern from the start. Idempotent, surgically removable, supports both project and global scope.

### Full reference

See [MEMORY_LAYER.md](./MEMORY_LAYER.md) for the full memory-layer guide — mental model, core loop (observe → capture → distill → retrieve → inject → evolve), common flows, storage layout, architectural decisions, and limitations.

## Library API

```ts
import {
	indexRepo,
	rehydrateRepo,
	suggestRepo,
	queryBlastRadius,
} from "ai-cortex";

const cache = await indexRepo("/path/to/repo");
// cache.functions — all extracted functions with file + line
// cache.calls     — directed call edges between functions

const fast = await suggestRepo("/path/to/repo", "persistence layer", {
	mode: "fast",
});

const blast = queryBlastRadius(
	{ qualifiedName: "myFunction", file: "src/lib/foo.ts" },
	cache.calls,
	cache.functions,
);
// { target, totalAffected, confidence, tiers: [{ hop, label, hits }] }
```

See [MANUAL.md](./MANUAL.md#library-api) for full API reference.

## Architecture

Three layers, each useful on its own, each compounding when stacked. All local-only. None writes into the target repo.

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │                          Agent (via MCP)                             │
   └─┬───────────────────────────┬───────────────────────────┬────────────┘
     │                           │                           │
     ▼                           ▼                           ▼
   Structural                 Continuity                 Integration
   layer                      layer                      layer
   ────────                   ──────────                 ───────────
   index                      history                   MCP server
   rehydrate                  memory                    briefing
   suggest                    extractor                 install-prompt-guide
   blast-radius               aging + global

   Tree-sitter adapters       Markdown of record        Tool descriptions
   (TS, JS, Py, C, C++)       SQLite (WAL + FTS5)       Audit trail
   Call graph                 Vector sidecar
   Trigram index              Two-tier (project|global)

                ┌──────────────────────────────┐
                │  Local cache (~/.cache/      │
                │  ai-cortex/) — never writes  │
                │  into the target repository  │
                └──────────────────────────────┘
```

For a deeper architectural view, see [MEMORY_LAYER.md](./MEMORY_LAYER.md) (memory subsystem) and `docs/superpowers/specs/` (full design specs).

## Known limitations

- **TypeScript, JavaScript, Python, C, and C++.** Tree-sitter adapters cover `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.c`, `.cpp`, `.cc`, `.cxx`, `.c++`, `.h`, `.hpp`, `.hh`, `.hxx`, `.h++`. Go/Rust repos will index but yield no call graph.
- **Semantic ranker embeds file paths, not file bodies.** Good for "which file is about X"; not a replacement for grep on file content.
- **First semantic call downloads ~23 MB** (`Xenova/all-MiniLM-L6-v2`) into `~/.cache/ai-cortex/models/`.
- **Cache is local** — not shared across machines or users. Worktree-keyed.
- **MCP tool discovery:** in Claude Code, ai-cortex tools are deferred. Agents may default to Grep/Glob unless nudged. `ai-cortex memory install-prompt-guide` writes a guidance block to your CLAUDE.md/AGENTS.md to nudge the recall→get pattern.
- **Memory extractor is heuristic.** The auto-extractor uses regex (imperative cues, symptom cues, correction prefixes). It misses well-phrased decisions that don't match the regex. The boost-not-gate confidence model recovered ~30× of dropped signal in real session data, but the upper bound is still the regex itself.
- **Memory recall on short / abbreviation-heavy queries can be weak.** The default `Xenova/all-MiniLM-L6-v2` (22M params, 384-dim) handles general-English thematic matches well but struggles with domain abbreviations (`cxx` ≠ `c++`) and multi-hop semantic chains. A keyword anchor in the query usually rescues it. Larger models (`bge-small`, `e5-small`) are deferred.
- **Python: no type inference for attribute calls.** `obj.method()` where `obj` is not `self`/`cls` emits an unresolved `::method` edge. Self/cls calls resolve correctly. `from pkg import submodule; submodule.func()` also produces a missed edge — use `import pkg.submodule as submodule` or `from pkg.submodule import func` instead.
- **Python: no `__all__` awareness.** All top-level names are treated as exported.
- **Python: dynamic imports not tracked.** `importlib.import_module(...)` and `__import__(...)` produce no edges.
- **Cosmetic zsh warning during command substitution on macOS.** Capturing the output of memory commands that run embeddings (e.g. `ID=$(ai-cortex memory promote …)`) inside zsh on macOS can emit `failed to change group ID: operation not permitted`. The command succeeds and exits 0; the warning is from zsh's job control reacting to `@xenova/transformers` worker threads being torn down on `process.exit`. Direct invocations are unaffected. Workarounds: pipe stdout to a file, or `2>/dev/null` the substitution.

# ai-cortex Memory Layer

## What it is

The memory layer captures project knowledge that doesn't live in the code — decisions, gotchas, conventions, recurring patterns — and surfaces it to agents in future sessions. It's local-first, version-controlled (in audit, not in git), agent-agnostic via MCP, and ages out noise automatically.

Memories are typed (`decision` / `gotcha` / `how-to` / `pattern`), scoped (files + tags), lifecycle-managed (candidate → active → deprecated → trashed → purged), and stored as markdown files with a SQLite index for fast filtering and FTS5 full-text search.

## Why it exists

The structural cache (`index` + `rehydrate` + `suggest`) tells the agent what's in the repo — files, modules, call graphs. That solves the cold-start problem. But it doesn't solve the **continuity problem**:

- Past decisions and the reasoning behind them
- Recurring gotchas ("Linux race in `Parser.init`")
- Conventions the user has stated but never written down
- Mistakes already made and corrected

Without these, agents re-derive, re-discover, and re-make the same mistakes session after session. The memory layer is the substrate that holds them, surfaces them when relevant, and improves over time.

---

## The cardinal pattern

> `recall_memory` is browse-only. `get_memory(id)` is the use signal.

This is the core mental model for working with memories. Two tools, two purposes:

- **`recall_memory`** ranks memories by query and returns the top K. It's a browser. Calling it doesn't mean the agent will use any of the results — it just means the agent looked.
- **`get_memory(id)`** fetches the full record for a specific memory. It's the "I'm applying this rule" signal. Calling it bumps `getCount`, sets `lastAccessedAt`, and counts toward the memory's cleanup eligibility.

The split is deliberate: it lets ai-cortex measure which memories actually drive agent behavior versus which ones just appear in result sets. A memory's `getCount` is its concrete utility score.

The agent's flow is: `recall` → pick the most relevant hit → `get_memory(id)` → apply the rule.

---

## Mental model

### Memory types

Four built-in types, each with a body convention. Custom types can be added via `~/.cache/ai-cortex/<repoKey>/memory/types.json`.

| Type | Use for | Body sections |
|---|---|---|
| `decision` | Architectural choices, conventions, "we do X because Y" | Rule / Why / Alternatives considered |
| `gotcha` | Bugs, race conditions, footguns, "X breaks when Y" | Symptom / Cause / Workaround / How to detect |
| `pattern` | Recurring code or workflow patterns | Where / Convention / Examples |
| `how-to` | Sequenced procedures, "to do X, do Y then Z" | Goal / Steps / Verification |

### Lifecycle states

Memories transition through these states:

```
            extract                confirm           deprecate (recoverable)
candidate  ───────►  candidate  ──────────►  active  ──────────►  deprecated
                       │                                              │
                       │ aging or rewrite                              │ aging
                       ▼                                              ▼
                     trashed (90d-recoverable)  ◄─────────────────────┤
                       │                                              │
                       │ aging                                        │
                       ▼                                              ▼
                     purged                                       (terminal)
```

- `candidate` — auto-extracted, not yet validated
- `active` — confirmed via explicit `confirm_memory` or `rewrite_memory`
- `deprecated` — superseded but kept for audit; excluded from recall
- `merged_into` — content merged into another memory
- `trashed` — soft-deleted, recoverable for 90 days
- `purged` — file deleted, audit row preserved
- `purged_redacted` — privacy-grade scrub

### Two-tier storage

| Tier | Path | Use |
|---|---|---|
| **Project** | `~/.cache/ai-cortex/<repoKey>/memory/` | Repo-specific decisions, gotchas, patterns |
| **Global** | `~/.cache/ai-cortex/global/memory/` | Cross-project knowledge: language quirks, tool gotchas, universal patterns |

Memories start as project-scoped. Promote to global with `ai-cortex memory promote <id>` when the rule applies beyond the current repo.

Cross-tier recall (`--source all` or no flag) queries both stores in parallel and merges results, with a `+0.10` source boost for project results so local context outranks global when both match.

---

## The core loop

Memories aren't just stored — they flow through six stages, each with a CLI/MCP surface:

```
observe → capture → distill → retrieve → inject → evolve
```

### observe

Agent sessions are observed via Claude Code / Codex hooks (or manual `history capture`). Tool calls, file edits, user prompts, and assistant responses become session evidence.

```bash
ai-cortex history install-hooks    # one-time setup; auto-captures every session
ai-cortex history list             # see captured sessions
```

### capture

Each session is compacted into a structured `EvidenceLayer` — user prompts, corrections, tool calls, file paths — stored as JSON under `~/.cache/ai-cortex/<repoKey>/history/sessions/`.

```bash
ai-cortex history capture --session <id> --transcript <path>
```

### distill

The auto-extractor scans session evidence and produces candidate memories using regex heuristics:

- **Decision**: imperative cues (`must`, `always`, `never`, `should`) in user prompts
- **Gotcha**: symptom cues (`breaks`, `fails`, `race`, `bug`) in user prompts
- **Pattern**: cross-session co-occurrence — same file set + similar prompts across ≥3 sessions
- **How-to**: how-questions followed by sequential tool calls

Confidence is computed additively: `0.35 base + 0.10 if assistant ACK + 0.10 if user prompt has correction prefix`. Default `minConfidence: 0.4` floor — bare regex matches without quality signals are rejected.

```bash
ai-cortex memory bootstrap                            # one-shot extraction over all captured sessions
ai-cortex memory bootstrap --re-extract               # reprocess everything with current heuristics
ai-cortex memory extract --session <id>               # extract a single session
```

### retrieve

The agent (or you) queries memories. Two paths, per the cardinal pattern:

```bash
# Browse mode — ranked top-K, no signal generated
ai-cortex memory recall "database migration"
ai-cortex memory recall "auth" --scope-file src/api/auth.ts
ai-cortex memory recall "logging" --source all        # include global tier

# Use mode — fetch a specific memory, bumps getCount
ai-cortex memory get <id>
ai-cortex memory list                                  # browse all without query
ai-cortex memory search "exact term"                   # FTS-only search
```

Recall returns ranked results using a two-stage filter (SQL scope + cosine + recency + confidence). Get returns the full record and increments the access counter.

### inject

Three injection channels, all push-once at session start (not push-per-edit):

1. **Rehydration briefing** — the markdown briefing produced by `ai-cortex rehydrate` includes a memory digest section: counts (active / candidates / pinned), top-5 active memories per type with title + scope + confidence, and a "How to consult" guidance block.

2. **MCP tool descriptions** — opinionated, taught the recall→get pattern, included by every MCP-compliant agent automatically.

3. **Project-level prompt guide** — written to `CLAUDE.md` and/or `AGENTS.md` so the guidance is in the agent's system context from the start:

```bash
ai-cortex memory install-prompt-guide                            # default: scope global, both Claude + Codex
ai-cortex memory install-prompt-guide --agent claude             # Claude only
ai-cortex memory install-prompt-guide --scope project --yes      # writes to <cwd>/CLAUDE.md and AGENTS.md
ai-cortex memory uninstall-prompt-guide                          # surgical removal of the block
```

The block is wrapped in versioned HTML-comment markers (`<!-- ai-cortex:memory-rule:start v1 -->`), so installs are idempotent and future revisions auto-replace older versions.

### evolve

Memories aren't static — they age, refine, and self-improve based on use:

- **Re-extraction stability** — when the auto-extractor produces a near-duplicate (cosine ≥ 0.85), it bumps the existing memory's `confidence` by `+0.10` and `reExtractCount` by 1. Recurring patterns climb to higher confidence over time.
- **Aging sweeps** — `candidate` aged 90d without confirmation → trashed; `deprecated` aged 180d → trashed; `merged_into` aged 90d → trashed; `trashed` aged 90d → purged. `stale_reference` is never auto-aged.
- **Subagent rewrite** — raw extracted candidates are conversational snippets, not rule cards. The agent can dispatch a subagent to rewrite high-signal candidates into clean rule-card form (rule + rationale + when-applies). Auto-promotes `candidate → active` with confidence 1.0.

```bash
ai-cortex memory sweep --dry-run                       # preview aging transitions
ai-cortex memory sweep                                 # apply
```

The cleanup queue is gated by **value signals**: a candidate is eligible for rewrite only if it has been re-extracted at least once AND is either pinned OR has been accessed via `get_memory`. Most candidates age out without ever being cleaned, by design — only memories that have shown value earn cleanup tokens.

The rewrite tools are MCP-only (no CLI), because manual rewrite would require the user to bring their own LLM:

```
list_memories_pending_rewrite(repoKey, limit?, since?)
rewrite_memory(repoKey, id, { title, body, scopeFiles, scopeTags, type?, typeFields? })
```

---

## Common flows

### Start using memory on an existing project

```bash
# 1. Install the agent prompt guide so your agent learns the recall→get pattern
ai-cortex memory install-prompt-guide

# 2. Install the session capture hooks (one-time)
ai-cortex history install-hooks

# 3. (Optional) bootstrap from any existing transcripts
ai-cortex memory bootstrap

# 4. Verify
ai-cortex rehydrate                       # briefing now includes memory digest
ai-cortex memory list --json              # see what's been extracted
```

### Capture a rule explicitly

When the user states a rule and you want to record it directly, without waiting for the auto-extractor:

```bash
echo "## Decision

Use POST for create endpoints. Idempotent semantics matter; PUT is reserved for full-resource replacement." > /tmp/rule.md

ai-cortex memory record \
  --type decision \
  --title "Use POST for create endpoints" \
  --body-file /tmp/rule.md \
  --tag api --tag conventions \
  --scope-file src/api/create.ts
```

### Promote a project memory to global

```bash
# Find the memory
ai-cortex memory list --json | jq '.[] | select(.title | contains("typescript"))'

# Promote — the original becomes merged_into; a global copy is created
ai-cortex memory promote <id>

# Cross-tier recall now finds it from any project
cd /some/other/project
ai-cortex memory recall "typescript strict mode" --source all
```

### Inspect a memory's full history

```bash
ai-cortex memory get <id> --json | jq '.frontmatter'
ai-cortex memory audit <id>                # show every state transition with reasons
```

### Deprecate a rule that no longer applies

```bash
ai-cortex memory deprecate <id> --reason "superseded by RFC 9457 problem details"
ai-cortex memory restore <id>              # if you change your mind
```

---

## Storage layout

```
~/.cache/ai-cortex/
├── <repoKey>/                              # one per indexed project
│   ├── <worktreeKey>.json                  # project index cache
│   ├── <worktreeKey>.md                    # rehydration briefing
│   ├── history/
│   │   └── sessions/<sessionId>/session.json
│   └── memory/
│       ├── memories/<memoryId>.md          # active + candidate + deprecated
│       ├── trash/<memoryId>.md             # soft-deleted
│       ├── index.sqlite                    # SQL index + audit + FTS5
│       ├── .vectors.meta.json              # vector sidecar
│       ├── types.json                      # type registry (extensible)
│       └── extractor-runs/<sessionId>.json # extractor manifests
└── global/                                 # cross-project tier
    └── memory/                             # same shape as project memory dir
```

Markdown files are the **source of truth**. The SQLite index, audit log, and vector sidecar are derived — they can be rebuilt at any time:

```bash
ai-cortex memory rebuild-index             # regenerate index from .md files on disk
ai-cortex memory reconcile                 # detect orphan files, phantom rows, hash drift
```

---

## Architectural decisions

These are deliberate constraints, not yet-to-be-fixed limitations.

### Pull-only injection

The system surfaces awareness (briefing memory digest) but does not push memories into the agent's context per-edit. The agent decides per-task whether to consult memory. This is a deliberate tradeoff: irrelevant memories surfaced is worse than no memories at all, because they pollute the agent's reasoning. Only the agent — with knowledge of the current task and intent — can judge relevance.

This means low call rate is the worst case (memory layer is dormant), not catastrophic context corruption. The system degrades smoothly.

### Agent-agnostic via MCP

The integration surface is MCP. No hooks (Claude Code-specific), no agent-specific config files (Cursor's `.cursor/rules`), no editor extensions. Any MCP-compliant agent — Claude Code, Codex, Cline, future agents — gets the same memory store. Tied to the *project*, not the *tool*.

### No LLM in the substrate

ai-cortex makes zero LLM calls. No API keys, no provider choice, no hidden costs, no telemetry. Intelligence (rewriting raw candidates into rule cards, judging relevance) is delegated to the user's agent and any subagents the agent spawns. This means:

- Cost transparency: tokens show up in the user's agent billing, not hidden behind a service
- Deployment simplicity: no API key configuration
- Graceful degradation: users without subagent-capable agents simply have lower memory quality (raw candidates work for FTS/recall just fine)

### Markdown is the source of truth

The SQL index is convenient; the markdown is canonical. `git`-friendly (though we don't commit the cache), `cat`-friendly, easy to audit and inspect. If the index gets corrupted, `rebuild-index` regenerates it from the markdown files. If a markdown file is missing, `reconcile` detects and reports.

### Versioned audit, not git history

Every state transition writes an audit row with the previous body hash, the previous body (for types that opt-in via `auditPreserveBody`), the change type, and the reason. The full version chain is reconstructable. We don't use git for this because the cache is local-only and per-machine; audit is the cross-session record of changes.

---

## Configuration

### `memory.config.json`

Layered loader: defaults → user config → repo config. Located at `~/.cache/ai-cortex/<repoKey>/memory/config.json` (created on first use).

```json
{
  "extractor": {
    "minConfidence": 0.4,
    "dedupCosine": 0.85,
    "lowConfidenceThreshold": 0.4
  },
  "aging": {
    "candidateToTrashedDays": 90,
    "deprecatedToTrashedDays": 180,
    "mergedIntoToTrashedDays": 90,
    "trashedToPurgedDays": 90,
    "lowConfidenceThreshold": 0.4
  },
  "ranking": {
    "topK": 10
  }
}
```

### Environment variables

| Variable | Purpose |
|---|---|
| `AI_CORTEX_CACHE_HOME` | Override the cache root (default: `~/.cache/ai-cortex/`). Used by tests; rarely useful in production. |
| `AI_CORTEX_NO_UPDATE_CHECK` | Disable the daily background update check. |
| `AI_CORTEX_HISTORY` | Set to `0` to disable session capture even with hooks installed. |

### Per-call flags

Most memory CLI commands accept:
- `--repo-key <key>` — override repo identity (useful for cross-project work)
- `--cwd <path>` — override the current working directory
- `--json` — machine-readable output

---

## Limitations and what's deferred

Honest about what doesn't work yet:

### Extractor recall is heuristic, not semantic
The auto-extractor uses regex heuristics (imperative cues, symptom cues, correction prefixes). It misses well-phrased decisions that don't match the regex. The boost-not-gate model (correction prefix is a +0.10 confidence boost rather than a hard filter) recovered ~30x of dropped signal in real session data, but the upper bound is still the regex itself. An LLM-based extractor (running in a subagent) is a possible future direction.

### Embedding model is small
Default is `Xenova/all-MiniLM-L6-v2` (22M params, 384-dim). It handles general-English thematic matches well but struggles with domain abbreviations (`cxx` ≠ `c++`), multi-hop semantic chains, and very short queries. A keyword anchor in the query usually rescues it. Larger models (`bge-small-en-v1.5`, `multilingual-e5-small`) are deferred.

### No symbol-level scope
Scope is at file and tag granularity. A memory bound to a specific function or class isn't directly supported — you'd scope the file and tag the function name in the body.

### Closed feedback loop is partially shipped
The access counters (`getCount`, `lastAccessedAt`, `reExtractCount`, `rewrittenAt`) are in place and gate cleanup eligibility. But the full closed-loop reconciliation — "this memory was recalled in session S, did the agent's subsequent work violate it?" — is deferred. The data shape supports it; the analyzer doesn't exist yet.

### Cross-tier promotion is manual
You decide which project memories deserve global scope. Auto-promotion is deferred until we have a clear signal for cross-project applicability.

### `cat ~/.claude/CLAUDE.md` could be cleaner
The prompt guide installer adds a guidance block to your CLAUDE.md / AGENTS.md. The block is well-fenced and idempotent, but if you keep heavily-customized agent system prompts, you'll want to install at `--scope global` (default) rather than per-project to avoid mixing concerns.

---

## Quick reference

```bash
# Setup
ai-cortex memory install-prompt-guide                  # nudge agent into the loop
ai-cortex history install-hooks                        # auto-capture sessions

# Browse / inspect
ai-cortex memory list                                  # all memories
ai-cortex memory list --json                           # machine-readable
ai-cortex memory recall "<query>" [--source all]      # ranked by relevance
ai-cortex memory search "<term>"                       # FTS-only
ai-cortex memory get <id>                              # full record (use signal)
ai-cortex memory audit <id>                            # full history

# Lifecycle
ai-cortex memory record --type <t> --title <t> --body-file <f>
ai-cortex memory confirm <id>                          # candidate → active
ai-cortex memory deprecate <id> --reason "..."         # excluded from recall
ai-cortex memory restore <id>                          # back to active
ai-cortex memory trash <id> --reason "..."             # soft delete
ai-cortex memory untrash <id>                          # restore from trash
ai-cortex memory promote <id>                          # project → global

# Maintenance
ai-cortex memory sweep --dry-run                       # preview aging
ai-cortex memory sweep                                 # apply aging
ai-cortex memory rebuild-index                         # regen SQL from markdown
ai-cortex memory reconcile                             # detect drift

# Bootstrap / extract
ai-cortex memory bootstrap                             # one-shot extraction
ai-cortex memory bootstrap --re-extract                # reprocess everything
ai-cortex memory extract --session <id>                # extract one session
ai-cortex memory extractor-log --session <id>          # last extractor manifest

# Adoption
ai-cortex memory install-prompt-guide [--scope] [--agent] [--yes]
ai-cortex memory uninstall-prompt-guide
```

For the design rationale and architectural decisions in detail, see `docs/superpowers/specs/2026-04-30-memory-schema-design.md` and `docs/superpowers/specs/2026-05-01-memory-utility-design.md`.

# Known Limitations

Honest documentation of what ai-cortex doesn't do well today, grouped by area. Most are deferred-not-deferred-forever — see [`docs/shared/high_level_plan.md`](./docs/shared/high_level_plan.md) for which ones have proposed phases.

---

## Language support

### Call graph is TypeScript / JavaScript / Python / C / C++ only

Tree-sitter adapters cover the following extensions:

- TypeScript / JavaScript: `.ts`, `.tsx`, `.js`, `.jsx`
- Python: `.py`
- C / C++: `.c`, `.cpp`, `.cc`, `.cxx`, `.c++`, `.h`, `.hpp`, `.hh`, `.hxx`, `.h++`

Go and Rust repos will index (file tree, package metadata, docs) but yield no call graph and a degraded import graph. Other languages are not parsed.

### Python: no type inference for attribute calls

`obj.method()` where `obj` is not `self` or `cls` emits an unresolved `::method` edge. Self/cls calls resolve correctly. `from pkg import submodule; submodule.func()` also produces a missed edge — use `import pkg.submodule as submodule` or `from pkg.submodule import func` instead.

### Python: no `__all__` awareness

All top-level names are treated as exported. `__all__` declarations are not consulted.

### Python: dynamic imports not tracked

`importlib.import_module(...)` and `__import__(...)` produce no import edges.

---

## File discovery

### Semantic ranker embeds file paths, not file bodies

`suggest_files_semantic` scores files by embedding their *paths* (plus light metadata), not their content. Good for "which file is about X" queries — bad for "find files mentioning function `foo`". For content-aware ranking use `suggest_files_deep` (trigram + content scan).

### First semantic call downloads ~23 MB

`Xenova/all-MiniLM-L6-v2` is fetched on first use into `~/.cache/ai-cortex/models/`. Subsequent calls are fast. The download blocks the first `suggest_files_semantic` invocation in a fresh environment.

---

## Memory layer

### Auto-extractor is heuristic

The extractor uses regex cues (imperative for decision, symptom for gotcha, how-question + tool-call sequence for how-to, cross-session co-occurrence for pattern) plus a confidence boost from assistant ACK and correction prefix in the user prompt.

It misses well-phrased decisions that don't match the regex. The boost-not-gate fix shipped in v0.5.0 recovered approximately 30× of previously-dropped signal — but the upper bound is still the regex itself.

An LLM-based extractor running in a user-supplied subagent (no LLM in the substrate) is a deferred direction; see `docs/shared/high_level_plan.md` Phase 15.

### Memory recall on short / abbreviation-heavy queries can be weak

The default embedding model (`Xenova/all-MiniLM-L6-v2`, 22M params, 384-dim) handles general-English thematic matches well — but struggles with domain abbreviations (`cxx` is not adjacent to `c++` in its embedding space) and multi-hop semantic chains.

A keyword anchor in the query usually rescues it (`"cxx adapter"` works because `cxx` is a literal token even if the model doesn't equate it to `c++`). Pure-semantic queries on 2–3 word abbreviation-heavy inputs are the failure mode.

Larger models (`bge-small-en-v1.5`, `multilingual-e5-small`) as opt-in alternatives are deferred to Phase 16.

### Closed feedback loop is foundational only

Access counters (`get_count`, `last_accessed_at`, `re_extract_count`, `rewritten_at`) are in place and gate cleanup eligibility. The reconciliation logic — *"this memory was recalled in session S, did the agent's subsequent work violate it?"* — is deferred to Phase 12. Today, confidence reflects the heuristic + re-extraction stability signal but not actual observed utility.

### Heuristic age thresholds, not adaptive

Aging thresholds (90d for candidate→trashed, 180d for deprecated→trashed, etc.) are config-driven defaults, not adapted to per-memory or per-project signal. A memory with high `getCount` but stale `last_accessed_at` is treated the same as a never-touched candidate of the same age.

---

## Adoption / agent integration

### MCP tool discovery is best-effort

Agents must read tool descriptions and act on them. Even with hardened opinionated descriptions, behavior is inconsistent across agents and across sessions. We mitigate via:

- Briefing-phase memory digest (push-once awareness at session start)
- `ai-cortex memory install-prompt-guide` (writes guidance to CLAUDE.md / AGENTS.md so the agent's system context teaches the recall→get pattern)

…but ultimately the agent decides whether to call the tools. The pull-only architecture means low call rate is the worst case (memory layer dormant), not catastrophic context corruption.

**Claude Code specific: tool schemas are deferred-loaded.** In Claude Code, MCP tool schemas (including ai-cortex's) are not loaded into the agent's context up front — only the tool names appear, and the agent must call `ToolSearch` to fetch a schema before it can invoke the tool. Out of sight = out of mind: even when a memory rule applies, the agent may forget `record_memory` exists because its description isn't in context. Workaround: add a SessionStart hook to your `~/.claude/settings.json` that nudges the agent to preload the ai-cortex schemas via `ToolSearch` at session start, and tell it to prefer ai-cortex over `ls`/`grep`/`rg`. Example:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"RULE: Before any ls/Bash/git codebase exploration, first load ai-cortex MCP tool schemas via ToolSearch with query \\\"select:mcp__ai-cortex__rehydrate_project,mcp__ai-cortex__suggest_files,mcp__ai-cortex__suggest_files_deep,mcp__ai-cortex__suggest_files_semantic,mcp__ai-cortex__blast_radius,mcp__ai-cortex__index_project,mcp__ai-cortex__recall_memory,mcp__ai-cortex__get_memory,mcp__ai-cortex__record_memory,mcp__ai-cortex__deprecate_memory,mcp__ai-cortex__confirm_memory\\\", then call mcp__ai-cortex__rehydrate_project for project orientation. Only fall back to ls/grep/rg after ai-cortex or when ai-cortex is insufficient.\"}}'"
          }
        ]
      }
    ]
  }
}
```

This hook is **not** installed by `ai-cortex history install-hooks` — the harness behavior is Claude Code's, not ai-cortex's, and the nudge is user-side configuration.

### No public adoption telemetry yet

The `logged()` middleware captures every MCP tool call locally, but there's no aggregator that turns that into a per-session histogram. So *"is the agent actually using the tools"* is currently observable only by `tail -f`-ing the MCP log. Phase 11 in the plan addresses this.

---

## Storage & environment

### Cache is local — not shared across machines or users

`~/.cache/ai-cortex/` is per-laptop, per-user. No multi-machine sync, no team sharing. This is a deliberate non-goal (per `docs/shared/product_brief.md`); ai-cortex is per-developer infrastructure, not a shared knowledge base. Cache is worktree-keyed (multiple worktrees of the same repo each get their own cache).

### Cosmetic zsh warning during command substitution on macOS

Capturing the output of memory commands that run embeddings inside zsh on macOS can emit `failed to change group ID: operation not permitted`:

```bash
ID=$(ai-cortex memory promote <some-id>)
# (eval):1: failed to change group ID: operation not permitted
echo "$ID"
# mem-2026-05-02-... (the command succeeded; warning is benign)
```

The command exits 0 and writes correctly. The warning is from zsh's job control reacting to `@xenova/transformers` worker threads being torn down on `process.exit`. Direct invocations (without `$()` capture) are unaffected.

Workarounds:

- Pipe stdout to a file: `ai-cortex memory promote <id> > /tmp/id.txt`
- Suppress stderr: `ID=$(ai-cortex memory promote <id> 2>/dev/null)`
- Use bash instead of zsh for that script

---

## Cross-references

- Roadmap for which limitations have planned phases: [`docs/shared/high_level_plan.md`](./docs/shared/high_level_plan.md)
- Memory layer detail: [`MEMORY_LAYER.md`](./MEMORY_LAYER.md)
- CLI / library reference: [`MANUAL.md`](./MANUAL.md)
- Changelog: [`CHANGELOG.md`](./CHANGELOG.md)

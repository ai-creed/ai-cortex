# Limitations

Use this page to understand where ai-cortex is intentionally bounded or incomplete today.

ai-cortex is designed as a local project knowledge substrate for coding agents. It is not a general code intelligence platform, hosted memory service, or autonomous assistant.

## Language Support

The structural index supports more than one language, but call graph quality varies.

| Language | Current support |
|---|---|
| TypeScript / JavaScript | File index, imports, functions, call graph |
| Python | File index, imports, functions, partial call graph |
| C / C++ | File index, functions, partial call graph |
| Go / Rust | File indexing only; no call graph |
| Other languages | No parser-backed structural analysis |

Python limitations:

- no type inference for arbitrary `obj.method()` calls
- no `__all__` awareness
- no dynamic import tracking for `importlib.import_module(...)` or `__import__(...)`

Dynamic calls, computed method names, and higher-order call targets can remain unresolved. Blast-radius results should be treated as partial when unresolved edges exist.

## File Discovery

`suggest_files` is a relevance ranker, not a replacement for exact search.

Use `suggest_files` before broad exploration. Use `rg`, grep, or direct file reads when you need:

- an exact symbol
- an exact string
- verification after an edit
- exhaustive content search

`suggest_files_semantic` embeds file paths and light metadata, not full file bodies. It is useful for conceptual "which file is about this?" queries. It is not good for "which file mentions this function?" queries.

The first semantic call downloads the local embedding model, currently about 23 MB.

## Memory Extraction

The auto-extractor is heuristic.

It uses structural cues from captured sessions, such as user corrections, imperative language, gotcha-like phrasing, and repeated co-occurrence. It can miss well-phrased decisions that do not match the extractor's patterns.

Explicit memory recording is still the cleanest path for important rules:

```bash
ai-cortex memory record --type decision --title "..." --body-file rule.md
```

There is no hidden LLM extractor in the substrate. If future extraction quality improves with LLM assistance, that work should happen through user-controlled agents or subagents, not hidden hosted calls.

## Memory Recall

Memory recall can be weak on short or abbreviation-heavy queries.

Examples of weaker queries:

- `cxx`
- `cfg`
- `hooks`
- two-word subsystem shorthand

Add a keyword anchor when possible:

```text
cxx adapter
codex hooks pretooluse
release version bump
```

Use `search_memories` when exact text matters more than semantic matching.

## Feedback Loop

ai-cortex tracks memory usage signals such as `get_memory`, access counts, re-extraction counts, and cleanup state.

The full closed loop is not complete: ai-cortex does not yet automatically prove that a recalled memory prevented or failed to prevent a later mistake.

Today:

- `recall_memory` means the agent browsed memory candidates
- `get_memory` means the agent selected one memory to apply
- stats can show adoption patterns
- memory confidence is not a complete observed-utility score

## Edit-Time Surfacing

Edit-time memory surfacing is precision-first and harness-dependent.

Current behavior:

| Harness | Status |
|---|---|
| Claude Code | Supported for edit tools through `PreToolUse` |
| Codex CLI | Supported on Codex >= 0.133.0 for `apply_patch`, but the hook must be trusted (see below) |
| Other agents | Depends on compatible hook support |

The edit-time hook only uses file scope. Tag-only and unscoped memories do not surface through this path, though agents can still find them through `recall_memory`.

Claude Code timeout behavior was verified on 2026-05-19 with Claude Code 2.1.144: timed-out `PreToolUse` hooks failed open, so the edit proceeded. This behavior is not guaranteed by upstream documentation and should be rechecked on major harness changes.

Codex requirements and limits (verified 2026-05-25 on codex-cli 0.133.0):

- Codex skips non-managed hooks until you review and trust them with `/hooks`. The installed surface hook stays inert until trusted, so `ai-cortex hooks install` prints a reminder.
- Trust is pinned to the hook's hash, so any ai-cortex upgrade that changes the hook definition requires re-trusting it in `/hooks`.
- Coverage is narrower than Claude: `PreToolUse` intercepts `apply_patch` (matcher aliases `apply_patch`/`Edit`/`Write`) and simple `Bash`/MCP calls, but not the newer `unified_exec` shell path or non-shell, non-MCP tools (for example `WebSearch`). It is a guardrail, not a complete enforcement boundary.

The earlier "Codex 0.130.0 does not emit `PreToolUse`" finding was a misdiagnosis of the hook-trust gate, not an upstream defect.

Disable edit-time surfacing:

```bash
AI_CORTEX_SURFACE=0
```

## Agent Adoption

MCP tool discovery is best-effort.

Agents must notice, understand, and choose to call ai-cortex tools. The project mitigates this with:

- `rehydrate_project` briefings
- MCP tool descriptions
- `ai-cortex memory install-prompt-guide`
- Claude Code edit-time memory surfacing

But non-edit consultation still depends on the agent calling the tools.

If memory appears dormant, check:

- MCP server registration
- whether the agent can see `recall_memory` and `get_memory`
- whether the prompt guide is installed
- whether hooks are installed for session capture
- whether your memories are scoped too broadly or too weakly titled

## Telemetry Interpretation

Stats are diagnostic, not pass/fail.

`ai-cortex stats sessions` and the stats dashboard can show memory adoption, recall-to-get conversion, surfacing-to-get conversion, and unattributed session share.

These numbers need context. Low memory usage can mean:

- the session did not need memory
- the agent did not discover the tools
- the memory store is noisy
- the query did not match the right memory
- session IDs were not attributable

For interpreting these metrics, see [Adoption Metrics](../shared/adoption-metrics.md).

## Storage And Sync

ai-cortex is local-first.

Current limitations:

- no built-in multi-machine sync
- no team-shared memory store
- no hosted memory service
- cache is per-user and local to the machine

This is deliberate for the current product shape. ai-cortex is developer-controlled project knowledge, not a shared enterprise knowledge base.

## Environment Notes

On macOS with zsh, command substitution around some memory commands can emit a benign warning:

```bash
ID=$(ai-cortex memory promote <id>)
# (eval):1: failed to change group ID: operation not permitted
```

The command succeeds. Workarounds:

```bash
ai-cortex memory promote <id> > /tmp/id.txt
ID=$(ai-cortex memory promote <id> 2>/dev/null)
```

## Related Docs

- [Agent integration](../guides/integrate-with-agents.md): MCP, hooks, and harness behavior.
- [Troubleshooting](../guides/troubleshooting.md): recovery paths for common setup and harness issues.
- [Architecture overview](../architecture/overview.md): system map and architectural boundaries.
- [Language support](./language-support.md): parser-backed language coverage and call graph limits.
- [MCP tools](./mcp-tools.md): agent-facing tool usage.
- [Storage reference](./storage.md): local cache layout and privacy boundary.
- [Roadmap](../roadmap.md): future directions and permanent non-goals.

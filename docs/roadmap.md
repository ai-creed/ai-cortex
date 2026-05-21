# Roadmap

This roadmap describes direction, not commitments.

ai-cortex evolves around one product goal: make developer-controlled project knowledge durable and useful to coding agents without turning the substrate into hidden intelligence.

## Current Foundation

The core substrate is already in place:

| Area | Status |
|---|---|
| Structural project map | Shipped |
| Rehydration briefing | Shipped |
| File suggestion | Shipped |
| Blast-radius analysis | Shipped |
| Session history capture | Shipped |
| `search_history` MCP tool | Shipped |
| Memory layer | Shipped |
| Memory lifecycle and audit | Shipped |
| Project and global memory tiers | Shipped |
| MCP server | Shipped |
| Prompt guide installer | Shipped |
| Stats dashboard and session adoption metrics | Shipped |

The remaining roadmap is about adoption quality, memory quality, and ergonomics.

## Near-Term Direction

### Closed Feedback Loop

Today, ai-cortex records usage signals such as `recall_memory`, `get_memory`, access counts, and re-extraction counts.

The next level is observed utility:

- Was a recalled memory actually applied?
- Did a later user correction show the agent violated a memory?
- Should confidence rise or decay based on behavior?

The goal is for memory confidence to reflect observed usefulness, not just extractor confidence or manual approval.

### Better Memory Extraction

The current extractor is heuristic. It catches useful signal but misses well-phrased decisions that do not match its patterns.

Future direction: use a user-controlled agent or subagent to extract and rewrite better memory candidates.

Constraint: no hidden LLM in the substrate. If LLM-based extraction exists, it should be explicit and run through the user's agent environment.

### Memory Cleanup Workflow

The memory store should stay useful under real use.

Important work:

- easier review of pending captures
- better rewrite workflow for raw candidates
- clearer triage of stale, noisy, or overlapping memories
- stronger visibility into memory health

The cleanup loop should spend attention only on memories that show value.

### Agent Adoption

The biggest practical risk is not storage. It is whether agents actually call the tools.

Current mitigations:

- MCP tool descriptions
- rehydration briefing
- prompt guide installation
- edit-time surfacing for Claude Code
- stats that show adoption behavior

Future work should make agent use more reliable without forcing irrelevant memories into context.

### Wider Agent Integration

ai-cortex should remain agent-agnostic through MCP, but individual harnesses expose different hooks and session metadata.

Likely future work:

- better harness-specific capture support
- better session id attribution
- improved edit-time surfacing where hooks exist
- tighter integration with local agent workspaces such as `ai-14all`

The substrate should stay portable even when specific harnesses get better integration.

### Larger Embedding Model Option

Short and abbreviation-heavy queries can be weak with the current default embedding model.

An opt-in larger model could improve recall for domain-heavy projects.

Tradeoff:

- larger download
- slower first use
- more local storage

This should stay optional.

### Ergonomic Wrapper

The primitives exist, but some users may want a simpler loop:

```bash
ai-cortex ask "what did we decide about auth?"
ai-cortex ask "where is config loaded?"
```

This would wrap existing retrieval, history, and memory operations without changing the substrate.

## Permanent Non-Goals

These are deliberate:

- no hosted ai-cortex service
- no hidden LLM calls
- no autonomous reasoning layer
- no team-shared cache as the default product
- no real-time indexing daemon
- no IDE extension requirement
- no generic vector database abstraction
- no replacement for exact code search tools such as `rg`

## Detailed Planning History

Detailed phase history remains in:

```text
docs/shared/high_level_plan.md
docs/superpowers/
```

`docs/superpowers/` is the detailed spec and plan archive. This roadmap is the reader-facing summary.

## Related Docs

- [Architecture overview](./architecture/overview.md): system map and data flow.
- [Limitations](./reference/limitations.md): current weak spots and harness constraints.
- [Product brief](./shared/product_brief.md): product scope, thesis, and risks.
- [High-level plan](./shared/high_level_plan.md): detailed phase history.

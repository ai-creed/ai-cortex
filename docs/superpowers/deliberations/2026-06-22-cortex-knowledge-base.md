# Deliberation: Cross-project knowledge base on ai-cortex
seed: /Users/vuphan/Dev/ai-cortex/docs/ideas/cortex-knowledge-base.md · 2026-06-22 · Explorer / Challenger

## TL;DR
- Recommended direction (PROPOSAL): ship the no-persistent-index **live doc search** baseline (E) first, instrument whether it is actually used and sufficient (O6), and upgrade to a **per-repo semantic doc index federated across projects** (A) only if recall data justifies the cost. Layer **doc-to-memory distillation** (C) as a complement for authority and memory alignment. Treat a **central doc store** (B) and the **doc graph** (D) as non-leads. Build a shared floor first: a project opt-in set, and a minimal authority/supersession guard.
- Decisions that need you:
  1. **Gitignored-doc policy.** Plans, ideas, and strategy docs (the corpus the seed explicitly wants) are gitignored and invisible to today's indexer. Index them by default, by explicit opt-in, or never? This is a trust/privacy call only the owner can make, and it gates whether the named corpus is in scope at all.
  2. **Authority/supersession guard depth.** Minimal metadata (surface file mtime + `Status:`/version headers + a citation, let the agent judge) versus active stale-decision/conflict detection. This sets how much O5/KU7 work every raw-passage approach must carry.

## Objectives (ratified)
- **O1 - Make doc CONTENT answerable by intent, at passage granularity, with provenance.** Today the file is listed but its content is not semantically queryable; the semantic index embeds file paths only and there is no passage retrieval. [`src/lib/doc-inputs.ts:6-38`, `src/lib/vector-builder.ts:38-42`, `src/lib/briefing.ts:15-20`]
- **O2 - Extend retrieval from one repo to the developer's project set.** The stated product pain is multi-project context-switching; the only cross-project bridge today is manually promoted global memories. [`docs/shared/product_brief.md:13,15`; `src/lib/rehydrate.ts`, `src/lib/suggest.ts` are single-repo]
- **O3 - Position the doc-KB against the memory layer, not on top of it.** The product brief splits the roles: docs show the how/what, memory captures the why. A naive doc-RAG would duplicate or contradict curated memory. [`docs/shared/product_brief.md:25,116`]
- **O4 - Index the corpus as it actually is: heterogeneous and partly gitignored.** Plans/ideas/strategy are gitignored and invisible to the git-based indexer (about 28% of ai-cortex's own docs, including all 25 plans); the `docs/superpowers` convention holds in only 5 of 7 active projects with divergent layouts. [`.gitignore:10-12`, `src/lib/indexable-files.ts:36`]
- **O5 - Honor the trust and architecture contract.** Cache-only (no repo writes), rebuildable derived indexes, freshness-aware so stale rationale is not served as current, no LLM in the substrate, agent-agnostic MCP surface. [`docs/shared/high_level_plan.md:11-19,168-177`; pinned no-write decision]
- **O6 - Instrument doc utility before scaling it.** The pain is asserted, not measured; the project's own playbook (adoption telemetry, Phases 11-12) is to instrument adoption before investing in heavy infrastructure. [`docs/shared/adoption-metrics.md`; `docs/shared/high_level_plan.md` Phases 11-12]

interpretation taken: the seed's open "what could we do" is read as a capability-definition request, so the objectives define the problem space, constraints, and success criteria without picking a build. discarded: a chat-over-docs RAG product (violates substrate-not-product and no-LLM-in-substrate); a team or cloud-shared knowledge base (explicit non-goal in the product brief). kept as a live fork rather than pre-decided: raw-passage retrieval versus distilling docs into memory cards.

## Approaches considered

| Approach | Gist | Grounding/precedent | Key tradeoff | Difficulty |
|---|---|---|---|---|
| **E - Live doc search** | Doc walker + query-time grep, no persistent index; returns cited line/snippet hits | `content-scanner.ts` (budgeted grep w/ line+snippet), `suggest-ranker-deep.ts:97-109` (already wired as rescue path) | Lowest infra and inherent index-freshness, but lexical-only recall and no authority guard | LOW |
| **A - Per-repo index, federated** | Section-parse + embed + FTS per repo; fan out across the opt-in set at query time | history chunk/embed pipeline, `vector-sidecar.ts`, `recallMemoryCrossTier` (+0.10 boost) | Best semantic/passage retrieval, but N-repo fan-out scale and per-repo embedding cost | MEDIUM |
| **B - Central doc store** | One aggregated cross-project corpus ingested ahead of time | global memory tier (`lifecycle.ts:922-998`) as a real cross-project store | Single-index query, no fan-out, but hard invalidation without a watcher and central-aggregation privacy | MED-HIGH |
| **C - Distill to memory** | Extract memory cards from docs; retrieval rides existing recall/surface | Phase 8 extractor (`extract.ts`, `gate.ts`), `promote_to_global`, memory supersession schema | Strongest O3 fit and the only built-in authority guard, but sacrifices O1 raw-passage fidelity and writes to the curated memory store | MEDIUM |
| **D - Lexical + graph** | `docs_fts` table plus a doc node/link graph for navigation | `memory_fts` (`memory/index.ts:106-111`), shipped `cortex graph` builder | Cheapest and deterministic, but FTS misses paraphrase and the graph is a viewer, not an agent retrieval API | HIGH (for agent retrieval) |

- **E** is the floor: it touches only low-blast modules (`content-scanner` has 3 importers), needs no schema change, no sidecar, and not even the shared markdown section parser (a heading-window suffices). Its honest ceilings are lexical recall and authority, both measurable via O6.
- **A** is the natural durable upgrade: thanks to the vector-sidecar pattern it adds a doc index without touching the 54-importer `RepoCache` or bumping the schema, and it reuses the most existing machinery. Its watch-item is fan-out scale (the whole-vector-load cost multiplied by the project-set size).
- **B** removes fan-out latency and makes gitignored inclusion natural, but concentrates the freshness and privacy risk in one ahead-of-time store and tugs against the per-repo and no-daemon principles. Non-lead.
- **C** is the only approach that inherits a supersession guard (memory `supersedes`/`mergedInto`/`deprecated`), so it is the best complement for authority, but as a standalone it loses the cited passage that O1 wants and risks polluting the trust-bearing memory store.
- **D**'s FTS half is cheap, but its graph half feeds a browser showcase (consumed only by `cli/graph.ts` and `graph-server.ts`), not the MCP retrieval surface, so it is mis-aimed for O1. Best framed as navigation/showcase, not the primary retrieval mechanism.

## Recommendation (PROPOSAL - overridable)
Stage the work and let evidence gate the spend:
1. **Slice 1 - E plus the shared floor.** Ship live doc search over an opt-in project set, returning cited passages, with the O6 instrumentation that answers "did the agent retrieve doc context, and did it consult the result?" Include a minimal authority signal (mtime + `Status:`/version header + citation). This is the cheapest path to a useful answer to the seed and directly tests whether anything heavier is warranted.
2. **Slice 2 - A, only if O6 shows lexical recall is the bottleneck.** Add the per-repo semantic doc index and federate it, reusing the embed/sidecar/FTS stack and the cross-tier blend. The sidecar pattern keeps this additive (no schema bump, no forced reindex).
3. **Complement - C where doc rationale should become a durable rule.** Distill selected docs into memory so the authority/supersession machinery applies, linking memory back to the source doc.

Why this over the others: it matches the project's own "instrument before you scale" discipline (O6, Phases 11-12), it spends the least before the pain is measured, and it preserves every durable principle (cache-only, rebuildable, no LLM, MCP, no daemon). B and D are deferred because B fights the per-repo and no-daemon model while adding privacy risk, and D's graph is the wrong surface for agent retrieval.

What the Challenger attacked, and how it held:
- **Missing low-infrastructure baseline.** The Challenger blocked the approaches layer for omitting a no-persistent-index option and grounded it in the existing `content-scanner` idiom. This held: E was added, verified against the code, and is now the recommended first slice rather than an afterthought.
- **Conflated freshness.** The Challenger blocked the tradeoffs layer for treating E's freshness as solved. This held: freshness was split into F1 (index invalidation) and F2 (source authority/supersession), and E now correctly buys only F1. The recommendation prices F2 as shared floor work so the proposal does not over-credit E with satisfying O5 for free.

## Risks
- **Recall ceiling of the E-first slice.** Live lexical grep misses paraphrase; if O6 shows agents asking conceptual questions, E underdelivers and the upgrade to A is on the critical path sooner than hoped.
- **Authority/supersession (F2) is unsolved for every raw-passage approach (A/B/D/E).** A perfectly index-fresh passage can still be superseded or code-stale; `content-scanner` has no such guard. Only C inherits one. Shipping any raw-passage slice without at least the minimal F2 signal risks serving stale decisions as current.
- **Cross-project precision/bleed.** Surfacing project B's convention into project A can create false confidence; the memory-surfacing precision-first lesson applies and there is no measurement of this yet.
- **Fan-out scale (if A ships).** The whole-vector-load cost multiplied by the project-set size is the real scaling risk; the SQLite-resident-vectors direction may be needed as the corpus grows.
- **Gitignored corpus policy is load-bearing.** If plans/ideas stay out, the KB omits much of what the seed wanted; if they go in, a non-git doc walker and a privacy stance are required.

## Open Questions (for you)
- **Gitignored-doc inclusion policy.** Default, opt-in, or never for plans/ideas/strategy? At stake: whether the corpus the seed names is in scope, plus a privacy decision about indexing deliberately-untracked material. Not settled because it is an owner trust preference, not a technical fact.
- **Authority/supersession guard depth (KU-F2).** Minimal metadata versus active conflict detection between docs, and between docs and superseding memories. At stake: how much O5 work every raw-passage approach carries. Partly preference-dependent.
- **Is cross-project (O2) wanted now, or single-repo doc-content first?** The ROI of cross-project infrastructure is asserted, not measured; the staged proposal defers it behind O6, but you may want to confirm the multi-project framing before any cross-repo work.
- **Could not verify - bulk embedding throughput.** No in-repo benchmark exists for embedding the roughly 4k-12k chunks of the corpus on CPU MiniLM. You should confirm the one-time build cost before committing to A/B.
- **Could not verify - exact blast radius.** The `blast_radius` MCP tool only reindexed without returning callers in this environment; blast figures are grep importer-count proxies (directionally reliable, not exact call-graph hops).

## Grounding & confidence (footer)
verified against source: doc handling and the path-only semantic index (`doc-inputs.ts`, `vector-builder.ts`, `briefing.ts`); single-repo retrieval and the global-memory cross-project bridge (`rehydrate.ts`, `suggest.ts`, `memory/lifecycle.ts:922-998`, `retrieve.ts:375-401`); gitignored plans/ideas/strategy and the git-based indexer (`.gitignore:10-12`, `indexable-files.ts:33-56`); the reusable embed/sidecar/FTS/extractor stack (`embed-provider.ts`, `vector-sidecar.ts`, `memory/index.ts:106-111`, `extract.ts`, `gate.ts`); the live-search idiom (`content-scanner.ts`, `suggest-ranker-deep.ts:97-109`); the graph being a viewer (`graph/types.ts`, consumers `cli/graph.ts` + `server/graph-server.ts`); memory supersession schema (`memory/types.ts:58-60`); product vision and durable principles (`product_brief.md:13-17,25`, `high_level_plan.md:11-19,168-177`). · assumed (unverified): bulk-embedding latency is seconds-to-low-minutes one-time; external prior-art claims (local doc RAG, hybrid retrieval, graph retrieval as mainstream) are labeled assumptions and ground none of the candidates. · couldn't verify: exact embedding throughput on this corpus; exact transitive blast radius (tool returned only reindex status, used importer-count proxies).

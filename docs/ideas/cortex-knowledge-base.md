# Deliberation seed: cross-project knowledge base + ai-cortex

Our whole ecosystem lives under `~/Dev/` — ai-whisper, ai-cortex, ai-14all, ai-ezio, ai-creed, ai-samantha, and friends. Every one of these projects accumulates spec, design, plan, and brainstorm documents (the shared convention is `docs/superpowers/specs/` and `docs/superpowers/plans/`, alongside per-project `docs/concepts`, `docs/reference`, `docs/architecture`, etc.). Together these are a large, durable body of knowledge about how the systems work and why decisions were made — exactly the context an agent needs to ramp into any project fast, instead of re-deriving it every time.

ai-cortex is already our memory / knowledge layer. The fuzzy question to deliberate:

**What could we do with ai-cortex and this cross-project document knowledge base?**

How might the spec/design/plan docs scattered across all the `~/Dev/` projects become first-class, queryable context that agents harness on demand — to orient quickly, avoid re-deriving known decisions, and stay consistent across the ecosystem? And what would it actually take to build (indexing, linking docs to ai-cortex memory, retrieval surfaces, freshness/staleness, cross-project scoping)?

(Project-grounded: ai-cortex and these doc conventions already exist across `~/Dev/` today — this is about what to build on top of them, not greenfield.)

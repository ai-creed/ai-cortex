# ai-cortex Documentation

These docs are organized for experienced engineers using coding agents.

Start with the short path, then go deeper only when needed.

## Start Here

- [Getting started](./getting-started.md): install, connect an agent, index a repo, capture sessions, and record a first memory.
- [Mental model](./concepts/mental-model.md): understand the project map, session continuity, explicit memory, and no hidden intelligence principle.
- [Memory model](./concepts/memory-model.md): understand memory types, scope, lifecycle, and recall/use.

## Guides

Task-oriented docs:

- [Integrate with coding agents](./guides/integrate-with-agents.md): configure MCP, hooks, prompt guidance, and harness behavior.
- [Troubleshooting](./guides/troubleshooting.md): recover from setup, cache, MCP, stats, and memory issues.

## Reference

Precise lookup docs:

- [CLI reference](./reference/cli.md): command groups and common flags.
- [MCP tools](./reference/mcp-tools.md): agent-facing tools and when to use each one.
- [Library API](./reference/library-api.md): public Node.js API for structural indexing and analysis.
- [Language support](./reference/language-support.md): parser-backed language coverage and call graph limits.
- [Benchmarking](./reference/benchmarking.md): performance and ranking-quality benchmark suites.
- [Storage reference](./reference/storage.md): cache layout, local-first boundaries, and rebuildable state.
- [Configuration reference](./reference/config.md): environment variables, memory config, and agent config touchpoints.
- [Limitations](./reference/limitations.md): current bounds, weak spots, and harness-specific behavior.

## Architecture

Technical system docs:

- [Architecture overview](./architecture/overview.md): system shape, layers, data flow, and canonical vs derived state.

## Roadmap

- [Roadmap](./roadmap.md): shipped foundation, future directions, and permanent non-goals.

## Historical And Detailed Design Material

These documents are useful for maintainers and agents that need design history:

- [Product brief](./shared/product_brief.md): product scope, thesis, and risks.
- [High-level plan](./shared/high_level_plan.md): detailed phase history and proposed phases.
- `docs/superpowers/`: detailed specs and plans archive.
- `docs/misc/`: older strategy, planning, and spike documents.

The `docs/superpowers/` subtree is intentionally left as the detailed spec archive. User-facing docs should link to curated docs first, then into that archive only when detailed implementation history is needed.

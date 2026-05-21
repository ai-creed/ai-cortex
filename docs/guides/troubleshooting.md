# Troubleshooting

Use this guide when ai-cortex is installed but the local setup is not behaving as expected.

This is recovery-oriented. For the underlying model, see the mental model and reference docs linked at the end.

## Command Not Found

If `ai-cortex` is not available after install:

```bash
npm install -g ai-cortex
ai-cortex --version
```

For a source checkout, build and link the package:

```bash
pnpm install
pnpm build
pnpm link --global
ai-cortex --version
```

If an agent still cannot launch the MCP server, check whether it requires an absolute command path:

```bash
which ai-cortex
```

Use that path as the MCP server command if the agent does not resolve global binaries.

## Missing Source Dependencies

If a source checkout reports a package error such as:

```text
IndexError: Cannot find package 'web-tree-sitter'
```

The checkout is missing dependencies or has not been rebuilt:

```bash
pnpm install
pnpm build
pnpm link --global
```

Then retry the original command.

## Agent Cannot See MCP Tools

First confirm the CLI works:

```bash
ai-cortex --version
ai-cortex mcp --help
```

Then inspect the agent's MCP registration:

```bash
claude mcp get ai-cortex
codex mcp get ai-cortex
```

If registration exists but tools still do not appear:

- restart the agent session after registration
- use an absolute `ai-cortex` path if the harness does not resolve global binaries
- confirm the server command is `ai-cortex mcp`
- ask the agent to call `rehydrate_project` explicitly in the target repo

MCP registration gives the agent the tools. Prompt guidance teaches the agent when to use them.

## Cache Looks Stale

If file suggestions, rehydration, or blast radius output does not reflect recent code changes, refresh the repo index:

```bash
ai-cortex index --refresh /path/to/repo
```

From inside the repo:

```bash
ai-cortex index --refresh
```

Avoid `--stale` unless you explicitly want to read the existing cache without checking freshness.

## Empty Or Partial Blast Radius

If `blast_radius` returns no useful callers, refresh the index first:

```bash
ai-cortex index --refresh /path/to/repo
```

If the response has `confidence: "partial"`, ai-cortex found call sites it could not resolve statically. Common causes:

- higher-order functions
- dynamic dispatch
- computed property names
- framework callbacks that are not directly visible in syntax

The graph is still useful, but it may be incomplete. Inspect `unresolvedEdges` and combine the result with `suggest_files` or direct code search for risky changes.

## History Is Empty

Install hooks once:

```bash
ai-cortex history install-hooks
```

Confirm capture is enabled:

```bash
ai-cortex history on
```

Then start a new agent session. Hooks do not retroactively capture old sessions.

Inspect captured sessions:

```bash
ai-cortex history list
```

If your harness or wrapper can set a session identifier, set `AI_CORTEX_SESSION_ID` consistently so related captures group together.

## Memory Is Not Being Used

Memory usage has two distinct steps:

1. `recall_memory` finds potentially relevant memories.
2. `get_memory` signals that the agent is applying a specific memory.

If agents recall memories but do not use them, install the prompt guide:

```bash
ai-cortex memory install-prompt-guide
```

Then add a direct project instruction if needed:

```text
Before non-trivial edits, call recall_memory. If you use a returned memory,
call get_memory on that memory id before applying it.
```

If a memory is too broad or not surfacing where expected, check its file scope and tags:

```bash
ai-cortex memory list
ai-cortex memory show <memory-id>
```

## Stats TUI Fails In A Non-Interactive Shell

The interactive stats dashboard expects a real terminal:

```bash
ai-cortex stats
```

For scripts, CI smoke checks, or non-interactive shells, use one-shot output:

```bash
ai-cortex stats --once
ai-cortex stats sessions --json
```

## zsh Warning During Command Substitution

On macOS with zsh, capturing some memory command output can emit:

```text
failed to change group ID: operation not permitted
```

The command can still succeed. Workarounds:

```bash
ai-cortex memory promote <id> > /tmp/id.txt
ID=$(ai-cortex memory promote <id> 2>/dev/null)
bash -lc 'ID=$(ai-cortex memory promote <id>); echo "$ID"'
```

## Semantic Search First Run Is Slow

The first semantic file search downloads the local embedding model:

```bash
ai-cortex suggest-semantic "where is release state stored?"
```

After the model is cached, subsequent runs are faster. This does not send repository content to a hosted ai-cortex service.

## Related Docs

- [Getting started](../getting-started.md): first end-to-end setup.
- [Agent integration](./integrate-with-agents.md): MCP, hooks, prompt guidance, and harness behavior.
- [Mental model](../concepts/mental-model.md): how the substrate fits together.
- [Memory model](../concepts/memory-model.md): memory lifecycle, recall, use, and cleanup.
- [CLI reference](../reference/cli.md): command groups and common flags.
- [MCP tools](../reference/mcp-tools.md): agent-facing tool usage.
- [Storage reference](../reference/storage.md): cache layout and local-first boundaries.
- [Limitations](../reference/limitations.md): current bounds and harness-specific constraints.

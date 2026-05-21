# Getting Started

Use this guide when you want to try `ai-cortex` on a real repository with a coding agent.

By the end, your agent should be able to:

- load a project briefing
- ask ai-cortex which files matter for a task
- search prior agent sessions
- recall and apply explicit project memories

## 1. Install

`ai-cortex` requires Node.js 20 or newer.

```bash
npm install -g ai-cortex
ai-cortex --version
```

If you are developing ai-cortex itself, build from source instead:

```bash
git clone git@github.com:ai-creed/ai-cortex.git
cd ai-cortex
pnpm install
pnpm build
pnpm link --global
ai-cortex --version
```

## 2. Index A Project

Pick a git repository you use with coding agents:

```bash
ai-cortex index /path/to/repo
```

This builds a local project map under `~/.cache/ai-cortex/`.

The repository is read, not modified.

## 3. Connect Your Agent

`ai-cortex` exposes its agent-facing tools through MCP.

For Claude Code:

```bash
claude mcp add -s user ai-cortex -- ai-cortex mcp
claude mcp get ai-cortex
```

For Codex CLI, use the command form if available:

```bash
codex mcp add ai-cortex -- ai-cortex mcp
codex mcp get ai-cortex
```

If your Codex version needs an explicit Node entrypoint, see [the agent integration guide](./guides/integrate-with-agents.md#codex-cli).

## 4. Verify The Core Loop

From the repository you indexed, ask your agent to use ai-cortex before scanning files manually.

The expected first calls are:

- `rehydrate_project` for a project briefing
- `suggest_files` for task-specific file discovery
- `blast_radius` before changing a known function

You can also verify from the CLI:

```bash
cd /path/to/repo
ai-cortex rehydrate
ai-cortex suggest "where is configuration loaded?"
```

## 5. Capture Future Sessions

Install hooks once:

```bash
ai-cortex history install-hooks
```

This wires supported agent harnesses so ai-cortex can capture compacted session evidence and make it searchable later through `search_history`.

The hook installer writes to user-level agent configuration files such as `~/.claude/settings.json` and `~/.codex/config.toml`. It creates backups before modifying those files. It does not write into the target repository.

Verify capture is enabled:

```bash
ai-cortex history list
```

## 6. Add Memory Guidance

Install the prompt guide so agents learn the explicit memory pattern:

```bash
ai-cortex memory install-prompt-guide
```

The important rule is:

```text
recall_memory -> get_memory -> apply the rule
```

`recall_memory` is browse-only. `get_memory(id)` is the consult signal that says the agent is applying a specific memory.

## 7. Record One Memory

Record a concrete project rule:

```bash
cd /path/to/repo
ai-cortex memory record \
  --type decision \
  --title "Use pnpm for package management" \
  --body "Rule: Use pnpm for installs and scripts in this repository. Why: The lockfile is pnpm-lock.yaml and CI expects pnpm."
```

Then ask your agent a task where that rule matters. The agent should recall the memory before acting, then call `get_memory` on the memory it plans to use.

## 8. Inspect What Happened

List memories:

```bash
ai-cortex memory list --status active
```

Open the stats dashboard:

```bash
ai-cortex stats
```

The dashboard shows tool call volume, latency, cache behavior, memory health, and local storage footprint.

## Next Steps

- [Mental model](./concepts/mental-model.md): understand the project map, session continuity, explicit memory, and no hidden intelligence principle.
- [Memory model](./concepts/memory-model.md): understand memory types, scope, lifecycle, and recall/use.
- [Agent integration](./guides/integrate-with-agents.md): configure MCP, hooks, and prompt guidance for coding agents.
- [Troubleshooting](./guides/troubleshooting.md): recover from setup, cache, MCP, stats, and memory issues.
- [CLI reference](./reference/cli.md): command groups and common flags.
- [MCP tools](./reference/mcp-tools.md): agent-facing tools and when to use each one.
- [Storage reference](./reference/storage.md): cache layout and local-first boundaries.
- [Configuration](./reference/config.md): environment variables and config files.
- [Limitations](./reference/limitations.md): current bounds, weak spots, and harness-specific behavior.
- [Architecture overview](./architecture/overview.md): technical system map and data flow.
- [Roadmap](./roadmap.md): shipped foundation and future directions.

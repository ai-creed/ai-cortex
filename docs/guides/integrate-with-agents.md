# Integrate With Coding Agents

Use this guide when you want Claude, Codex, or another MCP-capable coding agent to use ai-cortex automatically during work.

ai-cortex integrates through MCP first. Optional hooks add session capture and edit-time memory surfacing where the agent harness supports them.

## Integration Surfaces

There are three separate pieces:

| Surface | Purpose |
|---|---|
| MCP server | Gives the agent tools such as `rehydrate_project`, `suggest_files`, `search_history`, `recall_memory`, and `get_memory` |
| History hooks | Capture compacted session evidence so future sessions can search prior work |
| Prompt guide | Adds the memory consultation rule to agent instructions |

MCP is the core integration. Hooks and prompt guidance improve adoption, but the system still works without them.

## Register The MCP Server

Install ai-cortex globally first:

```bash
npm install -g ai-cortex
ai-cortex --version
```

### Claude Code

Register ai-cortex once at user scope:

```bash
claude mcp add -s user ai-cortex -- ai-cortex mcp
claude mcp get ai-cortex
```

User scope makes the server available across projects.

### Codex CLI

If your Codex version supports `codex mcp add`, use:

```bash
codex mcp add ai-cortex -- ai-cortex mcp
codex mcp get ai-cortex
```

If your Codex version needs an explicit command path, resolve the binary first:

```bash
which ai-cortex
```

Then register that path:

```bash
codex mcp add ai-cortex -- /absolute/path/to/ai-cortex mcp
```

If direct config editing is required, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.ai-cortex]
command = "/absolute/path/to/ai-cortex"
args = ["mcp"]
```

### Other MCP Agents

For other MCP-capable agents, configure a stdio MCP server with:

```text
command: ai-cortex
args: ["mcp"]
```

If the agent requires an absolute executable path, run:

```bash
which ai-cortex
```

Then use that path as the command.

## Verify Agent Access

In a repository you have indexed, start a new agent session and ask it to orient with ai-cortex before scanning manually.

Expected MCP calls:

- `rehydrate_project` at session start
- `suggest_files` before reading files for a task
- `recall_memory` before non-trivial edits
- `get_memory` after selecting a memory to apply

CLI smoke test:

```bash
cd /path/to/repo
ai-cortex rehydrate
ai-cortex suggest "where are release notices generated?"
```

## Install History Hooks

Install hooks once:

```bash
ai-cortex history install-hooks
```

This installs supported capture hooks for Claude Code and Codex CLI. Captures are stored under `~/.cache/ai-cortex/` and can later be searched through `search_history`.

The installer edits user-level agent config files and creates backups first. It does not write into target repositories.

Common files:

| Agent | Config |
|---|---|
| Claude Code | `~/.claude/settings.json` |
| Codex CLI | `~/.codex/config.toml` |

Verify:

```bash
ai-cortex history list
```

Disable capture globally:

```bash
ai-cortex history off
```

Re-enable:

```bash
ai-cortex history on
```

## Install Memory Prompt Guidance

Install the prompt guide:

```bash
ai-cortex memory install-prompt-guide
```

This writes a versioned guidance block for Claude and Codex instructions. The block teaches the agent the explicit memory pattern:

```text
recall_memory -> get_memory -> apply the rule
```

The block is fenced with ai-cortex markers so it can be updated or removed cleanly.

To remove it:

```bash
ai-cortex memory uninstall-prompt-guide
```

## Edit-Time Memory Surfacing

ai-cortex can surface file-scoped memory pointers before edits when the agent harness supports a pre-tool hook.

Current behavior:

| Agent | Edit-time memory surfacing |
|---|---|
| Claude Code | Supported through `PreToolUse` for edit tools |
| Codex CLI | Not currently enabled because Codex 0.130.0 did not emit `PreToolUse` for `apply_patch` or `Bash` in verification |
| Other agents | Depends on whether they expose compatible hooks |

This edit-time path is additive. Agents can still use memory through MCP with `recall_memory` and `get_memory`.

Disable edit-time surfacing:

```bash
AI_CORTEX_SURFACE=0
```

## Practical Agent Instruction

If your agent is not using ai-cortex reliably, add a direct instruction to its project or global guidance:

```text
When working in a git repository, use ai-cortex before broad file exploration:
call rehydrate_project at session start, suggest_files before reading for a task,
recall_memory before non-trivial edits, and get_memory for any recalled memory
you intend to apply.
```

This is especially useful for agents that defer-load MCP tool schemas or do not consistently discover tools on their own.

## Troubleshooting

If the agent cannot see ai-cortex tools:

- confirm `ai-cortex --version` works
- confirm the MCP server is registered in the agent
- use the agent's MCP inspection command, such as `claude mcp get ai-cortex` or `codex mcp get ai-cortex`
- restart the agent session after registering the server
- check whether the agent requires an absolute command path

If session history is empty:

- confirm hooks were installed with `ai-cortex history install-hooks`
- confirm capture is enabled with `ai-cortex history on`
- run at least one new agent session after hook installation
- check [troubleshooting](./troubleshooting.md) and [limitations](../reference/limitations.md) for harness-specific behavior

## What To Read Next

- [Getting started](../getting-started.md): first end-to-end setup.
- [Troubleshooting](./troubleshooting.md): recover from setup, cache, MCP, stats, and memory issues.
- [Mental model](../concepts/mental-model.md): how MCP, history, and memory fit together.
- [Memory model](../concepts/memory-model.md): memory types, scope, lifecycle, and recall/use.
- [CLI reference](../reference/cli.md): command groups and common flags.
- [Configuration](../reference/config.md): environment variables and config files.
- [MCP tools](../reference/mcp-tools.md): agent-facing tools and when to use each one.
- [Limitations](../reference/limitations.md): current harness and adoption constraints.

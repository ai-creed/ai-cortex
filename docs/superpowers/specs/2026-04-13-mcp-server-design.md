# MCP Server Design

**Date:** 2026-04-13
**Status:** approved
**Phase:** 5

---

## Goal

Expose ai-cortex as an MCP (Model Context Protocol) server so AI agents can
automatically load project context and get file suggestions without manual CLI
invocation or CLAUDE.md instruction-following.

Tool descriptions embedded in the schema guide agents to call tools at the right
time — rehydration at session start, suggestions when a task is clear — making
the integration automatic by design.

---

## Context

Current state after Phase 3/4:

- `indexRepo`, `rehydrateRepo`, `suggestRepo` library functions are stable
- CLI (`ai-cortex index`, `rehydrate`, `suggest`) works for manual use
- Pain: agents must be explicitly told to use ai-cortex; sub-agents dispatched
  without full CLAUDE.md context often skip it

MCP is the standard agent integration layer. Tool descriptions travel with the
tools, so agents always know when to call them. No CLAUDE.md maintenance needed.

---

## Architecture

### Module Structure

One new directory added to `src/`:

```text
src/
  lib/          ← unchanged
  cli.ts        ← adds: argv[0] === "mcp" branch → starts MCP server
  mcp/
    server.ts   ← new: MCP stdio server, wires tools to lib functions
```

`server.ts` imports only from `src/lib/index.ts`. All library functions and error
classes (`IndexError`, `RepoIdentityError`) are re-exported from that module, so
no direct import from `src/lib/models.ts` is needed. No new business logic.

### Dependencies

Add two new runtime dependencies:

```
@modelcontextprotocol/sdk   ← MCP server, client, and transport classes
zod                         ← tool input schema validation (required by McpServer.tool())
```

`zod` is a direct dependency of `@modelcontextprotocol/sdk` (per the SDK README),
but must be listed explicitly in `package.json` for direct imports in `server.ts`.

### Entry Point

`src/cli.ts` gets a new top-level branch:

```ts
if (command === "mcp") {
	const { startMcpServer } = await import("./mcp/server.js");
	await startMcpServer();
	// startMcpServer resolves only when the stdio transport closes.
	// No process.exit() here — normal stream-end cleanup is sufficient.
}
```

`server.ts` exports `startMcpServer(): Promise<void>`. The function connects
the server to a `StdioServerTransport` and returns a promise that resolves only
when the transport's readable stream ends (i.e., when the client disconnects).
The process stays alive for the lifetime of the MCP session.

---

## Tools

### `rehydrate_project`

**Description** (shown to agent):

> Load project context for the current session. Call this once at the start of
> any session when working in a git repository. Returns a markdown briefing
> covering project structure, key files, entry points, and recent changes.

**Input schema:**

| Field  | Type   | Required | Default         | Description       |
| ------ | ------ | -------- | --------------- | ----------------- |
| `path` | string | no       | `process.cwd()` | Path to repo root |

**Output:** briefing markdown as a single MCP text content block.

**Behavior:** calls `rehydrateRepo(path)`, returns the content of
`result.briefingPath` as text. Includes cache status in a leading comment line:
`<!-- cache: fresh -->` / `<!-- cache: reindexed -->`.

---

### `suggest_files`

**Description** (shown to agent):

> Get a ranked list of files relevant to a specific task. Call this when you
> have a clear task before reading the codebase — it surfaces the most relevant
> files so you know where to start.

**Input schema:**

| Field   | Type    | Required | Default | Description                           |
| ------- | ------- | -------- | ------- | ------------------------------------- |
| `task`  | string  | yes      | —       | Description of the task               |
| `path`  | string  | no       | cwd     | Path to repo root                     |
| `from`  | string  | no       | —       | Anchor file path for structural boost |
| `limit` | number  | no       | 5       | Maximum results to return             |
| `stale` | boolean | no       | false   | Use cached data even if stale         |

**Output:** same formatted text as CLI human output:

```
suggested files for: <task>

1. src/path/to/file.ts
   reason: matched task terms in path: persistence

2. docs/shared/architecture.md
   reason: doc title/body strongly matches task
```

---

### `index_project`

**Description** (shown to agent):

> Build or force-refresh the project index. Usually not needed —
> rehydrate_project handles freshness automatically. Use this to explicitly
> rebuild after large structural changes.

**Input schema:**

| Field  | Type   | Required | Default | Description       |
| ------ | ------ | -------- | ------- | ----------------- |
| `path` | string | no       | cwd     | Path to repo root |

**Output:** confirmation string, e.g.:
`Indexed 47 files and 12 docs.`

---

## Error Handling

Two-layer error model:

**Layer 1 — server-side input validation (before calling any library function):**
The server validates all inputs before dispatching to the library. Invalid inputs
throw `McpError(ErrorCode.InvalidParams, ...)` directly. Examples:

- `suggest_files`: `task` is missing or blank
- `suggest_files`: `limit` is not a positive integer
- any tool: `path` is provided but is not a string

This ensures `InvalidParams` is always server-generated, never ambiguous.

**Layer 2 — library errors:**

| Library error       | MCP error code  | Notes                            |
| ------------------- | --------------- | -------------------------------- |
| `RepoIdentityError` | `InvalidParams` | Not a git repo or git not found  |
| `IndexError`        | `InternalError` | Pipeline / ranking / I/O failure |
| Other `Error`       | `InternalError` | Message passed through           |

All errors return a structured MCP error response. The server does not crash on
tool errors.

---

## Path Resolution

- All three tools accept an optional `path` parameter
- Default: `process.cwd()` — Claude Code launches MCP servers from the project
  root, so this resolves correctly without the agent passing an explicit path
- Agent may pass an explicit path to override (e.g., when working across repos)

---

## Package Changes (In Scope)

The following `package.json` changes are required and in scope for this phase:

1. Add `bin` entry pointing to the compiled CLI:
   ```json
   "bin": { "ai-cortex": "dist/cli.js" }
   ```
2. Add `@modelcontextprotocol/sdk` to `dependencies` (not devDependencies — it
   is required at runtime by the MCP server).
3. The package remains `private: true`. No npm publish required.

These changes make `node dist/cli.js mcp` the runnable entry point.

## Registration

One-time setup using the local build path:

```
claude mcp add ai-cortex -- node /path/to/ai-cortex/dist/cli.js mcp
```

Or manual entry in `~/.claude/settings.json`:

```json
{
	"mcpServers": {
		"ai-cortex": {
			"command": "node",
			"args": ["/absolute/path/to/ai-cortex/dist/cli.js", "mcp"],
			"type": "stdio"
		}
	}
}
```

The path must be absolute. No global npm install or `npx` required.

---

## Testing

### Unit Tests

**`tests/unit/mcp/server.test.ts`**

Mock all three library functions. Verify:

- `rehydrate_project` calls `rehydrateRepo` with correct path, returns briefing
  content as text
- `rehydrate_project` includes cache status comment in output
- `rehydrate_project` with no path defaults to `process.cwd()`
- `suggest_files` calls `suggestRepo` with correct task + options, returns
  formatted text
- `suggest_files` blank task → server-level `InvalidParams` (library not called)
- `suggest_files` non-integer limit → server-level `InvalidParams` (library not called)
- `index_project` calls `indexRepo` with correct path, returns confirmation string
- `RepoIdentityError` from any tool → MCP `InvalidParams` response
- `IndexError` from any tool → MCP `InternalError` response

### Manual Smoke Test

After registering the server, verify the server itself works:

1. Confirm Claude Code starts the MCP server without errors (check MCP tool list)
2. Call `rehydrate_project` explicitly — confirm it returns a briefing
3. Call `suggest_files` with a task — confirm ranked results are returned
4. Call `index_project` — confirm it returns a file/doc count

Whether the agent calls these tools proactively depends on client and model
behavior, not on the server. That behavior is aspirational and not a pass/fail
criterion for this phase.

---

## Out of Scope

- Streaming output (briefings are small enough for single response)
- Authentication or multi-user support (local-only tool)
- Non-stdio transports (HTTP/SSE) — local tool, stdio is correct
- Resources or prompts MCP features — tools only for now
- Auto-registration on install (requires OS-level hooks outside scope)

---

## Implementation Notes

`server.ts` should be ~100–150 lines. The MCP SDK handles protocol framing,
tool schema validation, and transport. The implementation is:

1. Create `McpServer` instance with name/version
2. Register three tools with `server.tool(name, description, schema, handler)`
3. Connect to `StdioServerTransport`
4. Export `startMcpServer` that creates and connects the server

No session state needed — each tool call is stateless (library handles caching).

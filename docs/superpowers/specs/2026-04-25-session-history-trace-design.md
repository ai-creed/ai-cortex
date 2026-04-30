# Session History Trace — Slice 1 Design

**Date:** 2026-04-25
**Status:** draft
**Slice:** 1 of N (capture + compact + search)

---

## Goal

Preserve agent session history locally in compacted form and expose an MCP tool that searches it, so context lost to harness compaction can be revived on demand without re-asking the user or re-deriving from scratch.

This slice ships the smallest viable surface — capture + compaction + a single search tool. Trace and recall tools are deferred to later slices, contingent on real-world pull.

---

## Context

Claude Code (and similar agent harnesses) auto-compact prior messages as the context window fills. Compaction discards detail that later turns out to matter — a clarification the user gave, a decision made mid-task, a file path referenced once. Current workaround: re-ask or re-derive. Both waste turns.

ai-cortex already owns the "persistent-knowledge-outside-repo" niche (cache in `~/.cache/ai-cortex/<repoKey>/`). Session history is the same shape of problem: knowledge that belongs to the agent workflow, not the target repo, and should survive across compactions and sessions.

Existing assets we extend:

- `src/lib/cache-store.ts` — `~/.cache/ai-cortex/<repoKey>/` layout
- `src/mcp/server.ts` — MCP tool registration pattern
- Xenova MiniLM L6 v2 sentence-embedding model already in tree (used by `suggest_files_semantic`)
- CLI entry point `src/cli.ts` already supports subcommands

---

## Architecture

### Module Structure

```text
src/
  lib/
    history/
      capture.ts        ← reads .jsonl, produces session record
      compact.ts        ← three-tier compaction (summary, evidence, raw)
      store.ts          ← per-session dir I/O (session.json, chunks.jsonl, vectors, lock)
      search.ts         ← session/project scoped retrieval
      session-detect.ts ← current-session detection (env var → arg → mtime fallback)
      config.ts         ← env var + flag-file resolution (enabled, retention)
      hooks-install.ts  ← Claude Code settings.json safe-edit
  mcp/
    server.ts           ← register search_history tool, emit first-call notice
  cli.ts                ← add: history install-hooks / off / on / prune
```

Files are split so each module has a single responsibility and stays small enough to hold in context. `capture.ts` does I/O on the harness transcript; `compact.ts` is pure transformation; `store.ts` owns the on-disk layout; `search.ts` owns retrieval ranking. `search.ts` is the only reader of all three; capture pipeline writes through `compact` → `store`.

### Capture Pipeline

Single pipeline regardless of trigger:

```
.jsonl on disk → capture.read() → compact.transform() → store.append()
```

Triggers:

- **Hook (preferred):** Claude Code `PreCompact` and `SessionEnd` hooks invoke `ai-cortex history capture --session <id>`. The CLI runs the pipeline once and exits.
- **Lazy fallback:** First MCP `search_history` call in a session checks for unprocessed `.jsonl` content; if present, runs the pipeline before searching.

Both paths use the same code. The hook is just an early "warm the cache" signal.

### Session Selection

Two distinct concerns:

**A. Caller specifies a session explicitly** — the `sessionId` argument on `search_history` is a true override. If set, that session is used regardless of any env var or heuristic. This lets agents search a specific past session even when the MCP process has a current-session env var injected at launch.

**B. Caller asks for the current session** — when `sessionId` is unset and `scope="session"`, the server resolves "current session" through this harness-agnostic chain (highest precedence first):

1. **`AI_CORTEX_SESSION_ID` env var** — canonical, harness-neutral. Any agent harness can opt in by setting this at MCP server launch. Recommended path going forward.
2. **Known-harness env vars** — opportunistic scan, in order: `CLAUDE_SESSION_ID`, `CODEX_SESSION_ID`, `CURSOR_SESSION_ID`. The list is data, easy to extend as new harnesses surface. Picks the first one set. ai-cortex never favors a single harness in code paths or behavior.
3. **Most-recent-mtime heuristic** — last resort. Scans the harness-appropriate transcript directory (Claude Code: `~/.claude/projects/<encoded-cwd>/`; other harnesses: not implemented in v1, returns null) and picks the newest transcript file. Logs a warning so the user knows they're on the fallback path.

**Failure mode:** if `scope="session"` and the chain resolves to nothing, `search_history` returns an explicit error in the response: "could not detect current session; pass sessionId, set `AI_CORTEX_SESSION_ID`, or use scope=project". No silent fallback to project scope — silent broadening would surprise the user.

**Wiring per harness:**

- **Claude Code:** the `install-hooks` command additionally writes an MCP server env entry (`"env": { "AI_CORTEX_SESSION_ID": "$CLAUDE_SESSION_ID" }`) to `~/.claude/settings.json` if Claude Code's MCP launcher supports env interpolation; otherwise the opportunistic-fallback path catches `CLAUDE_SESSION_ID` directly. Either way, no per-session manual setup.
- **Codex / Cursor / etc.:** documented as "set `AI_CORTEX_SESSION_ID` in your MCP launch config" until those harnesses' env conventions land in the known-harness list.

---

## Three-Tier Compaction

Each captured session becomes a record with three layers, all stored together.

### Layer 1: Summary

The harness's own compact summary, lifted from `.jsonl` post-compaction entries. Free — no LLM call by ai-cortex. Provides semantic anchor for "what did we talk about" queries.

If a session has no harness compaction (short session, no compact event), this layer is empty — search falls back to evidence + raw.

### Layer 2: Evidence (rule-based extraction)

Deterministic facts pulled from each turn:

- **Tool calls:** name + a single string argument summary. For Read/Write/Edit/Glob/Grep: the target path or pattern. For Bash: first 120 chars of `command`. For others: empty string (just the tool name) until expansion surfaces a need.
- **File paths:** every path that appears in tool args or matches a path-like regex in user/assistant text
- **User prompts:** verbatim text of every user turn
- **User corrections:** user turns whose first 5 tokens match `/^(no|stop|don't|wait|actually|instead|but)\b/i`, flagged separately for high-signal retrieval

Evidence is high-precision. Lookup queries like "what files did we touch in this session" or "what corrections did the user make" hit this layer first.

Expansion path (deferred): errors/exceptions, slash commands invoked, decision markers, git operations, URLs. Schema designed to admit new evidence types without migration.

### Layer 3: Raw chunks + embeddings

Each session's transcript is split into ~512-token chunks. Each chunk gets embedded with the existing Xenova MiniLM model. Embeddings are persisted via the existing `writeVectorIndex` / `readVectorIndex` helpers in `src/lib/vector-sidecar.ts`, which produce `.vectors.bin` + `.vectors.meta.json` per directory and validate model name, dimension, count, and byte size on read. Chunk text itself is stored separately in `chunks.jsonl` (see Storage Layout) so semantic hits can return the actual text without depending on the harness `.jsonl` still existing.

Provides semantic recall for "what exactly did we say about X" queries when the summary is too coarse.

---

## Storage Layout

History lives under the existing versioned cache root. Path is computed via `getCacheDir(repoKey)` from `src/lib/cache-store.ts` (currently resolves to `~/.cache/ai-cortex/v1/<repoKey>/`); history dir = `path.join(getCacheDir(repoKey), 'history')`. Spec stays correct if the cache root version bumps.

Per-session subdirectory layout:

```text
<getCacheDir(repoKey)>/history/
  sessions/
    <sessionId>/
      session.json         ← summary + evidence + chunk metadata + session-level fields
      chunks.jsonl         ← chunk text, one JSON line per chunk
      .vectors.bin         ← chunk embeddings (existing vector-sidecar format)
      .vectors.meta.json   ← model name + dim + count + entries (existing format)
```

Each session = one directory. Listing sessions = `readdir(sessions/)` filtered to entries with a `session.json` inside. No central manifest, no read-modify-write contention. If listing performance ever matters (>>1000 sessions per project), an append-only `manifest.jsonl` can be added later as a derived index — but v1 ships without it.

**`session.json` shape:**

```json
{
	"version": 1,
	"id": "abc123",
	"startedAt": "2026-04-24T08:30:00Z",
	"endedAt": "2026-04-24T09:45:00Z",
	"turnCount": 42,
	"lastProcessedTurn": 42,
	"hasSummary": true,
	"hasRaw": true,
	"rawDroppedAt": null,
	"transcriptPath": "/Users/u/.claude/projects/-foo/abc123.jsonl",
	"summary": "string from harness compact, or empty",
	"evidence": {
		"toolCalls": [{ "turn": 3, "name": "Read", "args": "src/foo.ts" }],
		"filePaths": [{ "turn": 3, "path": "src/foo.ts" }],
		"userPrompts": [{ "turn": 0, "text": "..." }],
		"corrections": [{ "turn": 7, "text": "no, use the other one" }]
	},
	"chunks": [
		{
			"id": 0,
			"tokenStart": 0,
			"tokenEnd": 512,
			"preview": "first 80 chars..."
		}
	]
}
```

`hasSummary` / `hasRaw` / `rawDroppedAt` move from the (deleted) manifest into the session record itself, so each session is self-describing. `transcriptPath` records where the source `.jsonl` was at capture time (informational; not relied on for chunk text reconstruction).

**`chunks.jsonl` shape:** one JSON object per line, e.g.:

```jsonl
{"id":0,"text":"...full chunk text..."}
{"id":1,"text":"..."}
```

Chunk text retrieval: parse `chunks.jsonl`, find line by id (linear scan; fine at expected chunk counts of <100 per session). When raw retention expires, this file and the two `.vectors.*` files are deleted. `session.json` updates `hasRaw: false`, `rawDroppedAt: <ts>`, and clears `chunks` to `[]`. The `preview` strings inside evidence-tier results survive only via the evidence layer, not the chunks list.

**Embeddings:** use `writeVectorIndex` / `readVectorIndex` from `src/lib/vector-sidecar.ts`, which validate model name, dimension, count, and byte size. Each session directory has its own pair of `.vectors.bin` + `.vectors.meta.json` (the helpers use fixed filenames per directory, so per-session dirs are required for isolation — also why each session is its own subdir, not a flat file).

**Row-to-chunk mapping in vector metadata.** The existing `SidecarEntry` schema is `{ path: string, hash: string }`. History reuses it with this convention:

- `path: "chunk:<id>"` — `<id>` is the chunk id, sequential from 0
- `hash: sha256(chunkText)` — used for staleness detection (if chunks.jsonl text changes, hash mismatch invalidates the row)
- Row order in `.vectors.bin` matches `entries[]` order. With sequential ids, row `i` = chunk `i`.

A small helper in `src/lib/history/store.ts` wraps `writeVectorIndex` / `readVectorIndex` to encode/decode this convention so callers work in chunk-id space, not entry-path space. No changes to `vector-sidecar.ts`.

**Concurrency: single-writer per session.** Multiple capture triggers may target the same session at once: PreCompact hook, SessionEnd hook, and the MCP server's lazy fallback can all fire in overlapping windows for one session. Same-session capture is read-modify-write (uses `lastProcessedTurn` to skip already-processed turns), so concurrent writers would corrupt session.json or duplicate work.

Resolution: per-session lock with skip-on-conflict.

- Lock file: `sessions/<sessionId>/.lock`, created via `fs.openSync(path, 'wx')` (atomic O_EXCL on POSIX).
- File contents: `{ pid, startedAt }`.
- Capture acquires lock at start; if `EEXIST`, it logs "capture in progress for <sessionId>, skipping" and exits cleanly. Captures are idempotent — the in-flight writer will pick up everything new on its next poll, or the next trigger will re-attempt.
- Stale lock: if existing lock's `pid` is not alive (`process.kill(pid, 0)` throws ESRCH) or `startedAt` is older than 10 minutes, the new capture steals the lock (overwrites + proceeds). 10 minutes is a generous bound — full-transcript capture should finish in seconds even on long sessions.
- Lock released on normal exit and on caught signals (SIGINT/SIGTERM); a process crash leaves a stale lock that the next run reclaims via the rules above.

Per-file safety inside the lock:

- `session.json` writes use write-temp + rename (mirrors `vector-sidecar.ts` pattern).
- `chunks.jsonl` is append-only — opened with `O_APPEND`. Writes within `PIPE_BUF` (4096 bytes on Linux/macOS) are atomic; chunk lines easily fit.
- `.vectors.bin` + `.vectors.meta.json` go through the existing `writeVectorIndex` helper, which already does write-temp + rename.

Cross-session writes have no contention regardless of locks: session ids are unique per Claude Code window, so different sessions touch different directories.

---

## Search Tool

### `search_history`

**Description** (shown to agent):

> Search compacted history of past agent sessions in this project. Defaults to the current session. Use this to recover context lost to harness compaction (decisions, file paths, user corrections, prior discussion). Auto-broadens to whole project if the current-session search returns nothing.

**Input schema:**

| Field       | Type   | Required | Default         | Description                       |
| ----------- | ------ | -------- | --------------- | --------------------------------- |
| `query`     | string | yes      | —               | Search query (semantic + lexical) |
| `sessionId` | string | no       | —               | Specific past session to search   |
| `scope`     | string | no       | `"session"`     | `"session"` or `"project"`        |
| `limit`     | number | no       | 10              | Max results                       |
| `path`      | string | no       | `process.cwd()` | Project root                      |

**Behavior:**

1. Resolve target sessions:
   - `sessionId` set → that one session
   - else `scope="session"` → current session via the resolution chain (env var → heuristic). If chain returns nothing, return the explicit error response described in _Current Session Detection_.
   - else `scope="project"` → all sessions in this project's history
2. Run hybrid retrieval: lexical match against evidence (file paths, user prompts, corrections) + cosine similarity against chunk embeddings (where raw exists) + lexical match against summary text.
3. Merge + rank by combined score (rule-based weights, no learned model in v1).
4. If `scope="session"` resolved a session **but** that session returned zero hits, auto-broaden to `project` and mark in response. (Distinct from the can't-detect-session failure mode above; this is "session known, just no match.")

**Output:** structured text, one entry per result:

```text
[session abc123 · 2026-04-24 · turn 17 · evidence:correction]
> no, use the other middleware

[session def456 · 2026-04-22 · turn 8 · raw chunk]
preview: "we decided to swap the auth middleware for..."
score: 0.78

(broadened to project scope: current session had no matches)
```

The `(broadened ...)` line only appears when auto-broaden fired.

### First-Call Notice

The MCP server tracks the first invocation of `search_history` per server lifetime (not all tools — the notice is about history capture, which only `search_history` engages with). On that first call:

- If history capture is enabled: prepend a one-line notice to the response: `<!-- history: capture active. disable with AI_CORTEX_HISTORY=0 or 'ai-cortex history off'. install hooks for best results: 'ai-cortex install-hooks'. -->`
- If history is disabled: prepend `<!-- history: capture disabled. enable with AI_CORTEX_HISTORY=1 or 'ai-cortex history on'. -->`

Per-session tracking lives in process memory of the MCP server (resets each restart). Cheap, no persistence.

---

## Configuration

Single resolution order (highest precedence first):

1. Environment variable: `AI_CORTEX_HISTORY=0` / `1`
2. Flag file: `path.join(os.homedir(), '.cache', 'ai-cortex', 'v1', 'history-disabled')` (presence = off; lives at the cache root, not per-project)
3. Default: enabled

Retention configurable via:

1. Environment variable: `AI_CORTEX_HISTORY_RAW_DAYS=<n>` (clamped 0–90; 0 = no raw retention)
2. Default: 30

CLI helpers (one-shot, no daemon):

| Command                                         | Effect                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ai-cortex history off`                         | Touch the cache-root flag file (path above)                                                                      |
| `ai-cortex history on`                          | Remove flag file                                                                                                 |
| `ai-cortex history install-hooks`               | Edit `~/.claude/settings.json` to add Claude Code `PreCompact` + `SessionEnd` hooks; print diff; require confirm |
| `ai-cortex history uninstall-hooks`             | Reverse of install                                                                                               |
| `ai-cortex history capture --session <id>`      | Run pipeline once for a session (called by hook)                                                                 |
| `ai-cortex history prune --before <YYYY-MM-DD>` | Drop sessions older than date                                                                                    |
| `ai-cortex history list`                        | List sessions by reading `sessions/` (id, dates, hasRaw flag)                                                    |

---

## Hook Installation

`install-hooks` edits `~/.claude/settings.json`. Behavior:

1. Read existing file (or treat empty as `{}`).
2. Compute target settings: add to `hooks.PreCompact` and `hooks.SessionEnd` an entry that runs `ai-cortex history capture --session $CLAUDE_SESSION_ID` (variable substitution per Claude Code hook docs).
3. Write a backup to `~/.claude/settings.json.bak.<timestamp>`.
4. Print a unified diff.
5. Prompt for confirmation (skip prompt if `--yes`).
6. Write atomically (write-temp, rename).

If the user already has a hook for either event, append (don't replace). Idempotent: running `install-hooks` twice does not duplicate entries.

`uninstall-hooks` removes only entries we added (matched by command string).

---

## Error Handling

Three error surfaces:

**Capture errors** (CLI subcommand): log to stderr, exit non-zero, do not crash the MCP server. Hook fires are independent processes; failure here doesn't affect the running Claude Code session.

**Search errors** (MCP tool): mapped to MCP error codes:

| Failure                           | MCP error code  | Notes                                       |
| --------------------------------- | --------------- | ------------------------------------------- |
| `query` blank or missing          | `InvalidParams` | Server-validated before lib call            |
| `scope` not one of allowed values | `InvalidParams` | Server-validated                            |
| `path` not a git repo             | `InvalidParams` | Reuses existing `RepoIdentityError` mapping |
| Storage I/O failure               | `InternalError` |                                             |
| Embedding read failure            | `InternalError` |                                             |

**Hook install errors** (CLI subcommand): refuse to write if existing settings.json fails to parse; exit non-zero with explanation. Backup always written before any modification attempt.

---

## Privacy

- Capture is **on by default** but local-only — nothing leaves the machine.
- First-call notice in every session surfaces both the active state and the off-switch.
- Disable is **one command or one env var** — high affordance.
- When disabled: capture pipeline short-circuits before any read; no `.jsonl` access, no writes.
- Existing captured data is not auto-deleted on disable. Users prune explicitly via `ai-cortex history prune` or by deleting `path.join(getCacheDir(repoKey), 'history')`.

---

## Retention

Tiered:

- **Days 0–N (default 30, max 90):** full record retained — summary + evidence + chunks + embeddings
- **Day N+1 onward:** raw chunks + embeddings dropped; summary + evidence kept indefinitely
- Pruning runs lazily at capture time (cheap; readdir over `sessions/`, for each session past the raw window: delete `chunks.jsonl` + `.vectors.bin` + `.vectors.meta.json`, then update `session.json` to set `hasRaw: false`, `rawDroppedAt: <ts>`, `chunks: []`)
- Manual `ai-cortex history prune --before <date>` for full removal

When raw is dropped, search across that session uses summary + evidence only. Search response marks results from evidence-only sessions: `[session abc123 · raw pruned]`.

---

## Testing

### Unit Tests

**`tests/unit/lib/history/capture.test.ts`**

- Reads a fixture `.jsonl`, produces expected raw turns
- Skips already-processed turns (idempotency via stored `lastProcessedTurn`)
- Handles malformed JSON line gracefully (skip + log)

**`tests/unit/lib/history/compact.test.ts`**

- Extracts tool calls from assistant turns with tool_use blocks
- Extracts file paths from Read/Write/Edit tool args
- Extracts user prompts verbatim
- Flags corrections matching the regex; does not flag false positives like "actually we did X" mid-sentence (regex is anchored to first 5 tokens)
- Lifts harness summary entries from `.jsonl` (skips synthetic compact markers when no summary present)

**`tests/unit/lib/history/store.test.ts`**

- Writes session.json + chunks.jsonl + .vectors.bin + .vectors.meta.json under `sessions/<sessionId>/`
- `readSession(id)` round-trips the same record that was written
- `listSessions()` returns ids by reading `sessions/` directory entries (no manifest)
- `listSessions()` skips entries missing `session.json` (e.g. partial writes)
- Embeddings written via `writeVectorIndex` with `path: "chunk:<id>"` + `hash: sha256(text)` convention; read back yields chunks in id order
- `readVectorIndex` returns null when model name mismatches (model upgrade triggers re-embed, not corruption error)
- Stale chunk text (hash mismatch on read) flagged as stale, not silently served
- `getChunkText(sessionId, chunkId)` returns the text from chunks.jsonl
- `getChunkText` returns null when chunks.jsonl absent (raw retention expired)
- Pruning a session removes chunks.jsonl + .vectors.\* and updates session.json (`hasRaw: false`, `chunks: []`)
- Two parallel writes to different sessions do not collide (verified by writing concurrently)
- Same-session lock: first writer acquires; second writer sees lock and exits cleanly with skip log
- Stale lock recovery: lock with dead pid is stolen by next writer
- Stale lock recovery: lock older than 10 minutes is stolen even with live pid
- Lock released on normal exit; absent after run completes

**`tests/unit/lib/history/search.test.ts`**

- Session scope returns only target session's hits
- Empty session-scope result auto-broadens to project, response marks broadening
- Explicit `scope=project` searches all sessions, no auto-broaden marker
- Lexical match on evidence ranks above semantic-only match on chunks (evidence is higher-precision)
- Evidence-only session (raw pruned) still searchable, marked in result
- `sessionId` argument bypasses scope logic

**`tests/unit/lib/history/session-detect.test.ts`**

- Returns `AI_CORTEX_SESSION_ID` when set (canonical primary path)
- Falls through to known-harness scan when canonical unset; picks `CLAUDE_SESSION_ID` if present, then `CODEX_SESSION_ID`, etc., in declared order
- `AI_CORTEX_SESSION_ID` takes precedence over harness-specific vars when both set
- Falls back to most-recent-mtime when no env var present, logs warning
- Returns null (not a guess) when directory missing or empty — caller decides how to surface
- Tolerates non-`.jsonl` siblings in heuristic path
- Heuristic disabled cleanly for non-Claude-Code harnesses in v1 (no crash, just null)

(Note: explicit `sessionId` is handled at the search-tool layer as an override that bypasses this chain entirely; not tested here.)

**`tests/unit/lib/history/config.test.ts`**

- Env var overrides flag file
- Flag file overrides default
- `RAW_DAYS` clamped to 0–90 with sane defaults on garbage input

**`tests/unit/lib/history/hooks-install.test.ts`**

- Adds entries to empty settings.json
- Appends to existing hooks without duplicating
- Uninstall removes only our entries (matched by command string)
- Backup written before any modification

**`tests/unit/mcp/search-history.test.ts`**

- Tool registered with correct schema
- Blank query → `InvalidParams` (server-validated)
- Invalid scope value → `InvalidParams`
- Result formatting matches expected text output
- First-call notice prepended once per server lifetime

### Integration Tests

**`tests/integration/history-pipeline.test.ts`**

- Fixture `.jsonl` → run capture CLI → search returns expected hits
- Run capture twice on same `.jsonl` → store unchanged (idempotency via `lastProcessedTurn`)
- Hook install → simulated PreCompact event → capture runs → search hits the new content
- Two concurrent capture invocations on same session: one acquires lock and writes, the other skips cleanly; final state matches single-writer outcome
- Capture interrupted (process killed mid-write) → next capture reclaims stale lock and resumes from `lastProcessedTurn`

### Manual Smoke Test

1. Install hooks: `ai-cortex history install-hooks`
2. Run a real Claude Code session that triggers `/compact`
3. Confirm `getCacheDir(repoKey)/history/sessions/<sessionId>/` populates with session.json + chunks.jsonl + .vectors.\*
4. Call `search_history` for content from before the compact — confirm result returned
5. Disable: `ai-cortex history off`. Confirm subsequent capture skipped, MCP tool returns disabled notice.
6. Re-enable. Run `ai-cortex history prune --before 2026-04-01`. Confirm targeted sessions removed.

---

## Out of Scope (this slice)

- `trace_history` and `recall_session` MCP tools — deferred until search shows pull
- Cross-project search (`scope=all`) — not a real use case per brainstorm
- Codex / Cursor / other harness hooks — Codex's hook surface is incomplete; lazy fallback covers them
- LLM-based summarization — adds API key dependency; rule-based + harness summary is sufficient for v1
- Sharing history across machines — local only
- Editing or replaying past sessions — read-only archive
- Replacing harness-native memory — complementary, not competitive
- Web UI / inspector for history — CLI `history list` is the v1 affordance

---

## Risks and Open Verifications

These need verification during implementation, not assumed:

1. **Session env var availability per harness.** Spec relies on the resolution chain finding _some_ session id (canonical `AI_CORTEX_SESSION_ID` or known-harness `CLAUDE_SESSION_ID` / `CODEX_SESSION_ID` / etc.) in the MCP server process environment at launch. If a harness only exposes session id to hooks (not MCP processes), the chain falls through to argument or heuristic on every call. Verify per harness via `printenv` from inside an MCP server invocation. If absent, escalate to: agents pass `sessionId` explicitly, or `install-hooks` writes a per-session marker file the MCP server reads.
2. **PreCompact hook existence.** Spec assumes Claude Code exposes a `PreCompact` hook event with access to `$CLAUDE_SESSION_ID`. If the hook name differs or the variable isn't available, fall back to `SessionEnd` only and update install-hooks accordingly.
3. **Harness summary entries in `.jsonl`.** Spec assumes the harness writes its compact-output summary back into the `.jsonl` after compaction. If it lives elsewhere (separate file, in-memory only), Layer 1 needs a different source. Verify by triggering `/compact` and inspecting the file.
4. **Encoded path convention.** Spec assumes `~/.claude/projects/<encoded-path>/` uses a documented `/` → `-` replacement. Used only by the fallback heuristic, but verify before relying on it for the warning path.
5. **Embedding throughput.** Per-session full-transcript embedding may be slow on long sessions. If unacceptable, capture pipeline should embed asynchronously (write session.json + chunks.jsonl first, embed in background process). Measure first.
6. **Session listing scale.** v1 lists sessions by `readdir(sessions/)` and lazy-parses session.json on demand. At expected scale (tens to low hundreds of sessions per project) this is fine. If a project hits >>1000 sessions, add an append-only `manifest.jsonl` (one line per session, written when session is sealed) as a derived index. No eager addition — measure first.
7. **Hook install on shared `~/.claude/settings.json`.** Multiple tools may want to register hooks. Ensure our edit is additive, namespaced, and unambiguously removable. Diff + confirm prompt is the safety net.
8. **Cache sharing across worktrees.** `repoKey` is derived from git repo identity, so multiple worktrees of the same repo share the history root. Per-session subdirectories isolate session state; session ids differ per Claude Code window, so no cross-write contention. The no-manifest design eliminates the prior lost-update concern.

These items don't block the spec — they're items for the implementation plan to address with concrete checks.

---

## Implementation Notes

- All new modules under `src/lib/history/` should stay under ~150 lines each. If a file approaches 200 lines, that's a signal to split.
- No new runtime dependencies expected — diff/JSON tools use Node built-ins; embedding model already in tree.
- Add one CLI subcommand group (`ai-cortex history <action>`) to keep the surface coherent.
- TDD throughout: write the test fixture (small `.jsonl` with ~10 turns) first; build the pipeline against it.
- Benchmark gap noted: there's no quality benchmark for history retrieval yet. Implementation should write at least one fixture-based recall@k smoke test as a starting baseline; full benchmark is a follow-up.

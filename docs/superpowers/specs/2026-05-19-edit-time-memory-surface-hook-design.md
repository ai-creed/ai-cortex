# Edit-time memory surfacing via PreToolUse hook — design

**Date:** 2026-05-19
**Status:** design — phased; see §11
**Scope:** new `memory surface-hook` CLI subcommand; `hooks-install.ts` (Claude + Codex PreToolUse); a `apply_patch` patch-body parser; per-session dedup ledger under the cache.

---

## 1. Context & problem

Agents write to the memory store reliably but read from it unreliably. Memories that capture conventions, gotchas, and past decisions exist, yet agents repeatedly ship code that violates them, because the recall path is opt-in and the agent must remember to opt in.

Observed failure modes:

- Agent edits code without ever calling `recall_memory` → ships against a documented convention.
- Task phrasing doesn't match memory keywords → `suggest_files` / `relatedMemories` misses, nothing surfaces.
- Agent calls `recall_memory` (browse-only) but skips the `get_memory(id)` follow-up → memory "seen" but not registered as used; the access counter never moves and aging cleanup eventually purges still-relevant rules.
- Subagents dispatched mid-session start with no memory context.
- Agent rationalizes skipping ("this is just git mechanics", "I already know what to search for").

Existing mitigations are all pull-flavored and insufficient: CLAUDE.md docs don't scale; the SessionStart reminder nudges the *tool*, not the *memory*; search tuning only helps once queried; post-hoc correction is too late. A surfacing engine already exists (`matchMemoriesCrossTier`, wired into `suggest_files*` via `attachRelatedMemories`) but it is **embedding-based and cross-tier** (project + global, needs a task vector). This hook does **not** reuse it: the edit-time path is a deterministic, project-tier, `scopeFiles`-only match (no embedding, no model load — see §3.4, §4). The gap it fills is that nothing invokes any surfacing before the agent acts on a file.

## 2. Goals & non-goals

### Goals

- Before any file edit, unconditionally place pointers to that file's scoped memories into the agent's context — no agent discretion in whether surfacing happens.
- Stay precision-first: surface only deterministic, author-declared `scopeFiles` matches (literal or glob). Silent when nothing matches.
- Preserve the recall→get usage-signal contract: surfacing must NOT mutate `getCount` or `last_accessed_at`. Only `get_memory(id)` does.
- Work for both Claude Code and Codex CLI via their respective `PreToolUse` hooks, with a single shared output contract.
- Never block or break an edit: every failure path allows the edit silently.
- Bound context noise: surface a given (file, memory-set) once per session.

### Non-goals

- **Enforcing consumption.** The hook never requires `get_memory` to proceed. It enforces *visibility*, not *consumption* (see §3.2).
- **Pushing memory bodies.** Pointers only (id + title + type). Bodies are pulled on demand via `get_memory`.
- **Semantic / tag / embedding matching at the gate.** v1 is `scopeFiles` literal+glob only. No model load in the hook path. Tag/semantic surfacing is deferred, not rejected.
- **Global-tier memories.** v1 edit-time surfacing is **project-tier only** — the gate is `scopeFiles` (project-relative paths), and global memories are predominantly unscoped/tag, so a file-scope gate is inherently project-tier. Global rules reach the agent via the unchanged pull-on-`suggest_files` cross-tier path. Including global memories at the edit-time gate is deferred with the semantic/tag path.
- **Replacing pull-on-`suggest_files`** (2026-05-06 spec). The two coexist; this spec governs only the edit-time path.
- **Runtime harness-version detection.** Older Codex simply never fires the hook for edits → zero surfacing, never breaks.
- **Gemini / Cline / other harnesses.** No PreToolUse wiring in v1; they degrade silently.

## 3. Supersession & constraints

### 3.1 Supersedes prior constraints (edit-time path only)

The committed `2026-05-01-memory-utility-design.md` states hard constraints — "agent-agnostic rules out hooks", "push-based injection rejected", "pull-only" — and `2026-05-06-memory-surfacing-on-suggest-design.md` builds inside that envelope. For the **edit-time path**, those constraints are **superseded** by this spec (user decision, 2026-05-19). Both prior specs carry a status banner pointing here. Rationale:

- *"Hooks aren't agent-agnostic."* Claude Code **and** Codex both expose `PreToolUse` with the identical `hookSpecificOutput.additionalContext` non-blocking contract. Gemini/Cline degrade silently. ai-cortex **already ships per-agent hooks** today (history capture for Claude + Codex), so "no hooks ever" was never literal.
- *"The system can't know relevance, so push is wrong."* This design does not push system-guessed relevance or bodies. It surfaces only deterministic `scopeFiles` matches — author-declared intent — and the agent still judges per-item relevance. The original objection is threaded, not ignored.

Pull-on-`suggest_files` (2026-05-06) is unaffected and continues to coexist.

### 3.2 Enforce visibility, not consumption

The hook guarantees the agent *sees* a file's scoped memories before editing. It never makes `get_memory` the price of proceeding. `get_memory` bumps the access counter — the signal that protects a memory from aging-purge. If consultation were the gate, the agent would call `get_memory` on irrelevant surfaced memories just to continue, corrupting the very signal precision-first protects. Surfaced ≠ relevant; relevance stays the agent's honest, discretionary judgment.

### 3.3 No repo writes

ai-cortex MUST NOT write into the target repo. `additionalContext` is harness-injected (not a repo write). The only persisted state — the dedup ledger — lives under `~/.cache/ai-cortex/`. Honors the pinned no-write decision.

### 3.4 Project-tier, deterministic, no embedding

The edit-time gate is `scopeFiles` literal/glob match only. It does **not** call the embedding-based `matchMemoriesCrossTier`. Two consequences, both deliberate: (a) **project-tier only** — file-scoped patterns are project-relative; global memories are out of scope at this gate (§2 non-goals) and continue to reach the agent via pull-on-`suggest_files`; (b) **no model load** — the hook runs on every edit and must stay sub-ms and synchronous-cheap. Semantic/tag/cross-tier matching at the edit-time gate is deferred, not rejected.

## 4. Architecture

A self-contained `PreToolUse` hook, implemented as the CLI subcommand `ai-cortex memory surface-hook`: reads the hook JSON on stdin, prints an `allow` + `additionalContext` JSON on stdout. It does its own index lookup — no MCP server involvement, no cross-process consult-ledger.

```
read stdin: session_id, cwd, tool_name, tool_input, agent_id?
resolveRepoIdentity(cwd) → { repoKey, worktreePath }  ; throws (not a git repo) → allow, silent
extract target paths (harness-aware, §5)
normalize each path → relative to worktreePath (reuse scope-match normalize)
load active PROJECT-tier memories for repoKey from index (status=active only; no global)
match: any scopeFiles pattern (literal|glob) covers a target path → candidate
rank candidates (precision-first tiering, §4.1) → cap at 3
  ├─ none           → allow, no additionalContext (silent — precision-first)
  └─ ≥1             → dedup check (§7)
        ├─ (file, memory-set) already surfaced this session → allow, silent
        └─ new       → allow + additionalContext (§6); update ledger
on ANY error, or deadline check tripped → allow, silent (never block; §8)
```

No embedding, no model load, no tag/semantic matching anywhere in this path.

### 4.1 Ranking (precision-first tiering)

`getCount`-first ranking would let a broad, high-historical-usage glob (e.g. `src/**/*.ts`) bury a low-count rule whose scope is the *exact* file being edited — the opposite of precision-first. Ranking is therefore tiered, specificity before usage:

1. **Match specificity** (most specific first): exact literal path == target > narrower glob > broader glob. Specificity proxy for a matched pattern: literal (no glob chars) ranks above any glob; among globs, fewer wildcard segments / longer non-wildcard prefix ranks higher (deterministic, computed from the pattern string — no embedding).
2. **`getCount` desc** (within the same specificity tier).
3. **`recency` desc** — `updated_at`, falling back to `created_at`.

Then take the top 3 across the unioned candidates. An exact-path rule for the edited file can never be displaced by a broader glob, regardless of usage history.

## 5. Harness-aware path extraction

| Harness | Trigger | Target paths |
|---|---|---|
| Claude Code | `tool_name` ∈ `Edit`,`Write`,`MultiEdit`; matcher `Edit\|Write\|MultiEdit` | `tool_input.file_path` (single) |
| Codex CLI | `tool_name` = `apply_patch`; matcher `apply_patch` | parse `tool_input.command` (raw patch body) → N paths |

**apply_patch patch-body parser** (pure function, own unit tests): extracts file paths from Codex's envelope — `*** Add File: <p>`, `*** Update File: <p>`, `*** Delete File: <p>`, and rename (`*** Update File:` followed by `*** Move to: <p>`). A single `apply_patch` may touch multiple files: evaluate each independently, surface the union, dedup per-file. Unparseable / malformed patch → return no paths → allow silently. **Phase-gated:** the assumption that the patch body arrives in `tool_input.command` is unverified (§13 BLOCKER); the parser and the Codex install entry stay disabled until a fixture from a real Codex `apply_patch` PreToolUse payload is committed and the parser passes against it.

Path normalization reuses `scope-match.ts` (`\\`→`/`, strip leading `./` or `/`). Absolute tool paths are relativized against `worktreePath` from `resolveRepoIdentity` (= `git rev-parse --show-toplevel`); `repoKey` is a cache identity hash, **not** a filesystem root, and must not be used for relativization. A path outside `worktreePath`, or otherwise unresolvable → silent allow.

## 6. Output contract

Non-blocking. stdout, single JSON object, exit 0:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"<text>"}}
```

`additionalContext` — compact, pointers only, no bodies:

```
ai-cortex: <relPath> has memories scoped to it that you have not seen this session.
Evaluate each against THIS edit. For any that apply, call get_memory(id) before editing.
- [mem-2026-05-02-…-1bb08f] ai-cortex never writes into the target repository (decision)
- [mem-2026-05-19-…-70ef01] Proactive memory surfacing must be push-only and precision-first (decision)
Surfaced ≠ relevant — do NOT get_memory ones that do not apply to this edit.
```

Identical shape for both harnesses (single emit path). For a multi-file `apply_patch`, group pointers by file under per-file sub-headers, but the cap is **3 memories total across the whole patch** — not 3 per file — to keep the injected block bounded. The unioned candidates are ranked by the §4.1 precision-first tiering (specificity → getCount → recency) before taking 3. The closing line explicitly protects the access-counter signal (§3.2).

## 7. Dedup ledger

The only persisted state. One file per session:

```
~/.cache/ai-cortex/<repoKey>/surface-ledger/<session_id>.json
```

Shape: `{ "<relPath>": "<hash of sorted matched memory-ids>" }`.

Logic per file: compute the current matched-id-set hash; if `ledger[relPath] === hash` → allow silent; else emit and write the ledger (atomic tmp + rename). Hashing the *set* (not mere presence) means a memory recorded or deprecated mid-session changes the hash → re-surface so a new rule is not hidden and a removed one stops being shown. Keyed by `session_id` → a fresh session re-surfaces (new context window deserves it). Subagent edits share the session ledger (one surfacing per session is correct across main/sub). Codex stdin has no `agent_id`; session-scoped only — unaffected.

Lazy cleanup: on write, prune ledger files older than 7 days. Cheap, bounded, no background process.

## 8. Failure handling (inviolable)

The hook **never** blocks an edit. Every failure path → `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}`, exit 0:

- not a git repo / repo-identity throw → silent allow
- index missing / unreadable / corrupt → silent allow
- malformed stdin / missing or unparseable tool_input → silent allow
- ledger read/write error → still emit if matched (degrade dedup, not correctness); never throw
- any uncaught exception → trapped → silent allow, stderr breadcrumb only
- deadline check tripped (§8.1) → silent allow

Disable switch: `AI_CORTEX_SURFACE=0` (mirrors the `AI_CORTEX_HISTORY` pattern). When disabled → immediate silent allow.

### 8.1 Timeout model (corrected)

An in-process `setTimeout` cannot preempt a blocked **synchronous** call (repo-identity / SQLite index / fs reads are sync; Node is single-threaded). So a hard in-process time *guarantee* is not achievable and is not claimed. The model is layered, weakest-to-strongest:

1. **Bounded work (primary).** No embedding, no model load, project-tier `scopeFiles`-only match, capped candidate handling, one small index read, one small ledger file. The hook is designed so it does not have a slow path to begin with — a multi-hundred-ms run should be impossible under normal cache state.
2. **Best-effort deadline checks.** A monotonic start time is captured; between phases (after repo-identity, after index load, before ledger write) the elapsed time is checked against a soft budget (~250 ms) and, if exceeded, the hook abandons to silent-allow. This bounds the *common* slow cases (cold cache, large index) that occur *between* sync calls, not *within* one.
3. **Harness hook timeout (hard ceiling).** The real ceiling is the harness-killed hook timeout. Default is **600 s** on both Claude Code and Codex — far too long for an edit gate — so install (§9) sets an explicit short per-hook timeout (proposed **5 s**).
4. **On harness timeout / kill — fail-open?**
   - **Codex: confirmed fail-open.** Source-verified at `rust-v0.131.0`: timeout-kill, non-zero exit, missing exit code, empty/malformed stdout, and even the hook not firing all leave `should_block = false` → apply_patch proceeds. PreToolUse is documented as "a guardrail rather than a complete enforcement boundary." The always-allow guarantee holds structurally for Codex even if the hook hangs.
   - **Claude: verified fail-open (CC 2.1.144, 2026-05-19).** Empirically probed: an isolated headless `claude -p` with a `PreToolUse` hook (`timeout:2`, `sleep 30`) — the hook was killed at ~2 s yet the gated tool proceeded (`is_error:false`, no denial). Behavior matches Codex and the documented "Other exit → continue" table. Still **undocumented upstream**, so re-verify on major Claude Code upgrades. The mitigations below stay regardless (cheap; they version-proof against a future behavior change): layers 1–2 keep runtime far below the timeout; the hook always `exit 0` and never emits a `deny`; the explicit 5 s install timeout bounds worst-case user wait.

## 9. Install / packaging

Extend `src/lib/history/hooks-install.ts`. A **distinct marker** (`ai-cortex memory surface-hook`) separate from the history-capture marker, so install/uninstall toggles this hook independently.

- **Claude** `~/.claude/settings.json`: add a `PreToolUse` entry, matcher `Edit|Write|MultiEdit`, command = the surface-hook subcommand, **`timeout: 5`** (override the 600 s default — §8.1).
- **Codex** `~/.codex/config.toml`: add `[[hooks.PreToolUse]]`, `matcher = "apply_patch"`, same command, **`timeout = 5`**. Extend `applyCodexInstall` / `applyCodexUninstall` (currently UserPromptSubmit/Stop only) to manage a PreToolUse group under the distinct marker.

The explicit 5 s timeout bounds worst-case user wait on a hung hook. Both harnesses then fail open (proceed): Codex by source-confirmed behavior, Claude verified empirically on CC 2.1.144 (§8.1, §13).

Reuse the existing diff / confirm / timestamped-backup UX. New CLI subcommand `memory surface-hook` wired into the `cli.ts` `memory` switch. Minimum Codex version for edit coverage: ~v0.124.0 (apply_patch `PreToolUse` coverage); older versions silently never fire — documented, no runtime check.

## 10. Edge cases

- New file (`Write` / `*** Add File:`) — **still evaluated** against literal and glob scopes. A glob like `src/lib/memory/*.ts` matches a brand-new `src/lib/memory/foo.ts` and must surface. Only "no pattern matches the new path" → silent (not "it's a new file").
- Glob-scoped memory (`src/lib/memory/*.ts`) vs edit to `src/lib/memory/store.ts` → surfaces (intended; author-declared).
- `MultiEdit` `tool_input` schema undocumented → read `file_path`; if shape differs → silent allow.
- Codex multi-file `apply_patch` → evaluate each path, surface union, dedup per file.
- `*** Delete File:` → still surface (a delete can violate a rule).
- Rename (`*** Move to:`) → evaluate both old and new path.
- Memory recorded mid-session for the active file → set-hash changes → re-surface.
- Memory deprecated mid-session → set-hash changes → re-surface without it.
- More than 3 matches → cap 3 by §4.1 tiering (specificity → getCount → recency).
- Concurrent edits same session → atomic ledger write (tmp+rename); last-writer-wins acceptable (worst case: one extra surfacing).
- Subagent edit (Claude `agent_id` present) → surfaces; shares session ledger.
- Permission mode `acceptEdits` / `bypassPermissions` → we never deny, so `allow`+context still delivered; mode-agnostic.
- Candidate / deprecated / trashed memories → excluded (status=active only); an unpromoted rule is never enforced.

## 11. Phased implementation

This touches more than three files (`hooks-install.ts`, a new surface-hook module, the patch-body parser, `cli.ts`, tests) — decompose in the implementation plan:

1. Pure core: path normalization + `scopeFiles` match (reuse `scope-match.ts`), active-memory lookup, ranking/cap. Unit-tested in isolation.
2. apply_patch patch-body parser. Pure, unit-tested (multi-file, add/update/delete/rename, malformed). **Gated on a committed real-Codex-payload fixture (§13); Codex path stays disabled until then.** The Claude path can ship without this phase.
3. Dedup ledger: set-hash, atomic write, lazy prune. Unit-tested (first-emit / second-silent / set-changed-reemit / io-error-degrades).
4. `surface-hook` CLI subcommand: stdin parse (Claude + Codex shapes), assemble output, all failure paths → silent allow. Integration-tested via synthetic stdin payloads.
5. `hooks-install.ts`: Claude `PreToolUse` (timeout 5 s) under the distinct marker; idempotent install/uninstall without touching the history-capture entry. Codex `[[hooks.PreToolUse]]` (timeout 5 s) is added only once the §13 Codex fixture gate is cleared.
6. Docs: status banners on the two superseded specs; README install note; min-Codex-version note.

## 12. Testing

- **Unit:** path normalization; literal vs glob scope match (reuse `scope-match.ts`); active-only filter; rank + cap; patch-body parser (all envelopes + malformed); ledger set-hash dedup (first-emit / second-silent / set-changed-reemit); output JSON shape; every failure path → silent allow.
- **Integration:** drive `memory surface-hook` with synthetic `PreToolUse` stdin payloads — Claude Edit/Write/MultiEdit, Codex single & multi-file apply_patch, subagent context, non-repo cwd, corrupt index — asserting the stdout contract.
- **Install:** `hooks-install` adds/removes the Claude and Codex `PreToolUse` entries idempotently without disturbing the history-capture entry; backups created.

## 13. Open items

- **BLOCKER (Codex path) — escalated 2026-05-19: Codex does not fire `PreToolUse` at all for `apply_patch` on `codex-cli 0.130.0`.** Originally this was a payload-*shape* unknown (the "patch body is exposed as `tool_input.command`" claim derives from Codex PR #18391's description, not the documented schema). Capture was attempted empirically: a stdin-dumping hook in `~/.codex/config.toml`, run twice via `codex exec` performing an `apply_patch`, captured **zero** `PreToolUse` invocations — first with `matcher=""`, then with explicit `matcher` ∈ {`apply_patch`,`Write`,`Edit`,`Bash`,`.*`}. The hook script was verified working when fed stdin manually, and `UserPromptSubmit`/`Stop` hooks fired normally in the same runs. Conclusion: on 0.130.0 Codex honors only `UserPromptSubmit`/`Stop`; `PreToolUse` does not fire for `apply_patch` or `Bash` (matches upstream openai/codex #20204, #21639). The real blocker is upstream *emission*, not payload shape — the shape cannot be observed until Codex emits the event. The Codex `apply_patch` parser + `extractRawPaths` branch are built and unit-tested but unvalidatable against a real payload. **Codex install stays gated off. Retry condition:** a Codex CLI release that actually emits `PreToolUse` for `apply_patch` — then re-run the capture rig, commit the real-payload fixture, validate the parser, and only then wire `applyCodexInstall` for `[[hooks.PreToolUse]]`. Recorded as memory `mem-2026-05-19-codex-0-130-0-doesn-t-fire-pretooluse-2fb1cf`.
- **RESOLVED 2026-05-19 (Claude path): PreToolUse timeout = fail-open, verified on Claude Code 2.1.144.** Was an open risk (fail-open vs fail-closed undocumented). Empirically probed (isolated headless `claude -p`, `--settings`-injected `PreToolUse` hook matcher `Bash`, `timeout:2`, `sleep 30`, `--permission-mode bypassPermissions`): the hook was killed at ~2 s yet the gated tool ran (`is_error:false`, `permission_denials:[]`, `terminal_reason:"completed"`). Matches Codex's source-confirmed fail-open and the documented "Other exit → continue" table. No code change needed; mitigations (§8.1 layers 1–3, always `exit 0`, never `deny`, 5 s install timeout) stay as cheap version-proofing. Still **undocumented upstream** → re-verify on major Claude Code upgrades. Recorded as memory `mem-2026-05-19-claude-code-pretooluse-timeout-fail-b9a076`.
- `MultiEdit` `tool_input` schema is not officially documented (as of Claude Code 2026-05-18); the design assumes a `file_path` field and falls back to silent-allow if absent. Confirm during implementation. (Lower risk than the Codex item: fallback is silent-allow, not silent-never-fires.)
- Exact Codex patch tag boundary for apply_patch hook coverage (~v0.124.0) is approximate per upstream changelog; documented as a minimum, not asserted precisely.

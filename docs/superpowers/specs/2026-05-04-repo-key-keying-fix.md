# Repo-Key Keying Fix — Hashed-by-Design Invariant

**Date:** 2026-05-04
**Status:** design — phased implementation pending review (v2: revised after technical review surfaced 4 issues with v1 — Phase 1 ordering, SQLite merge safety, contamination scope, path validation)

## Goal

Restore the original design: every project's cache directory is keyed by a hashed repo identity derived from `git --git-common-dir`. Eliminate the silent split-brain where some directories are hashed and others are arbitrary client-supplied strings. Auto-migrate existing literal-name dirs so existing users converge to a single canonical store per repo without manual intervention.

## Context

The cache layout under `~/.cache/ai-cortex/v1/` was designed around `resolveRepoIdentity(path)` from `src/lib/repo-identity.ts`, which computes `repoKey = sha16(gitCommonDir)`. A 16-hex string per repo, stable across worktrees, deterministic from any path inside the repo.

In practice, two parallel cache directories per project exist on production machines:

| Path | Keyed by | Created by | Used by |
|------|----------|------------|---------|
| `<v1>/<sha16>/` | hashed | CLI commands, `rehydrate_project` | CLI, `rehydrate_project` |
| `<v1>/<arbitrary-string>/` | client literal | Other MCP tools (`record_memory`, `list_memories`, `recall_memory`, ...) | The same MCP tools |

The split occurs because:

- `src/lib/cache-store.ts:12-17` — `getCacheDir(repoKey)` concatenates `repoKey` directly into the path with no validation or hashing. The function trusts its caller to pass a valid hashed key.
- `src/mcp/server.ts` — Memory MCP tools accept `repoKey: z.string()` as a tool parameter and pass it straight through. The complete list (verified against current source): `recall_memory` (508), `get_memory` (572), `list_memories` (601), `search_memories` (638), `audit_memory` (667), `record_memory` (698), `update_memory` (741), `update_scope` (772), `deprecate_memory` (802), `restore_memory` (827), `merge_memories` (852), `trash_memory` (878), `untrash_memory` (903), `purge_memory` (928), `link_memories` (954), `unlink_memories` (980), `pin_memory` (1006), `unpin_memory` (1031), `confirm_memory` (1055), `add_evidence` (1079), `rebuild_index` (1116), `sweep_aging` (1141), plus `extract_session`, `rewrite_memory`, `list_memories_pending_rewrite`, `promote_to_global`. There is no normalization step. Path-based tools (`rehydrate_project`, `index_project`, `blast_radius`, `search_history`, `suggest_files`, `suggest_files_deep`, `suggest_files_semantic`) take `path: z.string().optional()` and resolve repo identity internally; **they are not part of the bug surface** and require no API change.
- The rehydration briefing returns a project heading like `# Favro` but never exposes the hashed `repoKey` value, so an MCP-driven agent inferring the key from the heading or directory name produces a literal string ("Favro", "ai-cortex", "fav-162958"), creating a parallel directory.

**Concrete evidence on the affected machine:**

```
~/.cache/ai-cortex/v1/
  e8941e322e8bf848/   # hashed Favro     (Apr 14)  — 17 candidate memories
  e17f41450479195c/   # hashed ai-cortex (May 2)   — 5 candidate memories
  global/             # hardcoded literal (lifecycle.ts:874)
  test-smoke/         # test fixture
  Favro/              # literal — empty memory store, full history dir, created May 2
  ai-cortex/          # literal — empty, created May 2
  fav-162958/         # literal — Favro branch name, created today
```

`rehydrate_project` reads from the hashed dirs. `list_memories({repoKey: "Favro"})` reads from the literal dir and returns `[]` even when 17 candidates exist on disk. Writes via different code paths land in different stores. They diverge silently.

`global` is hardcoded (`src/lib/memory/lifecycle.ts:874` exports `GLOBAL_REPO_KEY = "global"`) and is the only literal that is part of the design.

## Constraints

**Memory and history are repo-scoped, not worktree-scoped.** Multiple worktrees of the same repo share the same `repoKey` because `git rev-parse --git-common-dir` resolves to the main `.git` for any worktree. This is intentional. Only the *index* cache is worktree-scoped (different worktreeKey, same repoKey directory). Existing `cache-store.ts`/`rehydrate.ts`/`paths.ts`/`history/store.ts`/`memory/paths.ts` callers already encode this assumption — the fix preserves it.

**Only git repos are supported.** A non-git path is a hard error, not a silent fallback to a path-based literal. `resolveRepoIdentity` already throws `RepoIdentityError`; the fix surfaces that error at the MCP boundary.

**Existing users must converge automatically.** A user with both a populated hashed dir and a populated literal dir for the same repo cannot be expected to run a manual reconcile. Migration runs on first MCP call per-repo per-session and is idempotent.

**The CLI escape hatch stays.** `--repo-key <key>` on CLI commands remains for scripts and non-standard scenarios (e.g., a user explicitly seeding `global` or a test fixture). The CLI is a power-user surface; agents driving via MCP do not need it.

## Architectural decision: invariant at the data-plane boundary

`getCacheDir` is the choke point. Every disk path under `~/.cache/ai-cortex/v1/` flows through it. The fix installs an invariant there:

```
assertHashedRepoKey(repoKey: string): asserts repoKey is HashedRepoKey
  // accept ^[0-9a-f]{16}$ or === "global"; otherwise throw RepoKeyError
```

`getCacheDir` calls `assertHashedRepoKey` before constructing the path. Any caller that ever passes a literal string fails loudly the first time it runs. This is the forcing function — every offending code path surfaces as a stack trace pointing at the original sin.

The MCP tool layer is rewritten to never expose `repoKey` to clients. Tools take `worktreePath: z.string()` and resolve `repoKey` server-side via `resolveRepoIdentity(worktreePath).repoKey`. The agent never invents a key.

The migration layer runs at MCP entry, before the invariant is hit, and is itself the only legitimate caller that ever sees a literal name on disk — and only for the purpose of moving its contents into the hashed dir and quarantining the original.

## Design

Five components. Each lands as an independent step; together they restore the contract.

### 1. `assertHashedRepoKey` invariant in `cache-store.ts`

New exported function in `src/lib/cache-store.ts`:

```ts
const HASHED_REPO_KEY_RE = /^[0-9a-f]{16}$/;
const RESERVED_LITERAL_KEYS = new Set(["global"]);

export class RepoKeyError extends Error {}

export function assertHashedRepoKey(repoKey: string): void {
  if (RESERVED_LITERAL_KEYS.has(repoKey)) return;
  if (!HASHED_REPO_KEY_RE.test(repoKey)) {
    throw new RepoKeyError(
      `Invalid repoKey ${JSON.stringify(repoKey)}: expected 16-hex hash from resolveRepoIdentity, or reserved literal "global". This usually means a caller passed a project name or path component instead of the hashed identity. Use resolveRepoIdentity(worktreePath).repoKey.`
    );
  }
}
```

`getCacheDir(repoKey)` calls `assertHashedRepoKey(repoKey)` first.

This is the only step that **changes runtime behavior independently of the others** — once it ships, any code path still passing a literal will fail. The migration step (component 3) MUST land before or atomically with this so existing users don't see hard failures on first run.

### 2. MCP API contract change in `server.ts`

Every memory MCP tool currently shaped as `{ repoKey: z.string(), …rest }` becomes `{ worktreePath: z.string(), …rest }`. The complete list of tools changing is given in the Context section above.

A small helper resolves identity, validates the path, and gates migration:

```ts
async function withRepoIdentity<T>(
  worktreePath: string,
  fn: (repoKey: string) => Promise<T>,
): Promise<T> {
  validateWorktreePath(worktreePath);                 // explicit, see below
  const { repoKey } = resolveRepoIdentity(worktreePath); // throws RepoIdentityError on non-git
  await runRepoKeyMigrationIfNeeded(repoKey, worktreePath); // component 3
  return fn(repoKey);
}
```

`validateWorktreePath` is new code, not reused. The required checks:

- non-empty string
- `path.isAbsolute(worktreePath)` — reject relative
- `fs.existsSync(worktreePath) && fs.statSync(worktreePath).isDirectory()` — reject missing or non-directory inputs

A relative path is a contract violation, not a bug to recover from — the agent has the absolute cwd and should pass it explicitly. Failing eagerly avoids `path.resolve` silently rebasing on the MCP server's own cwd (which is unrelated to the agent's working directory).

**Reconcile composition.** Today `withReconcile<P extends { repoKey: string }, R>` (server.ts:141) operates on already-resolved `repoKey`. That signature changes — withReconcile is rewrapped (or replaced) so the chain becomes `withRepoIdentity(worktreePath, repoKey => withReconcile(handler)(repoKey, …rest))`. Reconcile remains a per-repoKey one-shot, idempotent in a session.

`rehydrate_project` keeps its `path: z.string().optional()` shape but routes through `withRepoIdentity` internally, so migration runs from there too. The optional/cwd fallback stays for `rehydrate_project` only — it is the canonical session-bootstrap call and predates the contract problem. All new memory tools require explicit `worktreePath`.

**Out of scope this PR**: redesigning tool grouping. The change is a 1:1 rename (`repoKey` → `worktreePath`) plus the wrapper. Not a tool API redesign.

### 3. Auto-migration

Module: `src/lib/cache-store-migrate.ts`. Single entry point:

```ts
runRepoKeyMigrationIfNeeded(repoKey: string, worktreePath: string): Promise<MigrationOutcome>
```

Worktree path must be passed in — without it, candidate-literal discovery is impossible, which is exactly why the API change (component 2) must land together with this component, not before it. The function is cheap on the hot path: a sentinel file marks "migration ran for this repoKey" so subsequent calls in the same or future sessions are a single `stat()`. Sentinel: `<v1>/<repoKey>/.migration-v1-complete`.

#### Migration algorithm

1. **Fast-path**: if `<v1>/<repoKey>/.migration-v1-complete` exists, return `{ outcome: "already-migrated" }`.

2. **Discover candidate literal dirs** matching this repo:
   - basename of `worktreePath` → e.g. `fav-162958` for a Favro worktree, `ai-cortex` for the main checkout.
   - basename of the directory containing `gitCommonDir` (i.e., the main repo root) → e.g. `Favro`.
   - current branch name from `git -C <worktreePath> symbolic-ref --short HEAD` → e.g. `fav-162958` (best-effort, swallowed on detached HEAD).

   Resulting candidate set is the union, deduped, with `global` and any 16-hex matches filtered out (defensive — these are reserved or already canonical). Migration only touches dirs in this candidate set; an unrelated literal-name dir from a different project is left alone.

3. **For each candidate literal dir** `<v1>/<literal>/`, classify by content and act conservatively:

   a. **Empty store** (no memory rows AND no history sessions AND no extractor runs): delete the directory. This is the common case on the affected machine — `Favro/` and `ai-cortex/` literal dirs were created on first MCP call but never received writes that the agent's API path could read back.

   b. **Hashed counterpart does not exist**: rename `<v1>/<literal>/` → `<v1>/<repoKey>/` after WAL checkpoint (see SQLite handling below). Same-filesystem atomic; fall back to recursive copy + verified delete on `EXDEV`.

   c. **Both exist, hashed populated, literal populated**: do **not** auto-merge in v1. Quarantine the literal: move to `<v1>/.quarantine/<literal>-<ISO8601>/` with a sibling `MIGRATION-CONFLICT.md` describing what was found (table row counts, history session count, sentinel). The canonical hashed dir is untouched and remains usable. Users who want the quarantined data can run a manual reconcile (out of scope for this PR; documented as a follow-up CLI).

   This is the **explicit decision to not implement row-level merging in v1**. SQLite-level merging across `memories`, `memory_scope`, `memory_links`, `memory_audit`, plus FTS rebuild, is non-trivial to get right (PK collision semantics, audit history ordering, FTS rebuild integrity). The affected machine's known-bad cases are all category (a) — empty literal dirs created by misrouted writes that the read path never saw — and category (b) — Favro's old hashed dir holding the real data with the literal dir empty (in the inverse pre-migration scenario users on older builds hit). The both-populated case is rare in practice on currently affected installs; quarantining it preserves data without risking corruption from a half-correct merge.

4. **SQLite WAL handling**, applied to ANY file-level operation on `memory/index.sqlite` (rename or copy):

   - Open the source DB, run `PRAGMA wal_checkpoint(TRUNCATE);` to fold the `-wal` and `-shm` sidecars into the main file. Close the connection.
   - Verify the checkpoint succeeded by re-opening, running `PRAGMA wal_checkpoint(PASSIVE);` once more, and confirming the result row indicates 0 frames remaining.
   - Then rename or copy. The `-wal` and `-shm` files are deleted in the source location after the checkpoint; if they reappear (e.g., another process opens the DB), abort and quarantine instead.

   This applies in case (b) and any future merge implementation. It is the correctness floor for moving SQLite databases that may have uncommitted WAL frames.

5. **Write sentinel** `<v1>/<repoKey>/.migration-v1-complete` with a small JSON payload (timestamp, candidates inspected, outcomes) so future sessions skip the scan.

6. **Return `MigrationOutcome`**:
   ```ts
   { outcome: "already-migrated" | "no-op" | "deleted-empty" | "renamed" | "quarantined" | "mixed",
     details: { literalKey, action, reason }[] }
   ```

#### Concurrency

Migration uses an exclusive lockfile `<v1>/.migration-<repoKey>.lock` (open with `O_CREAT | O_EXCL`). If contended, second caller polls for sentinel up to 30s, then proceeds (sentinel-present is the success signal). Per-repoKey lockfile so different repos don't serialize on each other. Single-machine concurrency only — a multi-host shared cache is not supported and out of scope.

#### Rollback

Migration is one-way. Quarantined dirs and their contents are preserved indefinitely under `.quarantine/<literal>-<ISO8601>/`; users can inspect and restore manually if needed. For case (b) renames, the old literal location is gone after success; the only failure mode that loses data is a partial copy after `EXDEV` fallback, which we guard against by verifying byte-equal manifest copies and row-count parity before unlinking the source.

### 4. CLI behavior

`--repo-key <key>` flag stays as an explicit override on CLI commands. Validation: `assertHashedRepoKey` runs on the value, so a user passing `--repo-key foo` gets an immediate error. The reserved `global` is accepted. Agent-driven CLI usage normally relies on the cwd-based default and never passes `--repo-key`.

`ai-cortex memory reconcile` gains an optional `--from-quarantine <path>` flag for users who need to pull data out of a quarantined dir manually after a conflict. Out of scope this PR; ship with quarantine-only behavior, add the flag in a follow-up if real users hit it.

### 5. Tests

Unit tests:

- `cache-store.test.ts`: `assertHashedRepoKey` accepts 16-hex, accepts `"global"`, rejects empty, rejects 15-hex, rejects 17-hex, rejects uppercase, rejects "ai-cortex", "Favro", "fav-162958", "/abs/path", "../traversal".
- `repo-identity.test.ts`: existing tests still pass; add test that the produced key passes `assertHashedRepoKey`.

Integration tests for migration (`tests/integration/cache-store-migrate.test.ts`). The fixture set mirrors the three classification cases (a/b/c) plus reserved-key, sentinel, branch-name, WAL, and concurrency edge cases. **No fixture asserts row-level merge** — that behavior is explicitly out of scope for v1.

Case (a) — empty literal dirs:
- Fixture A1: only literal dir exists, empty store (no rows, no sessions, no extractor runs) → literal deleted; hashed dir created with sentinel only; outcome `deleted-empty`.
- Fixture A2: both exist, literal empty, hashed populated → literal deleted; hashed unchanged; outcome `deleted-empty`.
- Fixture A3: both exist, literal has only an empty `index.sqlite` (schema applied, zero rows) and no other content → classified as empty, deleted.

Case (b) — rename:
- Fixture B1: only literal dir exists, populated (memory rows present) → renamed to `<v1>/<repoKey>/`; sentinel written; outcome `renamed`.
- Fixture B2: B1 with `-wal` and `-shm` sidecars containing uncommitted frames → checkpoint runs before rename; renamed DB has all rows; sidecars not present in destination; outcome `renamed`.
- Fixture B3: B1 across simulated `EXDEV` (cross-filesystem) → falls back to recursive copy; row counts and file lists verified equal before source unlink; outcome `renamed`.

Case (c) — quarantine (both populated):
- Fixture C1: both exist, both populated (any combination of disjoint or overlapping `memories.id`) → literal moved to `<v1>/.quarantine/<literal>-<ISO8601>/`; `MIGRATION-CONFLICT.md` written alongside with row counts and pointers; hashed dir untouched; outcome `quarantined`. **No row-level merging is attempted.**
- Fixture C2: both exist, both populated, hashed dir has `-wal` frames → hashed dir is read-only inspected for the conflict report; checkpoint not required since hashed is not moved; outcome `quarantined`.

Reserved and defensive:
- Fixture R1: literal dir name is `"global"` → skipped entirely (the canonical global store is reserved); outcome includes `{literalKey: "global", action: "skipped", reason: "reserved"}`.
- Fixture R2: candidate set contains a 16-hex string (e.g., a stale dir matching the regex) → skipped; outcome `skipped` reason `already-canonical-shape`.
- Fixture R3: candidate set is empty (worktree basename equals `<repoKey>` after hashing — pathological, included for completeness) → outcome `no-op`; sentinel written.

Branch-name discovery:
- Fixture BR1: worktree at `/tmp/repo-X` with branch `feature-Y`, literal dir `<v1>/feature-Y/` populated → discovered via `git symbolic-ref --short HEAD`, treated as case (b), renamed.
- Fixture BR2: detached HEAD → branch lookup swallowed; basename candidates still discovered; no error.

Sentinel and concurrency:
- Fixture S1: sentinel exists at `<v1>/<repoKey>/.migration-v1-complete` → fast-path returns `already-migrated` without scanning candidates.
- Fixture S2: sentinel JSON payload includes timestamp and per-candidate outcomes (asserted as a structural read).
- Fixture CN1: two concurrent callers, same repoKey → lockfile `<v1>/.migration-<repoKey>.lock` serializes; second caller sees sentinel and returns `already-migrated`; both succeed.
- Fixture CN2: two concurrent callers, different repoKeys → run in parallel, no contention.

Failure paths:
- Fixture F1: lockfile contention exceeds 30s timeout → caller returns clear error including the lockfile path; no partial state written.
- Fixture F2: WAL checkpoint reports nonzero remaining frames after `TRUNCATE` (e.g., another reader has the DB open) → migration aborts case (b), falls through to quarantine for safety; outcome `quarantined` with reason `wal-checkpoint-incomplete`.

Integration tests for MCP API (`tests/integration/mcp-worktree-path.test.ts`):

- Each memory tool: pass `worktreePath` for a fixture repo, assert on-disk dir is `<sha16>` matching `resolveRepoIdentity`.
- Pass `worktreePath` to a non-git directory → tool returns a clear error message; no dir created.
- Backwards-compat probe: passing legacy `repoKey` (no longer accepted) → schema validation error from zod, no fallback.

Smoke test: a benchmark or fixture run that exercises CLI + MCP both pointing at the same repo produces only `<sha16>` and (optionally) `global` under `<v1>/`. No literal-name dir.

## Phasing and order of operations

Migration depends on `worktreePath`, which only the API change (component 2) makes available at the MCP boundary. Therefore migration cannot precede the API change as a "no behavior change" pre-step — the original phasing (migration first, invariant second, API third) is incoherent. Revised phasing:

**Phase 1 — API change + migration, single PR** (this is the load-bearing change):
- Component 2 (`repoKey` → `worktreePath`, `withRepoIdentity` wrapper, `validateWorktreePath`) lands across the ~26 affected memory tools.
- Component 3 (migration module) lands and is wired into `withRepoIdentity` so the first MCP call per-session-per-repo runs migration with a real `worktreePath`.
- Tests for both components ship in this PR.
- Behavior change at this point: clients that still send `repoKey` get a zod validation error. Existing on-disk literal dirs are migrated to the hashed location on first call. Tools that take `path` (rehydrate_project, blast_radius, search_history, etc.) are unaffected.

**Phase 2 — Invariant**:
- Component 1 (`assertHashedRepoKey` wired into `getCacheDir`) lands.
- After Phase 1 has converged on-disk state and source-side callers, the invariant catches any future regression. Landing this earlier risks hard failures on installs that haven't yet had a chance to migrate.
- CI must be green; any internal caller still passing a literal fails here.

**Phase 3 — Polish**:
- CLI `assertHashedRepoKey` validation on `--repo-key` flag (rejects literal overrides, accepts the reserved `global`).
- Audit benchmarks and test fixtures for hardcoded literal repoKeys; replace with hashed equivalents or `AI_CORTEX_CACHE_HOME`-isolated fixtures.
- Tool descriptions, prompt-guide, README updated to drop `repoKey` examples.
- Release notes flag the breaking change for any external scripts that called the MCP server directly with `repoKey`.

**Phase 4 (optional, follow-up)**:
- `ai-cortex memory reconcile --from-quarantine <path>` for users who want to merge a quarantined dir into the canonical store. Implements the row-level merge semantics deferred from component 3 (case c). Only built if real users hit it.

## Open considerations

- **Schema audit (closed)**: I reviewed the SQLite schema in `src/lib/memory/index.ts:30-95`. The persisted tables are `memories` (id PK), `memory_scope` (memory_id, kind, value), `memory_links` (src_id, dst_id, rel_type), `memory_audit` (memory_id, version), and `memory_fts` (FTS5 virtual). None of them store `repoKey` inside row data — `repoKey` is purely the *directory* boundary, never a column. So migration does not need to rewrite any row contents; moving the directory is sufficient.

- **Worktree-only briefing cache**: rehydrate writes a per-worktree briefing JSON+MD under `<v1>/<repoKey>/<worktreeKey>.{json,md}`. These are repo-scoped (parent dir) but worktree-scoped within. Migration moves them with the rest of the repo dir; worktree key is unchanged because `resolveRepoIdentity` already produces the same `worktreeKey`.

- **Branch-name dirs caught by design**: the `fav-162958/` literal seen on the affected machine matches a Favro *branch* name, not a worktree basename. Component 3's candidate set explicitly includes `git symbolic-ref --short HEAD`, so branch-name literals are reachable. Detached-HEAD case is swallowed best-effort.

- **Backwards-compat for old callers**: external scripts hitting the MCP server with `repoKey` will break with a zod validation error. This is acceptable — it's exactly the contamination vector. Surfaced as a release-note breaking change, not a deprecation cycle. The benefit of full convergence outweighs the cost of a flag day for what should be a tiny external-script population.

## Decision log

- **Hash, don't normalize.** Considered: normalize literal names by hashing them on the fly inside `getCacheDir`. Rejected: hashing the wrong input (a literal name vs. the gitCommonDir) produces a *new* dir that doesn't match either existing store. The split would persist under different names. The contract must reject invalid input loudly.

- **Defer SQLite row-level merge.** Considered: merge `memories` + `memory_scope` + `memory_links` + `memory_audit` row-by-row when both literal and hashed dirs hold data. Rejected for v1: getting it right requires careful conflict semantics for each table (which `body_hash` wins on duplicate `id`? does audit history merge in version-order? does FTS rebuild handle the union?), and the affected machine's known-bad cases don't need it (Favro literal was empty; the real Favro data was always in the hashed dir). Quarantine the both-populated case, build a manual reconcile CLI in Phase 4 if real users hit it.

- **WAL checkpoint before any file move.** Considered: rely on the OS to handle file copies of an open SQLite DB. Rejected: WAL mode means uncommitted frames live in the `-wal` sidecar; a naive `rename` or `cp` of just `index.sqlite` silently drops them. Migration must `PRAGMA wal_checkpoint(TRUNCATE)` and verify before any file-level operation.

- **Sentinel, not full scan-every-call.** Considered: scan `<v1>/` on every MCP call. Rejected: cost is low but non-zero; with N MCP calls per session and M projects on a developer machine, the scan grows. Sentinel makes it O(1) after first run.

- **API change and migration land together.** Considered (and originally specified): land migration first as a "no behavior change" pre-step, then API change later. Rejected: migration's algorithm requires `worktreePath`, which only exists at the MCP boundary after the API change. The two changes are coupled; splitting them produces a phase that cannot do its job. Land them together.

- **Lockfile within-machine only.** Considered: more elaborate distributed locking. Rejected: the cache is explicitly a local-first store. Multi-host shared-cache is not a supported deployment.

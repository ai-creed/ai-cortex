# Update notification aggression — design

**Date:** 2026-05-20
**Status:** design — single phase
**Scope:** route the existing CLI update notifier to the MCP `rehydrate_project` briefing path; add a one-line "what's new" headline sourced from the npm manifest; tier the loudness by how far behind the user is.
**Builds on:** post-v0.10.0 tree (Phase 11 adoption telemetry shipped; `src/lib/update-notifier.ts` with daily-throttled CLI nudge; `src/lib/briefing.ts` pure renderer; `src/lib/rehydrate.ts:23` `rehydrateRepo` calls `renderBriefing` and writes the briefing file; `src/mcp/server.ts:439` reads it back in the `rehydrate_project` tool handler).

---

## 1. Context & problem

`src/lib/update-notifier.ts` already exists and is wired into the CLI: on each command it checks a local cache, spawns a detached background `fetch` to `https://registry.npmjs.org/ai-cortex/latest`, and prints `formatNotice(current, latest)` to stderr when stale. The mechanism works — but it only fires on **direct CLI invocations**. `shouldCheck` explicitly skips the `mcp` command (`SKIP_COMMANDS` set, line 14–23), so the long-lived MCP server — the path most users interact with daily via their agent — never even runs the check.

Empirical evidence for the gap: the maintainer is currently sitting on globally-installed v0.9.0 while master is on v0.9.1 with Phase 11 + interpretation layer queued for v0.10.0. With ~2k npm downloads and a high release cadence (most recent releases shipping non-trivial fixes), a meaningful fraction of users are likely several releases behind without knowing it.

A secondary problem: even when the CLI nudge does fire, it says "newer version available" — no signal as to *why* a user should upgrade. Users dismiss generic upgrade prompts.

## 2. Goals / non-goals

### Goals

- Surface the upgrade notice to users who only run `ai-cortex mcp` (never directly invoke the CLI), by emitting it through the `rehydrate_project` briefing where the agent will naturally relay it.
- Include a release-specific headline ("what's new in this version") so the user knows *why* the upgrade matters, not just *that* one exists.
- Tier the loudness by version gap: subtle for a single patch, louder for a minor, always-on for multi-minor — so real gaps are unmissable without nag-spamming tiny patches.
- Apply the same tier-aware format to the existing CLI nudge so the two surfaces are consistent.
- Keep the inviolable contract: the update-check path must **never** crash a briefing render or a CLI command.

### Non-goals

- **No "behind on these releases:" multi-version list** in v1. Single headline + an `N minor releases behind` count is sufficient; walking the full `/ai-cortex` registry doc to enumerate intervening release headlines is deferred (see §10).
- **No new external dependencies, no new network host.** All data flows through the existing `registry.npmjs.org/ai-cortex/latest` fetch.
- **No auto-update / refuse-to-start floor.** Both are too invasive for a local-first tool; the user retains full control.
- **No new env vars beyond what exists.** `AI_CORTEX_NO_UPDATE_CHECK=1` continues to suppress everything.
- **No per-call sqlite writes.** The throttle state extends the existing JSON cache file (`~/.cache/ai-cortex/update-check.json`).

## 3. Architecture

```
ai-cortex mcp (long-lived)
   │
   ├─ rehydrate_project handler (src/mcp/server.ts)
   │     │
   │     ├─ getBriefingNotice({ currentVersion: SERVER_VERSION })
   │     │      │
   │     │      ├─ AI_CORTEX_NO_UPDATE_CHECK?           → null
   │     │      ├─ readCache(update-check.json)
   │     │      │     └─ stale? → spawnBackgroundFetch() (detached)
   │     │      ├─ compareSeverity(current, latest)     → tier
   │     │      ├─ throttle gate (tier-aware, keyed off
   │     │      │   cache.lastBriefingShownAt)          → null OR proceed
   │     │      └─ formatNotice(..., surface: "mcp")    → string
   │     │
   │     ├─ rehydrateRepo(worktreePath, { notice })
   │     │      └─ renderBriefing(cache, { notice })    → markdown
   │     │      └─ fs.writeFileSync(briefingPath, ...)
   │     │
   │     └─ fs.readFileSync(briefingPath) → content
   │
   └─ returned to agent → relayed to user

ai-cortex <any CLI command> (existing path)
   └─ checkForUpdate → formatNotice(..., surface: "cli") → stderr
                                              ^ same formatter, ANSI color
```

Single source of truth: `update-notifier.ts` owns the cache shape, severity comparison, throttle decision, and the formatter. `briefing.ts` and the CLI entry both call into it; neither contains duplicated logic.

## 4. Cache shape

`~/.cache/ai-cortex/update-check.json` extends from:

```json
{ "checkedAt": "<iso>", "latestVersion": "<semver>" }
```

to:

```json
{
  "checkedAt": "<iso>",
  "latestVersion": "<semver>",
  "releaseHeadline": "<string>",
  "lastBriefingShownAt": "<iso>"
}
```

- `releaseHeadline`: copied from the registry manifest's `aiCortex.releaseHeadline` field (see §5). Missing → empty string; renderer falls back to no-headline form. Backward-compatible: pre-v0.11.0 caches lack this field — `readCache` tolerates absence.
- `lastBriefingShownAt`: set when the MCP briefing actually emits a patch-tier notice (UTC-day throttle key). Untouched for minor/multi-minor tiers (they don't throttle). Missing → throttle gate fires (treats as never shown).

`readCache` accepts both shapes (existing two-field cache parses as `releaseHeadline: ""`, `lastBriefingShownAt: undefined`).

Write paths:

- `runBackgroundFetch` (detached child) refreshes `checkedAt`, `latestVersion`, `releaseHeadline`. **It must read the prior cache first and preserve `lastBriefingShownAt`** as-is — the throttle key belongs to the main process and resetting it on every 24h fetch would over-emit patch notices. Implementation: read-modify-write, defaulting absent `lastBriefingShownAt` to `undefined` (which the renderer's `shownTodayUTC` treats as "never shown").
- `getBriefingNotice` (main process) may write a `lastBriefingShownAt`-only update when emitting a patch-tier notice — read-modify-write of the same JSON, leaves the other three fields untouched.

## 5. "What's new" data source

`package.json` gains a custom field:

```json
{
  "name": "ai-cortex",
  "version": "0.11.0",
  "aiCortex": {
    "releaseHeadline": "edit-time surfacing + Phase 11 telemetry"
  }
}
```

The npm registry preserves arbitrary top-level package.json fields in the per-version manifest, so the existing `fetch(REGISTRY_URL)` call (`/ai-cortex/latest`) returns this field with no second request needed.

**Release-time workflow change:**

- `scripts/release.sh` gains a step: prompt for a one-line headline **before the version-bump commit / tag / push** (publish is handled by GitHub CD on tag push — there is no in-script `npm publish`). The step writes the headline to `package.json` under `aiCortex.releaseHeadline`, then commits, tags, pushes. Insertion point: **before line 45** (the existing `git add package.json src/version.ts`) — the new headline must be staged in that same `git add`. After release, the field is left in place (the dev tree mirrors the published manifest).
- One-line headline conventions: ≤ 60 chars, present-tense feature summary (matches the leading bullet style of CHANGELOG.md entries).
- Prompt behavior: shows the previous `aiCortex.releaseHeadline` for reference. Three input shapes:
  - non-empty string → new headline.
  - bare `Enter` → reuse the previous value (frictionless for patch-release scripting).
  - the literal sentinel `-` (single dash, on its own) → clear to empty string (no headline; renderer falls back to the no-headline form per §6). Reserving a sentinel rather than treating bare-empty as "clear" avoids accidental wipes from a typo / accidental Enter on a fresh script run.
  - Round-trip note: if the previous-value display would itself be `-` (highly unlikely under the ≤ 60-char feature-summary convention), the prompt shows `(none)` instead so the user can't confuse it with the sentinel.

## 6. Severity tiers + throttle

`compareSeverity(current, latest): "none" | "patch" | "minor" | "multi-minor"`:

| Result | Condition | Example |
|---|---|---|
| `"none"` | `current >= latest` | 0.11.0 vs 0.10.5 |
| `"patch"` | same `major.minor`, `patch` behind | 0.10.0 → 0.10.1 |
| `"minor"` | exactly 1 minor behind (same major) | 0.10.x → 0.11.0 |
| `"multi-minor"` | ≥ 2 minors behind, OR a major behind | 0.9.x → 0.11.0; 0.x → 1.x |

Pre-release suffixes (`-rc.1`, `-beta.0`) are ignored for the comparison (matches existing `compareVersions` behavior).

**Throttle table (MCP briefing surface only — CLI surface emits unconditionally on its existing daily cache cadence):**

| Tier | Cadence in briefing | Format |
|---|---|---|
| `none` | never | — |
| `patch` | first MCP briefing call of each UTC day (globally, keyed off `lastBriefingShownAt` in the shared cache file — survives process restart); suppressed for the remainder of that day | one-line: `ai-cortex 0.10.1 available — <headline>. Run: npm install -g ai-cortex@latest` |
| `minor` | every briefing call while stale (no throttle) | two-line block, surrounded by `---` rules above and below |
| `multi-minor` | every briefing call while stale (no throttle) | three-line block including `you are N minor releases behind` |

The throttle compares UTC days via `floor(ts / 86_400_000)`, robust to DST and timezones.

**No-headline fallback exemplar (when `cache.releaseHeadline` is empty / missing):**

- patch tier → `ai-cortex 0.10.1 available. Run: npm install -g ai-cortex@latest` (no em-dash, no headline slot).
- minor / multi-minor → first line drops the headline phrase; rest of the block unchanged. Formatter never emits a dangling em-dash or `available — .` punctuation artifact.

## 7. Components

**`src/lib/update-notifier.ts` (extended):**

- `compareSeverity(current, latest)` — new pure function; covered by unit tests in §11.
- `formatNotice(opts: { current, latest, headline, tier, surface })` — replaces the existing two-arg `formatNotice`. `surface: "cli" | "mcp"`:
  - `"cli"` → may include ANSI bold/color (minor and multi-minor tiers).
  - `"mcp"` → plain text only (agent context must not carry escape codes; the agent's relay should be readable).
- `runBackgroundFetch()` — extended to extract `aiCortex.releaseHeadline` from the JSON response (default `""` if absent / wrong type) and persist it.
- `getBriefingNotice({ currentVersion })` — new entry point for MCP-side use. Honors `AI_CORTEX_NO_UPDATE_CHECK`. Triggers `spawnBackgroundFetch()` on a stale/absent cache (same behavior as `checkForUpdate`). Applies the §6 throttle. On a patch-tier emit, performs the read-modify-write of `lastBriefingShownAt`. Wrapped in a top-level `try { ... } catch { return null }` — must never throw.
- `checkForUpdate(...)` (existing CLI path) — return type evolves from `string | null` to `{ latest, headline, tier } | null`; callers updated. The existing `mcp` entry in `SKIP_COMMANDS` is preserved (CLI-style terminal print stays off for the MCP server's own stderr — only the briefing path emits).

**`src/lib/briefing.ts`:**

- `renderBriefing(cache, opts?: { notice?: string | null })` — new optional second arg. When `notice` is provided and non-empty, prepended above `renderHeader`, separated by a blank line. When absent / null / empty, identical to the existing output. Stays pure.

**`src/lib/rehydrate.ts` (`rehydrateRepo`, line 23):**

- New optional option on `RehydrateOptions`: `notice?: string | null`.
- Forwarded into `renderBriefing(cache, { notice })` at line 34 — must be wired in before `fs.writeFileSync(briefingPath, md)` at line 44 so the persisted briefing file (which the MCP handler reads back at `src/mcp/server.ts:440`) carries the notice.
- `rehydrateRepo` itself does not call `getBriefingNotice` — keeps the lib pure and lets CLI callers (which have their own CLI-surface nudge via `checkForUpdate`) opt out by passing nothing.

**`src/mcp/server.ts` (`rehydrate_project` tool handler — call site at line 439, briefing read-back at line 440):**

- The canonical version source is `VERSION` from `src/version.ts` — already imported into this file as `SERVER_VERSION` (`src/mcp/server.ts:30`). **Do not read `package.json` at runtime** — the bundled `dist/src/cli.js` vs `src/cli.ts` path math diverges between prod and tests, per the existing comment at `src/cli.ts:23-30`.
- Before the `rehydrateRepo(worktreePath, ...)` call at line 439, call `getBriefingNotice({ currentVersion: SERVER_VERSION })`. Wrap in a top-level `try { ... } catch { /* notice = null */ }` — defense in depth even though `getBriefingNotice` itself never throws — and pass the result through `rehydrateRepo`'s new `notice` option.

**CLI entry (`src/cli.ts`):**

- `printUpdateNotice` signature changes from `(current: string, latest: string)` to `(current: string, info: { latest: string; headline: string; tier: Severity })` (where `Severity` is the union from §6 minus `"none"`). It calls the tier-aware `formatNotice({ ...info, current, surface: "cli" })` and writes to stderr (existing behavior). No new CLI flags.

**`scripts/release.sh`:**

- New step **before line 45 (`git add package.json src/version.ts`)**: read previous `aiCortex.releaseHeadline` from `package.json`, prompt for a new one (default = previous; `-` sentinel = clear; see §5), write back. The headline write must be staged in the same `git add` line — extend it to include any other `package.json` mutation already covered. Implementation must be idempotent (re-running the release script doesn't accumulate cruft).
- `scripts/release.sh` has **no in-script `npm publish`** (publish runs in GitHub CD on tag push) — the prompt step lives strictly inside the script's pre-commit window.
- A dedicated unit test verifies the JSON read-modify-write helper (pure JSON manipulation; interactive prompt excluded).

## 8. Data flow (one cycle, MCP path)

```
1. Agent calls rehydrate_project (handled in src/mcp/server.ts:418).
2. src/mcp/server.ts handler:
     // SERVER_VERSION already imported from "../version.js" at line 30.
     try { notice = getBriefingNotice({ currentVersion: SERVER_VERSION }) }
     catch { notice = null }
     result = await rehydrateRepo(worktreePath, { notice })
     // rehydrateRepo writes the briefing file at line 44; result.briefingPath
     // is read back by the handler at src/mcp/server.ts:440.
3. getBriefingNotice (in src/lib/update-notifier.ts):
     env AI_CORTEX_NO_UPDATE_CHECK? → null
     cache = readCache(cachePath())
     if !cache || isCacheStale(cache.checkedAt): spawnBackgroundFetch()
     if !cache: return null   # nothing to compare against yet
     tier = compareSeverity(currentVersion, cache.latestVersion)
     if tier === "none": return null
     // shownTodayUTC must treat undefined/missing as "never shown".
     if tier === "patch" and shownTodayUTC(cache.lastBriefingShownAt): return null
     if tier === "patch": writeCache({ ...cache, lastBriefingShownAt: nowIso })
     return formatNotice({ current: currentVersion, latest: cache.latestVersion,
                           headline: cache.releaseHeadline,
                           tier, surface: "mcp" })
4. rehydrateRepo (src/lib/rehydrate.ts:23) forwards `options.notice`:
     briefing = renderBriefing(cache, { notice: options?.notice })
     fs.writeFileSync(briefingPath, briefing + extras...)
5. renderBriefing(cache, { notice }):
     [notice ? notice + "\n" : ""] + renderHeader(...) + renderKeyDocs(...) + ...
```

The first MCP session after `ai-cortex` is installed will see no notice — `cache` is null. The background fetch populates it asynchronously; the next briefing call (typically seconds later in the same session, or guaranteed in the next session) emits the notice. This matches the existing CLI nudge's first-run behavior — known and acceptable.

## 9. Error handling

- **Network / parse failures in `runBackgroundFetch`:** silent (existing behavior preserved — comment at line 159–161).
- **Missing `aiCortex.releaseHeadline` in the manifest:** treated as empty string; renderer falls back to the no-headline form. This is the v0.10.x→v0.11.0 transition path until the release-script change ships.
- **Corrupted cache JSON:** `readCache` returns null (existing behavior), notice suppressed, fresh fetch scheduled.
- **`getBriefingNotice` internal failure (e.g. cache file unwritable when emitting a patch tier):** top-level catch returns null. The briefing renders without a notice. A briefing render must never fail because the notifier failed — inviolable.
- **`renderBriefing` is given a corrupt `notice` string:** prepended as-is — markdown is permissive, and the notice is generated by us, not user input.

## 10. Phased implementation

- **v1 (this spec).** MCP-side briefing notice + "what's new" headline from `aiCortex.releaseHeadline` + tier-aware throttle + CLI-surface format parity. Release-script `aiCortex.releaseHeadline` prompt.
- **v2 (deferred).** Multi-version "behind on these releases:" enumeration. When `tier === "multi-minor"`, fetch the full `/ai-cortex` packument (the registry endpoint without `/latest` — heavier payload, currently ~50–200 KB and grows with release count) and walk intervening versions from `currentVersion` to `latestVersion`, listing each's `aiCortex.releaseHeadline`. Adds a second / heavier fetch and a multi-version cache (which must be sized for the packument's growth). Skipped now because the single-headline + `N releases behind` count is sufficient for the immediate win; the doc fetch and multi-version cache are non-trivial.
- **v3 (deferred).** User-tunable tier overrides (`AI_CORTEX_UPDATE_TIER_MAX=patch` etc.). Not requested; YAGNI until someone asks.

## 11. Testing

Unit tests in `tests/unit/lib/`:

- `update-notifier.test.ts` additions:
  - `compareSeverity` — patch / minor / multi-minor (1 minor behind, 2 minors behind, major behind), `none` for equal and for current > latest, pre-release suffix ignored.
  - `formatNotice` — each tier × each surface. `surface: "mcp"` MUST contain no ANSI escape sequences (asserted via regex). `surface: "cli"` for `minor`/`multi-minor` MUST contain bold markers.
  - `getBriefingNotice`:
    - `AI_CORTEX_NO_UPDATE_CHECK=1` → null even with a stale cache and a patch behind.
    - no cache → null + spawnBackgroundFetch invoked (spy).
    - cache present, current === latest → null.
    - patch tier, never shown today → notice returned, `lastBriefingShownAt` written.
    - patch tier, already shown today (lastBriefingShownAt is today UTC) → null.
    - minor tier → notice returned, `lastBriefingShownAt` untouched (regression guard).
    - multi-minor tier → notice contains the `N minor releases behind` count.
    - missing `releaseHeadline` in cache → notice still rendered, falls back to no-headline form (no stray em-dash).
    - `getBriefingNotice` wrapped in a synthetic throw inside `readCache` → returns null, does not propagate.
- `briefing.test.ts`:
  - `renderBriefing(cache)` baseline unchanged (snapshot or string-equal against current output).
  - `renderBriefing(cache, { notice: "X" })` prepends `X\n` above the header.
  - `renderBriefing(cache, { notice: null })` and `{ notice: "" }` identical to baseline.

Integration (extend existing rehydrate test):

- With a planted stale cache that has a higher `latestVersion` and a `releaseHeadline`, calling `rehydrate_project` returns a briefing string that includes the notice.
- With `AI_CORTEX_NO_UPDATE_CHECK=1` set, the same setup returns a briefing string with no notice.

Release-script:

- Unit test for the `package.json` headline read-modify-write helper (pure JSON manipulation; interactive prompt excluded).

## 12. Open items

- **Telemetry on the new path.** Phase 11 adoption telemetry doesn't currently count rehydrate-briefing invocations as their own dimension. Worth adding `briefingShown` / `briefingShown_withNotice` counters to `tool_calls` so we can measure: did the briefing-side notice actually correlate with users upgrading? Deferred to a separate spec — the path forward is the same `logged()` shape used by other tools.
- **Codex parity.** Codex's MCP `rehydrate_project` path is the same code — the notice will appear there for free. Verify after v1 lands (no spec work needed).
- **TTL of `releaseHeadline` across versions.** When the user upgrades and `currentVersion === latestVersion`, the cache still contains the old headline. Benign — `tier === "none"` short-circuits before it's read. Next background fetch refreshes it. No action needed.

---

## Cross-references

- `src/lib/update-notifier.ts` — existing CLI-side implementation
- `src/lib/briefing.ts` — pure briefing renderer
- `src/lib/rehydrate.ts` — `rehydrateRepo` (renders + writes the briefing file)
- `src/mcp/server.ts` — `rehydrate_project` tool handler (calls `rehydrateRepo`, owns version source via `SERVER_VERSION` alias of `VERSION`)
- `src/version.ts` — canonical version source; do NOT read `package.json` at runtime
- `docs/superpowers/specs/2026-05-19-adoption-telemetry-design.md` — Phase 11 telemetry (related: telemetry on this path is in §12)
- `KNOWN_LIMITATIONS.md` — *Adoption / agent integration* (the existing "MCP tool discovery is best-effort" entry; this design partially addresses one slice of that)

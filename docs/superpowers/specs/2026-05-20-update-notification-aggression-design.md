# Update notification aggression — design

**Date:** 2026-05-20
**Status:** design — single phase
**Scope:** route the existing CLI update notifier to the MCP `rehydrate_project` briefing path; add a one-line "what's new" headline sourced from the npm manifest; tier the loudness by how far behind the user is.
**Builds on:** post-v0.10.0 tree (Phase 11 adoption telemetry shipped; `src/lib/update-notifier.ts` with daily-throttled CLI nudge; `src/lib/briefing.ts` pure renderer; `src/mcp/rehydrate.ts` calls `renderBriefing`).

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
   ├─ rehydrate_project called by agent
   │     │
   │     ├─ rehydrate.ts → getBriefingNotice(currentVersion, callCount++)
   │     │      │
   │     │      ├─ AI_CORTEX_NO_UPDATE_CHECK?           → null
   │     │      ├─ readCache(update-check.json)
   │     │      │     └─ stale? → spawnBackgroundFetch() (detached)
   │     │      ├─ compareSeverity(current, latest)     → tier
   │     │      ├─ throttle gate (tier-aware)           → null OR proceed
   │     │      └─ formatNotice(..., surface: "mcp")    → string
   │     │
   │     └─ renderBriefing(cache, { notice })           → markdown
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

`readCache` accepts both shapes (existing two-field cache parses as `releaseHeadline: ""`, `lastBriefingShownAt: undefined`). `writeCache` always writes the four-field shape on a fresh fetch; `getBriefingNotice` may write a one-field update (`lastBriefingShownAt` only) without touching the others — implemented as read-modify-write of the JSON.

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

- `scripts/release.sh` (or the equivalent — confirm during planning) gains a step: prompt for a one-line headline before `npm publish`, write it to `package.json` under `aiCortex.releaseHeadline`, then proceed. After publish, the field is left in place (the dev tree mirrors the published manifest). An empty string is a valid value — falls back to the generic "newer version available" form.
- One-line headline conventions: ≤ 60 chars, present-tense feature summary (matches the leading bullet style of CHANGELOG.md entries). The release-script prompt shows the previous headline for reference; pressing Enter accepts the previous value to make patch-release scripting frictionless.

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

**`src/mcp/rehydrate.ts`:**

- Reads the running package version from the bundled `package.json` (the existing project-meta read path already does this — reuse, do not duplicate).
- Calls `getBriefingNotice` and passes the result into `renderBriefing` as `{ notice }`. A thrown notifier is caught and treated as `null` — defense in depth even though `getBriefingNotice` itself never throws.

**CLI entry (`src/cli.ts`):**

- `printUpdateNotice` updated to consume the new `checkForUpdate` return shape and render via the tier-aware `formatNotice` with `surface: "cli"`. No new CLI flags.

**`scripts/release.sh` (or the actual release script):**

- New step before `npm publish`: read previous `aiCortex.releaseHeadline` from `package.json`, prompt for a new one (default = previous), write back. Implementation must be idempotent (re-running the release script doesn't accumulate cruft).
- A dedicated unit test verifies the JSON manipulation; the prompt step is excluded from automated test (interactive).

## 8. Data flow (one cycle, MCP path)

```
1. Agent calls rehydrate_project.
2. rehydrate.ts:
     currentVersion = require('../../package.json').version
     notice = getBriefingNotice({ currentVersion })
     return renderBriefing(cache, { notice })
3. getBriefingNotice:
     env AI_CORTEX_NO_UPDATE_CHECK? → null
     cache = readCache(cachePath())
     if !cache || isCacheStale(cache.checkedAt): spawnBackgroundFetch()
     if !cache: return null   # nothing to compare against yet
     tier = compareSeverity(currentVersion, cache.latestVersion)
     if tier === "none": return null
     if tier === "patch" and shownTodayUTC(cache.lastBriefingShownAt): return null
     if tier === "patch": writeCache({ ...cache, lastBriefingShownAt: nowIso })
     return formatNotice({ current: currentVersion, latest: cache.latestVersion,
                           headline: cache.releaseHeadline,
                           tier, surface: "mcp" })
4. renderBriefing(cache, { notice }):
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
- **v2 (deferred).** Multi-version "behind on these releases:" enumeration. When `tier === "multi-minor"`, fetch the full `/ai-cortex` registry doc, walk the intervening versions from `currentVersion` to `latestVersion`, list each's `aiCortex.releaseHeadline`. Adds a second / heavier fetch and a multi-version cache. Skipped now because the single-headline + `N releases behind` count is sufficient for the immediate win; the doc fetch and a multi-version cache are non-trivial.
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
- `src/mcp/rehydrate.ts` — MCP-side caller
- `docs/superpowers/specs/2026-05-19-adoption-telemetry-design.md` — Phase 11 telemetry (related: telemetry on this path is in §12)
- `KNOWN_LIMITATIONS.md` — *Adoption / agent integration* (the existing "MCP tool discovery is best-effort" entry; this design partially addresses one slice of that)

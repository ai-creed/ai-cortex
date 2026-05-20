# AGENTS.md

Repository conventions for AI agents (Claude Code, Codex, others) working on ai-cortex. Keep this file focused: write down only the conventions a fresh agent would otherwise have to infer.

## CHANGELOG entries

Every release entry in `CHANGELOG.md` follows the **v0.5.0 style**: a narrative intro paragraph + Keep-a-Changelog subsections. Avoid flat conventional-commit listings (the v0.6.0–v0.10.0 entries were drifted into that shape; v0.10.1+ corrects back to this convention).

### Required shape

```markdown
## v0.X.Y — YYYY-MM-DD

<One short paragraph framing what this release IS. Lead with the user-visible
theme, not a list of commits. Mention the inviolable contract or the central
constraint if it explains the design.>

### Added
- **<headline phrase>** — <body explaining WHY/HOW, not just WHAT. Include
  tradeoffs, rationale, and inviolable contracts (e.g. "always-allow,
  fail-open") inline where they belong.>

### Changed
- **<headline phrase>** — <body>

### Fixed
- **<headline phrase>** — <body, including the symptom that motivated the fix>

### Internal
- <Items invisible to users but useful for archaeology: test scaffolding,
  lint sweeps, dependency bumps, internal-API renames. Plain bullets.>

### Known limitations (new this release)
- **<headline>** — <what's deferred, why, and what would unlock it.>
```

### Conventions

- Use **bold lead phrases** to give each bullet a scanable header, then an em-dash (`—`), then the prose.
- Prefer two-clause bullets: "what + why" or "what + how". Avoid single-clause `feat: did X` bullets — those belong in commit messages, not changelogs.
- Skip a section if there's nothing in it (don't write "None" or "N/A").
- Cross-link related work: spec paths, preceding releases, future releases that depend on this one.
- For burned tags (released but never published — e.g. CI gate failed the publish workflow), keep a short tombstone entry explaining the burn and pointing at the successor.

### When writing a new release entry

1. Run `git log --no-merges --pretty='%h %s' <prev-tag>..HEAD` to list commits in scope.
2. Group commits by **user-visible theme** (`Added` / `Changed` / `Fixed` / `Internal`), not by chronological order or commit prefix.
3. For each theme, write the narrative WHY/HOW — what was the user-visible problem, what's the new behavior, what tradeoff did we accept.
4. Cross-check against `KNOWN_LIMITATIONS.md` — did this release resolve an entry? Did it add a new one?
5. Write the intro paragraph LAST, after the sections are settled — it's a synthesis, not a teaser.

## Release process

- **Always run `CI=true pnpm test` before tagging.** Local `pnpm test` is not equivalent to CI — `shouldCheck()` in `src/lib/update-notifier.ts` and similar production code gates on `process.env.CI`. A green local run can still be red in GitHub Actions. The v0.10.1 tag was burned by exactly this gap.
- **Always run `pnpm build` before tagging.** `tests/integration/cli.test.ts` spawns `dist/src/cli.js` and only rebuilds when dist is *missing*, not when it's stale. After a `src/version.ts` bump the dist binary will silently print the old version.
- Commit the new CHANGELOG entry **before** running `scripts/release.sh <version>` — the release script bumps to a new version and doesn't touch `CHANGELOG.md`.
- `scripts/release.sh <version>` handles the version bump, `src/version.ts` lockstep, `aiCortex.releaseHeadline` prompt, commit, tag, and push. It supports `AI_CORTEX_RELEASE_HEADLINE='<value>'` as a non-interactive escape hatch (use `'-'` to clear the previous headline).
- GitHub CD publishes to npm on the tag push (`.github/workflows/publish.yml`). There is no in-script `npm publish`.

## Don't write to user repos

- ai-cortex MUST NOT create or modify any file inside a target repository. All state lives under `~/.cache/ai-cortex/`.
- Project-owner files (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*`, `PROJECT_INDEX.md`, etc.) in user repos are off-limits.
- Hook installation under `~/.claude/settings.json` and `~/.codex/config.toml` is the explicit exception — those are user-owned config, not repo-owned, and the user runs `ai-cortex history install-hooks` to opt in.

## Memory consultation

The repository uses ai-cortex's own memory layer. Before non-trivial edits to unfamiliar files, consult `recall_memory` with scoped queries. After picking a relevant hit, call `get_memory(id)` to actually use it — that's the consult signal that drives cleanup eligibility. `recall_memory` is browse-only and does not signal usage.

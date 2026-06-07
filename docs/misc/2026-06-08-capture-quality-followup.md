# Capture quality follow-up

**Date:** 2026-06-08
**Status:** Observation / future work — not yet actioned

## What happened

Ran the weekly capture-audit procedure (`~/.claude/scripts/capture-audit-prompt.txt`)
across four workspaces: ai-14all, ai-cortex, ai-whisper, ai-ezio.

| Workspace | Reviewed | Rewritten (kept) | Deprecated (noise) | Untouched |
|---|---:|---:|---:|---:|
| ai-14all  | 27  | 2  | 25  | 0 |
| ai-cortex | 44  | 1  | 43  | 0 |
| ai-whisper| 25  | 4  | 20  | 1 |
| ai-ezio   | 44  | 4  | 40  | 0 |
| **Total** | **140** | **11** | **128** | **1** |

## The signal

**~91% of captures (128 / 140) were transient session chatter** with no durable value:

- user-interrupt markers (`[Request interrupted by user]`)
- resume / kickoff prompts (`Continue from where you left off`, `Let resume with current phase`)
- one-off task instructions (`merge the branch`, `write the spec`, `deflake the test`, `Park it for now`)
- screenshot paths
- environment-context blocks and cache/error dumps
- superseded mid-session iterative tweaks (e.g. graph/visual changes later replaced)

Only 11 captures (~8%) encoded anything worth promoting to an active memory.

## Why look into it later

The capture extractor is paying a low signal-to-noise ratio: a human (or agent)
has to triage ~12 noise items for every keeper. That cost discourages running the
audit and bloats the candidate store.

Worth investigating to raise capture precision at extraction time, e.g.:

- Filter obvious noise classes before they become candidates: interrupt markers,
  bare resume/kickoff phrases, screenshot-only paths, environment-context blocks.
- Down-weight or skip transient imperative task instructions that have no reusable rule.
- Detect superseded mid-session tweaks (later capture in same file/session overrides earlier).
- Revisit the `signalScore` heuristic — in this batch nearly all kept items were the
  rare non-zero scores, suggesting the score is directionally right but the floor is too low.

## Pointers

- Procedure / prompt: `~/.claude/scripts/capture-audit-prompt.txt`
- Runner + cron: `~/.claude/scripts/weekly-capture-audit.sh` (cron `0 9 * * 1`; has never run — no log at `~/.claude/logs/weekly-capture-audit.log`)
- Capture redesign spec: `docs/superpowers/specs/2026-05-17-memory-capture-redesign-design.md`

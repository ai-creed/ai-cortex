// Wired via vitest.config.ts setupFiles. Pins a deterministic session id so
// tests never fall through to `detectCurrentSession`'s filesystem heuristic,
// which scans the dev machine's real ~/.claude/projects and ~/.codex history.
// That scan is machine-specific and slow (it can exceed the 5s test timeout on
// an active workstation), and the value it returns is non-deterministic.
//
// Production always runs with a session env var set (CLAUDE_SESSION_ID or
// AI_CORTEX_SESSION_ID), so pinning one here mirrors real usage and takes the
// fast env path in `detectCurrentSession`. Set only when unset, so an outer
// environment (real CI, a developer override) still wins.
//
// Tests that assert the *no-env* detection path delete these in their own
// beforeEach (see tests/unit/lib/history/session-detect.test.ts), so this
// default never interferes with them.
process.env.AI_CORTEX_SESSION_ID ??= "vitest-session";

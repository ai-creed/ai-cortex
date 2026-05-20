// src/lib/migration-notifier.ts
//
// Detect-and-notify path for stale hook configuration. Mirrors update-notifier's
// shape: a top-level try/catch guarantees a briefing render can never crash on
// our behalf, and AI_CORTEX_NO_UPDATE_CHECK suppresses the notice for symmetry
// with the update nudge.
//
// Neutral wording: the underlying `installHooks` writes to BOTH ~/.claude and
// ~/.codex configs. PreToolUse semantics differ between the two ecosystems
// (Codex 0.130.x doesn't fire PreToolUse for apply_patch/Bash regardless of
// installation state). Saying "Edit/Write surface won't fire" would be wrong
// on Codex — so the notice stays vague and points the user at the install
// command, which will show them the exact diff before applying.

import { hooksMigrationStatus } from "./history/hooks-install.js";

export function getHookMigrationNotice(): string | null {
	try {
		if (process.env.AI_CORTEX_NO_UPDATE_CHECK) return null;
		const { needsInstall } = hooksMigrationStatus();
		if (!needsInstall) return null;
		return [
			"ai-cortex hook configuration out of date — some features won't activate.",
			"Run: ai-cortex history install-hooks",
		].join("\n");
	} catch {
		return null;
	}
}

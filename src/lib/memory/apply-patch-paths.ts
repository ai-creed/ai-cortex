// src/lib/memory/apply-patch-paths.ts

/**
 * Extract the set of file paths a Codex `apply_patch` body touches.
 * Recognizes the envelope lines `*** Add File:`, `*** Update File:`,
 * `*** Delete File:` and rename target `*** Move to:`. Pure and total:
 * any unparseable input yields []. Order-stable, de-duplicated.
 *
 * NOTE: that the patch body arrives as `tool_input.command` is an
 * unverified Codex assumption (spec §13 BLOCKER); this parser is only
 * wired into an enabled Codex hook once the fixture gate clears.
 */
// Codex envelope tokens are capitalized; matching is case-sensitive by design.
const ENVELOPE =
	/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$|^\*\*\* Move to:\s*(.+?)\s*$/;

export function parseApplyPatchPaths(command: string): string[] {
	if (typeof command !== "string" || command.length === 0) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const line of command.split("\n")) {
		const m = ENVELOPE.exec(line);
		if (!m) continue;
		const p = (m[1] ?? m[2] ?? "").trim();
		if (p.length === 0 || seen.has(p)) continue;
		seen.add(p);
		out.push(p);
	}
	return out;
}

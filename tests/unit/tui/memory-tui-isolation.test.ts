import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const TUI_DIR = path.resolve(__dirname, "../../../src/tui");

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p));
		else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
	}
	return out;
}

describe("memory TUI isolation", () => {
	it("no src/tui file imports src/lib/memory/* at all (spec constraint)", () => {
		const offenders: string[] = [];
		for (const file of walk(TUI_DIR)) {
			const src = fs.readFileSync(file, "utf8");
			// Spec: the TUI must not import src/lib/memory/* directly — not even
			// type-only. MemoryRecord is consumed via the re-export from
			// src/lib/stats/memory-browser.ts. Any /lib/memory/ import here
			// is a boundary violation.
			if (/from\s+["'][^"']*\/lib\/memory\//.test(src)) {
				offenders.push(path.relative(TUI_DIR, file));
			}
		}
		expect(offenders).toEqual([]);
	});
});

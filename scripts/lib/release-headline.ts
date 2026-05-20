// scripts/lib/release-headline.ts
//
// Pure JSON read-modify-write for package.json's aiCortex.releaseHeadline.
// Called from scripts/release.sh via `pnpm exec tsx`. Interactive prompting
// lives in bash. The unit tests in tests/unit/scripts/release-headline.test.ts
// cover the full surface.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

function detectIndent(raw: string): string {
	const m = raw.match(/\n([ \t]+)"/);
	return m ? m[1] : "\t";
}

export function readHeadline(pkgPath: string): string {
	const raw = fs.readFileSync(pkgPath, "utf-8");
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const aiCortex = parsed.aiCortex;
	if (typeof aiCortex !== "object" || aiCortex === null) return "";
	const v = (aiCortex as Record<string, unknown>).releaseHeadline;
	return typeof v === "string" ? v : "";
}

export function writeHeadline(pkgPath: string, value: string): void {
	const raw = fs.readFileSync(pkgPath, "utf-8");
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const indent = detectIndent(raw);
	const trailingNewline = raw.endsWith("\n") ? "\n" : "";
	if (typeof parsed.aiCortex !== "object" || parsed.aiCortex === null) {
		parsed.aiCortex = {};
	}
	(parsed.aiCortex as Record<string, unknown>).releaseHeadline = value;
	fs.writeFileSync(
		pkgPath,
		JSON.stringify(parsed, null, indent) + trailingNewline,
	);
}

// CLI dispatch when run directly via `pnpm exec tsx scripts/lib/release-headline.ts`.
// Compare realpaths of import.meta.url and process.argv[1] — robust against
// /tmp ↔ /private/tmp symlinks on macOS (same realpath issue solved earlier in
// the repo-identity path).
function isMainModule(): boolean {
	if (!process.argv[1]) return false;
	try {
		const here = fs.realpathSync(fileURLToPath(import.meta.url));
		const entry = fs.realpathSync(process.argv[1]);
		return here === entry;
	} catch {
		return false;
	}
}

if (isMainModule()) {
	const [, , cmd, pkgPath, ...rest] = process.argv;
	const file = pkgPath ?? "package.json";
	if (cmd === "read") {
		process.stdout.write(readHeadline(file));
		process.exit(0);
	} else if (cmd === "write") {
		writeHeadline(file, rest.join(" "));
		process.exit(0);
	} else {
		process.stderr.write(
			"Usage: release-headline.ts (read|write) <pkg.json> [value]\n",
		);
		process.exit(1);
	}
}

// scripts/replay-intake.ts
// Advisory-only live replay (spec §5): NOT a release gate, never in CI.
// Reports what the current gate+tier would do to live capture bodies, with
// coverage limits stated explicitly. Read-only. Run:
//   pnpm exec tsx scripts/replay-intake.ts [--json]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { structuralReject, captureTier } from "../src/lib/memory/gate.js";
import { isNoiseTaxonomyReason } from "../src/lib/memory/noise-taxonomy.js";

const V1 = path.join(os.homedir(), ".cache", "ai-cortex", "v1");
const json = process.argv.includes("--json");

type Stats = {
	buckets: number;
	captures: number;
	rejected: Record<string, number>;
	lowTier: number;
	highTier: number;
	deprecatedNoiseSuppressed: number;
	deprecatedNoiseTotal: number;
};
const stats: Stats = {
	buckets: 0,
	captures: 0,
	rejected: {},
	lowTier: 0,
	highTier: 0,
	deprecatedNoiseSuppressed: 0,
	deprecatedNoiseTotal: 0,
};

function bodyOf(text: string): string {
	const end = text.indexOf("\n---", 3);
	return end === -1 ? "" : text.slice(end + 4).trim();
}

for (const entry of fs.readdirSync(V1)) {
	const memDir = path.join(V1, entry, "memory", "memories");
	if (!fs.existsSync(memDir)) continue;
	stats.buckets++;
	for (const f of fs.readdirSync(memDir)) {
		if (!f.endsWith(".md")) continue;
		const text = fs.readFileSync(path.join(memDir, f), "utf8");
		if (!/^type: capture$/m.test(text)) continue;
		const body = bodyOf(text);
		if (!body) continue;
		stats.captures++;
		const rule = structuralReject(body);
		const suppressed = rule !== null || captureTier(body) === "low";
		if (rule) stats.rejected[rule] = (stats.rejected[rule] ?? 0) + 1;
		else if (captureTier(body) === "low") stats.lowTier++;
		else stats.highTier++;
		// Spec §5: the suppression metric counts ONLY deprecated captures whose
		// reason is in the noise taxonomy — superseded/consolidated captures are
		// judgment calls, not intake noise, and must not inflate the denominator.
		if (/^status: deprecated$/m.test(text)) {
			const reasonMatch = /^deprecationReason: (.*)$/m.exec(text);
			const rawReason = reasonMatch?.[1]?.trim().replace(/^["']|["']$/g, "");
			const reason = rawReason === "null" ? null : rawReason;
			if (isNoiseTaxonomyReason(reason)) {
				stats.deprecatedNoiseTotal++;
				if (suppressed) stats.deprecatedNoiseSuppressed++;
			}
		}
	}
}

if (json) {
	process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
} else {
	const pct = (n: number, d: number) =>
		d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
	console.log(`buckets scanned:        ${stats.buckets}`);
	console.log(`capture bodies:         ${stats.captures}`);
	console.log(`  gate-rejected:        ${Object.values(stats.rejected).reduce((a, b) => a + b, 0)}`);
	for (const [rule, n] of Object.entries(stats.rejected).sort((a, b) => b[1] - a[1]))
		console.log(`    ${rule.padEnd(28)} ${n}`);
	console.log(`  low tier (would trash): ${stats.lowTier}`);
	console.log(`  high tier (candidate):  ${stats.highTier}`);
	console.log(
		`deprecated-capture suppression: ${pct(stats.deprecatedNoiseSuppressed, stats.deprecatedNoiseTotal)} (${stats.deprecatedNoiseSuppressed}/${stats.deprecatedNoiseTotal})`,
	);
	console.log(
		"\nCOVERAGE LIMITS: live rewritten cards no longer hold intake bodies, so gem",
	);
	console.log(
		"loss is NOT measurable here — the committed snapshot corpus is the only gem",
	);
	console.log("gate (tests/unit/lib/memory/replay-gate.test.ts).");
}

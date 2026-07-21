// scripts/harvest-intake-corpus.ts
// Pre-drain harvest (spec §5): dump candidate-capture bodies for TIER-BLIND
// labeling. Output deliberately omits tier/gate columns — the labeler judges
// gem/noise from the body alone. Read-only over the live cache.
// Run: pnpm exec tsx scripts/harvest-intake-corpus.ts > /tmp/harvest.json
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const V1 = path.join(os.homedir(), ".cache", "ai-cortex", "v1");

type Row = { ref: string; body: string };
const rows: Row[] = [];

function walkBucket(dir: string, label: string): void {
	const memDir = path.join(dir, "memory", "memories");
	if (!fs.existsSync(memDir)) return;
	for (const f of fs.readdirSync(memDir)) {
		if (!f.endsWith(".md")) continue;
		const text = fs.readFileSync(path.join(memDir, f), "utf8");
		if (!/^type: capture$/m.test(text) || !/^status: candidate$/m.test(text))
			continue;
		const end = text.indexOf("\n---", 3);
		const body = end === -1 ? "" : text.slice(end + 4).trim();
		if (body.length === 0) continue;
		rows.push({ ref: `${label}/${f.replace(/\.md$/, "")}`, body });
	}
}

for (const entry of fs.readdirSync(V1)) {
	const p = path.join(V1, entry);
	// Skip the archive bucket and the nested legacy `Users` bucket — neither
	// holds live candidate captures for the pre-drain harvest.
	if (!fs.statSync(p).isDirectory() || entry === "_archived" || entry === "Users")
		continue;
	walkBucket(p, entry);
}

// deterministic order (no Math.random): sort by ref hash-ish
rows.sort((a, b) => a.ref.localeCompare(b.ref));
process.stdout.write(JSON.stringify(rows, null, 1) + "\n");

// AGGREGATE tier populations to STDERR — needed to fill HARVEST_COVERAGE
// without unblinding any individual row (stdout stays tier-free).
const { captureTier } = await import("../src/lib/memory/gate.js");
let high = 0;
let zero = 0;
for (const r of rows) {
	if (captureTier(r.body) === "high") high++;
	else zero++;
}
process.stderr.write(
	`populations: highTier=${high} zeroSignal=${zero} total=${rows.length}\n`,
);

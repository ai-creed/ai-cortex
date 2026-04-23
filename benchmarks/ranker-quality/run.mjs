#!/usr/bin/env node
// benchmarks/ranker-quality/run.mjs
// Usage: node benchmarks/ranker-quality/run.mjs --repo /path/to/target-repo \
//          [--corpus path/to/corpus.json] [--query-source title|card|both]
//
// Runs fast, deep, semantic, and deep+semantic (RRF) against the corpus.
// Default --query-source=both runs each mode with PR title AND distilled card query
// (the latter is only present when the corpus entries have a `query` field).
// Writes out/aggregate.md and out/per-pr.md.
// Requires BENCH_RANKER_REPO env var or --repo flag pointing to a repo clone.
// Must run `pnpm build` first.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const CLI = path.join(ROOT, "dist/src/cli.js");

// --- CLI arg parsing ---
let repoPath = process.env["BENCH_RANKER_REPO"] ?? null;
let corpusPath = path.join(__dirname, "corpus-example.json");
let querySource = "both"; // title | card | both
for (let i = 2; i < process.argv.length; i++) {
	if (process.argv[i] === "--repo" && process.argv[i + 1]) {
		repoPath = process.argv[++i];
	} else if (process.argv[i] === "--corpus" && process.argv[i + 1]) {
		corpusPath = process.argv[++i];
	} else if (process.argv[i] === "--query-source" && process.argv[i + 1]) {
		querySource = process.argv[++i];
	}
}
if (!repoPath) {
	process.stderr.write("Usage: node run.mjs --repo /path/to/target-repo [--corpus path] [--query-source title|card|both]\n  or set BENCH_RANKER_REPO env var\n");
	process.exit(1);
}
const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
if (!["title", "card", "both"].includes(querySource)) {
	process.stderr.write(`Invalid --query-source: ${querySource} (expected title|card|both)\n`);
	process.exit(1);
}
const sources = querySource === "both" ? ["title", "card"] : [querySource];

// --- Build first ---
process.stderr.write("[bench] building...\n");
execFileSync("pnpm", ["build"], { cwd: ROOT, stdio: "ignore" });
process.stderr.write("[bench] build done.\n");

// --- Warmup index + semantic sidecar ---
process.stderr.write("[bench] warming up index...\n");
spawnSync("node", [CLI, "index", repoPath], { encoding: "utf8" });
// Build semantic sidecar before bench loop (first call downloads model ~23 MB).
process.stderr.write("[bench] warming semantic sidecar (first call may download ~23 MB)...\n");
spawnSync("node", [CLI, "suggest-semantic", "warmup", "--path", repoPath, "--limit", "1"], { encoding: "utf8" });
process.stderr.write("[bench] warmup complete.\n");

// --- Run one mode ---
function runMode(title, repoPath, mode) {
	// semantic errors if --stale is passed with no sidecar; warm it up before bench loop instead
	const args = mode === "semantic"
		? [CLI, "suggest-semantic", title, "--path", repoPath, "--json", "--limit", "60"]
		: [CLI, mode === "deep" ? "suggest-deep" : "suggest", title, repoPath, "--json", "--limit", "60"];
	if (mode !== "semantic") args.push("--stale");
	if (mode === "deep") args.push("--pool", "60");
	const r = spawnSync("node", args, { encoding: "utf8", timeout: 30_000 });
	if (r.status !== 0) return null;
	try {
		return JSON.parse(r.stdout);
	} catch {
		return null;
	}
}

// --- RRF fusion ---
function rrf(listA, listB, k = 60) {
	const scores = new Map();
	for (const [rank, item] of listA.entries()) {
		const p = item.path;
		scores.set(p, (scores.get(p) ?? 0) + 1 / (k + rank + 1));
	}
	for (const [rank, item] of listB.entries()) {
		const p = item.path;
		scores.set(p, (scores.get(p) ?? 0) + 1 / (k + rank + 1));
	}
	return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p]) => p);
}

// --- Metrics ---
function metrics(top5Paths, truth) {
	const truthSet = new Set(truth);
	const hits = top5Paths.filter((p) => truthSet.has(p)).length;
	const hit5 = hits > 0 ? 1 : 0;
	const p5 = hits / 5;
	const r5 = hits / truth.length;
	return { hit5, p5, r5 };
}

// --- Run all ---
const modes = ["fast", "deep", "semantic"];
const results = [];

function queryFor(pr, source) {
	if (source === "card") return pr.query ?? pr.title;
	return pr.title;
}

for (const pr of corpus.prs) {
	process.stderr.write(`[bench] PR #${pr.pr}...\n`);
	const row = { pr: pr.pr, title: pr.title, query: pr.query ?? null, truth: pr.truth };

	for (const source of sources) {
		const queryText = queryFor(pr, source);
		for (const mode of modes) {
			const res = runMode(queryText, repoPath, mode);
			const allPaths = res?.results?.map((r) => r.path) ?? [];
			const top5 = allPaths.slice(0, 5);
			row[`${source}_${mode}`] = { top5, allPaths, ...metrics(top5, pr.truth), durationMs: res?.durationMs ?? 0 };
		}

		// RRF fusion: fuse full top-60 lists from deep + semantic, output top-5
		const rrfTop5 = rrf(
			row[`${source}_deep`]?.allPaths.map((p) => ({ path: p })) ?? [],
			row[`${source}_semantic`]?.allPaths.map((p) => ({ path: p })) ?? [],
		);
		row[`${source}_rrf`] = { top5: rrfTop5, ...metrics(rrfTop5, pr.truth) };
	}

	results.push(row);
}

// --- Aggregate ---
function agg(key) {
	const hit = results.reduce((s, r) => s + (r[key]?.hit5 ?? 0), 0);
	const p = results.reduce((s, r) => s + (r[key]?.p5 ?? 0), 0) / results.length;
	const rec = results.reduce((s, r) => s + (r[key]?.r5 ?? 0), 0) / results.length;
	return { hit, p: (p * 100).toFixed(1), r: (rec * 100).toFixed(1) };
}

const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });

let agg_md = "# Ranker Quality Benchmark\n\n";
agg_md += `**Date:** ${new Date().toISOString().slice(0, 10)}\n`;
agg_md += `**Query source:** ${querySource}\n\n`;
agg_md += "| Source | Mode | hit@5 | P@5 | R@5 |\n|---|---|---:|---:|---:|\n";
for (const source of sources) {
	for (const m of ["fast", "deep", "semantic", "rrf"]) {
		const a = agg(`${source}_${m}`);
		agg_md += `| ${source} | ${m} | ${a.hit}/20 | ${a.p}% | ${a.r}% |\n`;
	}
}

fs.writeFileSync(path.join(outDir, "aggregate.md"), agg_md);
process.stdout.write(agg_md);

// --- Per-PR ---
let perpr_md = "# Per-PR Results\n\n";
for (const row of results) {
	perpr_md += `## PR #${row.pr} — ${row.title}\n\n`;
	perpr_md += `Truth: ${row.truth.join(", ")}\n\n`;
	if (row.query) perpr_md += `Card query: \`${row.query}\`\n\n`;
	perpr_md += "| Source | Mode | hit@5 | Top-5 |\n|---|---|---|---|\n";
	for (const source of sources) {
		for (const m of ["fast", "deep", "semantic", "rrf"]) {
			const r = row[`${source}_${m}`];
			perpr_md += `| ${source} | ${m} | ${r?.hit5 ?? 0} | ${(r?.top5 ?? []).map((p) => (new Set(row.truth).has(p) ? `✅ \`${p}\`` : `\`${p}\``)).join("<br>")} |\n`;
		}
	}
	perpr_md += "\n---\n\n";
}

fs.writeFileSync(path.join(outDir, "per-pr.md"), perpr_md);
process.stderr.write(`[bench] results written to ${outDir}/\n`);

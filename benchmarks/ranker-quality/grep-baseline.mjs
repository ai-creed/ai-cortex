#!/usr/bin/env node
// benchmarks/ranker-quality/grep-baseline.mjs
// Compares ai-cortex results to naive grep baselines (filename grep, content grep)
// against the corpus provided via --corpus (default: corpus-example.json).
//
// Usage: node benchmarks/ranker-quality/grep-baseline.mjs --repo /path/to/target-repo \
//          [--corpus path/to/corpus.json]
//        BENCH_RANKER_REPO=/path/to/target-repo node benchmarks/ranker-quality/grep-baseline.mjs

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let repoPath = process.env["BENCH_RANKER_REPO"] ?? null;
let corpusPath = path.join(__dirname, "corpus-example.json");
for (let i = 2; i < process.argv.length; i++) {
	if (process.argv[i] === "--repo" && process.argv[i + 1]) {
		repoPath = process.argv[++i];
	} else if (process.argv[i] === "--corpus" && process.argv[i + 1]) {
		corpusPath = process.argv[++i];
	}
}
if (!repoPath) {
	process.stderr.write("Usage: grep-baseline.mjs --repo /path/to/target-repo [--corpus path]\n");
	process.exit(1);
}
const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));

// Stopword set mirrors src/lib/tokenize.ts STOPWORDS (post "my" removal).
const STOPWORDS = new Set([
	"a", "an", "the", "of", "in", "on", "at", "to", "for", "from",
	"by", "with", "and", "or", "is", "are", "be",
	"your", "our", "this", "that", "new",
	"src", "lib", "index", "utils", "helper", "helpers", "common",
]);

// Extract top N content keywords from a title — lowercase, stopword-stripped,
// len >= 4 preferred (proxy for "rare enough to be useful").
function keywordsFrom(title, n = 2) {
	const words = title
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, " ")
		.split(/\s+/u)
		.filter((w) => w && !STOPWORDS.has(w) && w.length >= 4);
	return words.slice(0, n);
}

// Filename grep: which files have any of the keywords in their path?
function filenameGrep(repo, keywords) {
	const r = spawnSync("git", ["-C", repo, "ls-files"], { encoding: "utf8" });
	if (r.status !== 0) return [];
	const all = r.stdout.split("\n").filter(Boolean);
	const kws = keywords.map((k) => k.toLowerCase());
	return all.filter((f) => {
		const p = f.toLowerCase();
		return kws.some((k) => p.includes(k));
	});
}

// Content grep: git grep -l -i for ANY keyword (OR, via alternation).
function contentGrep(repo, keywords) {
	if (keywords.length === 0) return [];
	const pattern = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
	const r = spawnSync(
		"git",
		["-C", repo, "grep", "-l", "-i", "-E", pattern],
		{ encoding: "utf8", timeout: 30_000, maxBuffer: 50 * 1024 * 1024 },
	);
	// grep exits 1 when no match. status 0 or 1 both valid.
	if (r.status !== 0 && r.status !== 1) return [];
	return (r.stdout ?? "").split("\n").filter(Boolean);
}

function metrics(top5, truth) {
	const truthSet = new Set(truth);
	const hits = top5.filter((p) => truthSet.has(p)).length;
	return {
		hit5: hits > 0 ? 1 : 0,
		p5: hits / 5,
		r5: hits / truth.length,
	};
}

const results = [];
for (const pr of corpus.prs) {
	process.stderr.write(`[grep-bl] PR #${pr.pr}...\n`);
	const kws = keywordsFrom(pr.title, 2);

	const fnMatches = filenameGrep(repoPath, kws);
	const fnTop5 = fnMatches.sort().slice(0, 5);

	const contentMatches = contentGrep(repoPath, kws);
	const contentTop5 = contentMatches.sort().slice(0, 5);

	results.push({
		pr: pr.pr,
		title: pr.title,
		truth: pr.truth,
		keywords: kws,
		filename: {
			total: fnMatches.length,
			top5: fnTop5,
			...metrics(fnTop5, pr.truth),
		},
		content: {
			total: contentMatches.length,
			top5: contentTop5,
			...metrics(contentTop5, pr.truth),
		},
	});
}

function agg(key) {
	const hit = results.reduce((s, r) => s + r[key].hit5, 0);
	const p = results.reduce((s, r) => s + r[key].p5, 0) / results.length;
	const rec = results.reduce((s, r) => s + r[key].r5, 0) / results.length;
	const medTotal = [...results.map((r) => r[key].total)].sort((a, b) => a - b)[Math.floor(results.length / 2)];
	return { hit, p: (p * 100).toFixed(1), r: (rec * 100).toFixed(1), medTotal };
}

const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });

const fnA = agg("filename");
const cA = agg("content");
const n = results.length;
let md = "# Grep Baseline vs ai-cortex\n\n";
md += `**Date:** ${new Date().toISOString().slice(0, 10)}\n\n`;
md += "Keywords per PR: first 2 non-stopword tokens (len ≥ 4) from PR title.\n";
md += "Top-5 = first 5 files from grep result sorted alphabetically.\n\n";
md += "| Strategy | hit@5 | P@5 | R@5 | median result-set size |\n|---|---:|---:|---:|---:|\n";
md += `| filename grep (path contains keyword) | ${fnA.hit}/${n} | ${fnA.p}% | ${fnA.r}% | ${fnA.medTotal} |\n`;
md += `| content grep (any file with keyword) | ${cA.hit}/${n} | ${cA.p}% | ${cA.r}% | ${cA.medTotal} |\n`;
md += "\nRun `run.mjs` against the same repo to compare these numbers to cortex fast/deep/semantic/rrf.\n";

md += "\n## Per-PR detail\n\n";
for (const row of results) {
	md += `### PR #${row.pr} — keywords: \`${row.keywords.join(", ")}\`\n\n`;
	md += `Truth: ${row.truth.join(", ")}\n\n`;
	md += `- filename grep: ${row.filename.total} results, hit@5=${row.filename.hit5}\n`;
	if (row.filename.top5.length > 0) {
		md += `  top-5: ${row.filename.top5.map((p) => (row.truth.includes(p) ? `✅ \`${p}\`` : `\`${p}\``)).join(", ")}\n`;
	}
	md += `- content grep: ${row.content.total} results, hit@5=${row.content.hit5}\n`;
	if (row.content.top5.length > 0) {
		md += `  top-5: ${row.content.top5.map((p) => (row.truth.includes(p) ? `✅ \`${p}\`` : `\`${p}\``)).join(", ")}\n`;
	}
	md += "\n";
}

fs.writeFileSync(path.join(outDir, "grep-baseline.md"), md);
process.stdout.write(md.split("\n## Per-PR detail")[0]);
process.stderr.write(`\nFull detail: ${path.join(outDir, "grep-baseline.md")}\n`);

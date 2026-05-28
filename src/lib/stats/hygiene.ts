// src/lib/stats/hygiene.ts
//
// TUI-driven workspace hygiene. Three operations: exclude (config-only,
// reversible), archive (move cache dir to _archived/, recoverable), and
// clean (delete cache dir, irreversible). Every operation passes through
// assertRepoKey before touching the filesystem.
import fs from "node:fs";
import path from "node:path";
import { archiveDir, cacheRoot, statsConfigPath } from "./paths.js";

const REPO_KEY_RE = /^[a-f0-9]{16}$/;

export function assertRepoKey(s: string): void {
	if (typeof s !== "string" || !REPO_KEY_RE.test(s)) {
		throw new Error(`invalid repoKey (expected 16-hex): ${JSON.stringify(s)}`);
	}
}

type ConfigV1 = { version: 1; excluded: string[] };

function readConfig(): ConfigV1 {
	const empty: ConfigV1 = { version: 1, excluded: [] };
	let raw: string;
	try {
		raw = fs.readFileSync(statsConfigPath(), "utf8");
	} catch {
		return empty;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		process.stderr.write(
			`ai-cortex: stats-config.json is malformed; ignoring. (${(e as Error).message})\n`,
		);
		return empty;
	}
	if (!parsed || typeof parsed !== "object") return empty;
	const obj = parsed as Record<string, unknown>;
	if (obj.version !== 1) {
		process.stderr.write(
			`ai-cortex: stats-config.json version ${String(obj.version)} unknown; ignoring.\n`,
		);
		return empty;
	}
	const arr = Array.isArray(obj.excluded) ? obj.excluded : [];
	const excluded: string[] = [];
	for (const x of arr) {
		if (typeof x === "string" && REPO_KEY_RE.test(x)) {
			excluded.push(x);
		} else {
			const token = JSON.stringify(typeof x === "string" ? x.slice(0, 80) : x);
			process.stderr.write(
				`ai-cortex: stats-config.json: ignoring invalid excluded entry ${token}\n`,
			);
		}
	}
	return { version: 1, excluded };
}

function writeConfigAtomic(cfg: ConfigV1): void {
	const final = statsConfigPath();
	fs.mkdirSync(cacheRoot(), { recursive: true });
	const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
	fs.renameSync(tmp, final);
}

export function readExcluded(): string[] {
	return readConfig().excluded.slice().sort();
}

export function excludeWorkspace(repoKey: string): void {
	assertRepoKey(repoKey);
	const cfg = readConfig();
	if (cfg.excluded.includes(repoKey)) return;
	cfg.excluded.push(repoKey);
	writeConfigAtomic(cfg);
}

export function archiveWorkspace(repoKey: string): void {
	assertRepoKey(repoKey);
	const src = path.join(cacheRoot(), repoKey);
	const dst = archiveDir(repoKey);
	if (!fs.existsSync(src)) {
		throw new Error(`archive source missing: ${src}`);
	}
	if (fs.existsSync(dst)) {
		throw new Error(`already archived (destination exists): ${dst}`);
	}
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	fs.renameSync(src, dst);
}

export function cleanWorkspace(repoKey: string): void {
	assertRepoKey(repoKey);
	const dir = path.join(cacheRoot(), repoKey);
	fs.rmSync(dir, { recursive: true, force: true });
}

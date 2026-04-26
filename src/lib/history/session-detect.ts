import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateSessionId } from "./store.js";

const KNOWN_HARNESS_ENV_VARS = [
	"CLAUDE_SESSION_ID",
	"CODEX_SESSION_ID",
	"CURSOR_SESSION_ID",
] as const;

export type DetectionSource = `env:${string}` | "mtime-heuristic";

export type DetectionResult = { sessionId: string; source: DetectionSource };

function safeSessionId(raw: string, source: string): DetectionResult | null {
	if (!/^[\w-]+$/.test(raw)) {
		process.stderr.write(`[ai-cortex] history: ignoring invalid session ID from ${source}: ${JSON.stringify(raw)}\n`);
		return null;
	}
	return { sessionId: raw, source: source as DetectionSource };
}

export function detectCurrentSession(opts: { cwd: string }): DetectionResult | null {
	const canon = process.env.AI_CORTEX_SESSION_ID;
	if (canon && canon.length > 0) {
		const r = safeSessionId(canon, "env:AI_CORTEX_SESSION_ID");
		if (r) return r;
	}
	for (const name of KNOWN_HARNESS_ENV_VARS) {
		const v = process.env[name];
		if (v && v.length > 0) {
			const r = safeSessionId(v, `env:${name}`);
			if (r) return r;
		}
	}
	const heuristic = mostRecentClaudeJsonl(opts.cwd);
	if (heuristic) {
		const r = safeSessionId(heuristic, "mtime-heuristic");
		if (r) {
			process.stderr.write(
				`[ai-cortex] history: using mtime-heuristic for current session — set AI_CORTEX_SESSION_ID for reliable detection\n`,
			);
			return r;
		}
	}
	return null;
}

function mostRecentClaudeJsonl(cwd: string): string | null {
	const dir = claudeProjectDir(cwd);
	if (!fs.existsSync(dir)) return null;
	let best: { id: string; mtime: number } | null = null;
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const stat = fs.statSync(path.join(dir, name));
		const mtime = stat.mtimeMs;
		if (!best || mtime > best.mtime) {
			best = { id: name.replace(/\.jsonl$/, ""), mtime };
		}
	}
	return best?.id ?? null;
}

function claudeProjectDir(cwd: string): string {
	const encoded = cwd.replace(/\//g, "-");
	return path.join(os.homedir(), ".claude", "projects", encoded);
}

export function resolveTranscriptPath(cwd: string, sessionId: string): string {
	validateSessionId(sessionId);
	return path.join(claudeProjectDir(cwd), `${sessionId}.jsonl`);
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateSessionId } from "./store.js";

// Claude Code sets CLAUDE_SESSION_ID in MCP server and subagent spawn environments.
const KNOWN_HARNESS_ENV_VARS = [
	"CLAUDE_SESSION_ID",
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
	const codexThread = process.env.CODEX_THREAD_ID;
	if (codexThread && codexThread.length > 0) {
		const r = safeSessionId(codexThread, "env:CODEX_THREAD_ID");
		if (r && findCodexTranscript(r.sessionId)) return r;
	}
	const codexHeuristic = mostRecentCodexHistorySession(opts.cwd);
	if (codexHeuristic) return { sessionId: codexHeuristic, source: "mtime-heuristic" };
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

function findCodexTranscript(sessionId: string): string | null {
	validateSessionId(sessionId);
	const root = path.join(os.homedir(), ".codex", "sessions");
	if (!fs.existsSync(root)) return null;
	const suffix = `-${sessionId}.jsonl`;
	const stack = [root];
	let best: { path: string; mtime: number } | null = null;
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(p);
			} else if (entry.isFile() && entry.name.endsWith(suffix)) {
				const mtime = fs.statSync(p).mtimeMs;
				if (!best || mtime > best.mtime) best = { path: p, mtime };
			}
		}
	}
	return best?.path ?? null;
}

function mostRecentCodexHistorySession(cwd: string): string | null {
	const historyPath = path.join(os.homedir(), ".codex", "history.jsonl");
	if (!fs.existsSync(historyPath)) return null;
	const lines = fs.readFileSync(historyPath, "utf8").split("\n").filter((line) => line.length > 0);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		let parsed: { session_id?: unknown };
		try {
			parsed = JSON.parse(lines[i]) as { session_id?: unknown };
		} catch {
			continue;
		}
		if (typeof parsed.session_id !== "string") continue;
		const r = safeSessionId(parsed.session_id, "codex-history");
		if (!r) continue;
		const transcript = findCodexTranscript(r.sessionId);
		if (transcript && codexTranscriptMatchesCwd(transcript, cwd)) return r.sessionId;
	}
	return null;
}

function codexTranscriptMatchesCwd(transcriptPath: string, cwd: string): boolean {
	const realCwd = fs.existsSync(cwd) ? fs.realpathSync(cwd) : cwd;
	for (const line of fs.readFileSync(transcriptPath, "utf8").split("\n")) {
		if (line.length === 0) continue;
		let parsed: { type?: string; payload?: { cwd?: unknown } };
		try {
			parsed = JSON.parse(line) as { type?: string; payload?: { cwd?: unknown } };
		} catch {
			continue;
		}
		if (parsed.type !== "session_meta") continue;
		const sessionCwd = parsed.payload?.cwd;
		if (typeof sessionCwd !== "string") return false;
		const realSessionCwd = fs.existsSync(sessionCwd) ? fs.realpathSync(sessionCwd) : sessionCwd;
		return realSessionCwd === realCwd;
	}
	return false;
}

function claudeProjectDir(cwd: string): string {
	const encoded = cwd.replace(/\//g, "-");
	return path.join(os.homedir(), ".claude", "projects", encoded);
}

export function resolveTranscriptPath(cwd: string, sessionId: string): string {
	validateSessionId(sessionId);
	const codex = findCodexTranscript(sessionId);
	if (codex) return codex;
	return path.join(claudeProjectDir(cwd), `${sessionId}.jsonl`);
}

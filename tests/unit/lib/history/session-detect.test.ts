import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectCurrentSession } from "../../../../src/lib/history/session-detect.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-detect-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
	delete process.env.AI_CORTEX_SESSION_ID;
	delete process.env.CLAUDE_SESSION_ID;
	delete process.env.CODEX_THREAD_ID;
	delete process.env.CODEX_SESSION_ID;
	delete process.env.CURSOR_SESSION_ID;
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function makeJsonl(projectDir: string, name: string, mtimeMs: number): string {
	fs.mkdirSync(projectDir, { recursive: true });
	const file = path.join(projectDir, name);
	fs.writeFileSync(file, "");
	fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
	return file;
}

describe("detectCurrentSession", () => {
	it("returns AI_CORTEX_SESSION_ID when set", () => {
		process.env.AI_CORTEX_SESSION_ID = "canon-id";
		const result = detectCurrentSession({ cwd: "/some/dir" });
		expect(result).toEqual({
			sessionId: "canon-id",
			source: "env:AI_CORTEX_SESSION_ID",
		});
	});

	it("AI_CORTEX_SESSION_ID takes precedence over CLAUDE_SESSION_ID", () => {
		process.env.AI_CORTEX_SESSION_ID = "canon";
		process.env.CLAUDE_SESSION_ID = "claude";
		const result = detectCurrentSession({ cwd: "/some/dir" });
		expect(result?.sessionId).toBe("canon");
	});

	it("falls through to CLAUDE_SESSION_ID when canonical unset", () => {
		process.env.CLAUDE_SESSION_ID = "claude-id";
		const result = detectCurrentSession({ cwd: "/some/dir" });
		expect(result).toEqual({
			sessionId: "claude-id",
			source: "env:CLAUDE_SESSION_ID",
		});
	});

	it("ignores CODEX_SESSION_ID and CURSOR_SESSION_ID (those tools use stdin JSON)", () => {
		process.env.CODEX_SESSION_ID = "codex-id";
		process.env.CURSOR_SESSION_ID = "cursor-id";
		const result = detectCurrentSession({ cwd: "/some/dir" });
		expect(result).toBeNull();
	});

	it("uses CODEX_THREAD_ID when the matching Codex rollout transcript exists", () => {
		process.env.CODEX_THREAD_ID = "019dc553-efaa-70f0-a753-e9bb4f75c038";
		const dir = path.join(tmp, ".codex", "sessions", "2026", "04", "25");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(
				dir,
				"rollout-2026-04-25T22-48-25-019dc553-efaa-70f0-a753-e9bb4f75c038.jsonl",
			),
			"",
		);

		const result = detectCurrentSession({ cwd: "/some/dir" });
		expect(result).toEqual({
			sessionId: "019dc553-efaa-70f0-a753-e9bb4f75c038",
			source: "env:CODEX_THREAD_ID",
		});
	});

	it("falls back to the most recent Codex history session for the current cwd", () => {
		const codexRoot = path.join(tmp, ".codex");
		const sessionsDir = path.join(codexRoot, "sessions", "2026", "04", "25");
		fs.mkdirSync(sessionsDir, { recursive: true });
		fs.writeFileSync(
			path.join(
				sessionsDir,
				"rollout-2026-04-25T22-48-25-019dc553-efaa-70f0-a753-e9bb4f75c038.jsonl",
			),
			JSON.stringify({
				type: "session_meta",
				payload: {
					id: "019dc553-efaa-70f0-a753-e9bb4f75c038",
					cwd: "/Users/v/Dev/foo",
				},
			}) + "\n",
		);
		fs.writeFileSync(
			path.join(sessionsDir, "rollout-2026-04-25T22-48-25-other-session.jsonl"),
			JSON.stringify({
				type: "session_meta",
				payload: { id: "other-session", cwd: "/Users/v/Dev/other" },
			}) + "\n",
		);
		fs.writeFileSync(
			path.join(codexRoot, "history.jsonl"),
			[
				JSON.stringify({ session_id: "other-session", ts: 100, text: "old" }),
				JSON.stringify({
					session_id: "019dc553-efaa-70f0-a753-e9bb4f75c038",
					ts: 200,
					text: "new",
				}),
			].join("\n") + "\n",
		);

		const result = detectCurrentSession({ cwd: "/Users/v/Dev/foo" });
		expect(result).toEqual({
			sessionId: "019dc553-efaa-70f0-a753-e9bb4f75c038",
			source: "mtime-heuristic",
		});
	});

	it("ignores invalid CODEX_THREAD_ID values", () => {
		process.env.CODEX_THREAD_ID = "../bad";
		expect(detectCurrentSession({ cwd: "/some/dir" })).toBeNull();
	});

	it("falls back to most-recent-mtime in Claude Code project dir", () => {
		const projectDir = path.join(
			tmp,
			".claude",
			"projects",
			"-Users-v-Dev-foo",
		);
		const older = makeJsonl(projectDir, "old.jsonl", Date.now() - 60_000);
		const newer = makeJsonl(projectDir, "new.jsonl", Date.now());

		const result = detectCurrentSession({ cwd: "/Users/v/Dev/foo" });
		expect(result?.sessionId).toBe("new");
		expect(result?.source).toBe("mtime-heuristic");
	});

	it("returns null when no env, no jsonl in project dir", () => {
		expect(detectCurrentSession({ cwd: "/Users/v/Dev/nope" })).toBeNull();
	});

	it("tolerates non-jsonl siblings", () => {
		const projectDir = path.join(
			tmp,
			".claude",
			"projects",
			"-Users-v-Dev-foo",
		);
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, "readme.txt"), "");
		makeJsonl(projectDir, "real.jsonl", Date.now());
		expect(detectCurrentSession({ cwd: "/Users/v/Dev/foo" })?.sessionId).toBe(
			"real",
		);
	});
});

describe("resolveTranscriptPath", () => {
	it("returns path under encoded cwd", async () => {
		const { resolveTranscriptPath } =
			await import("../../../../src/lib/history/session-detect.js");
		const result = resolveTranscriptPath("/Users/v/Dev/foo", "abc123");
		expect(result).toBe(
			path.join(tmp, ".claude", "projects", "-Users-v-Dev-foo", "abc123.jsonl"),
		);
	});

	it("returns Codex rollout path when sessionId matches a Codex transcript", async () => {
		const { resolveTranscriptPath } =
			await import("../../../../src/lib/history/session-detect.js");
		const dir = path.join(tmp, ".codex", "sessions", "2026", "04", "25");
		const file = path.join(
			dir,
			"rollout-2026-04-25T22-48-25-019dc553-efaa-70f0-a753-e9bb4f75c038.jsonl",
		);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, "");

		const result = resolveTranscriptPath(
			"/Users/v/Dev/foo",
			"019dc553-efaa-70f0-a753-e9bb4f75c038",
		);
		expect(result).toBe(file);
	});
});

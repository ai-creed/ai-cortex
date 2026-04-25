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
		expect(result).toEqual({ sessionId: "canon-id", source: "env:AI_CORTEX_SESSION_ID" });
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
		expect(result).toEqual({ sessionId: "claude-id", source: "env:CLAUDE_SESSION_ID" });
	});

	it("scans known harness vars in declared order", () => {
		process.env.CODEX_SESSION_ID = "codex-id";
		process.env.CURSOR_SESSION_ID = "cursor-id";
		const result = detectCurrentSession({ cwd: "/some/dir" });
		expect(result?.sessionId).toBe("codex-id");
	});

	it("falls back to most-recent-mtime in Claude Code project dir", () => {
		const projectDir = path.join(tmp, ".claude", "projects", "-Users-v-Dev-foo");
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
		const projectDir = path.join(tmp, ".claude", "projects", "-Users-v-Dev-foo");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, "readme.txt"), "");
		makeJsonl(projectDir, "real.jsonl", Date.now());
		expect(detectCurrentSession({ cwd: "/Users/v/Dev/foo" })?.sessionId).toBe("real");
	});
});

describe("resolveTranscriptPath", () => {
	it("returns path under encoded cwd", async () => {
		const { resolveTranscriptPath } = await import("../../../../src/lib/history/session-detect.js");
		const result = resolveTranscriptPath("/Users/v/Dev/foo", "abc123");
		expect(result).toBe(path.join(tmp, ".claude", "projects", "-Users-v-Dev-foo", "abc123.jsonl"));
	});
});

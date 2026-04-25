// tests/integration/history-cli.test.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "dist", "src", "cli.js");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "history", "sample.jsonl");

let home: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-cli-"));
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

function run(args: string[]): { stdout: string; stderr: string } {
	const out = execFileSync("node", [CLI, ...args], {
		env: { ...process.env, HOME: home, AI_CORTEX_HISTORY: "1" },
		encoding: "utf8",
	});
	return { stdout: out, stderr: "" };
}

describe("ai-cortex history CLI", () => {
	it("history off then on toggles flag file", () => {
		run(["history", "off"]);
		const flag = path.join(home, ".cache", "ai-cortex", "v1", "history-disabled");
		expect(fs.existsSync(flag)).toBe(true);
		run(["history", "on"]);
		expect(fs.existsSync(flag)).toBe(false);
	});

	it("history capture --session writes a session record (explicit transcript + repo-key)", () => {
		run(["history", "capture", "--session", "test-sess", "--transcript", FIXTURE, "--repo-key", "REPO"]);
		const sessJson = path.join(home, ".cache", "ai-cortex", "v1", "REPO", "history", "sessions", "test-sess", "session.json");
		expect(fs.existsSync(sessJson)).toBe(true);
	});

	it("history list prints session ids", () => {
		run(["history", "capture", "--session", "test-sess", "--transcript", FIXTURE, "--repo-key", "REPO"]);
		const out = run(["history", "list", "--repo-key", "REPO"]);
		expect(out.stdout).toContain("test-sess");
	});

	it("history capture auto-discovers transcript from sessionId + cwd", () => {
		// Place a fixture jsonl where session-detect would resolve it.
		const cwd = "/Users/sample/proj";
		const projDir = path.join(home, ".claude", "projects", "-Users-sample-proj");
		fs.mkdirSync(projDir, { recursive: true });
		fs.copyFileSync(FIXTURE, path.join(projDir, "auto-sess.jsonl"));
		run(["history", "capture", "--session", "auto-sess", "--cwd", cwd, "--repo-key", "REPO"]);
		const sessJson = path.join(home, ".cache", "ai-cortex", "v1", "REPO", "history", "sessions", "auto-sess", "session.json");
		expect(fs.existsSync(sessJson)).toBe(true);
	});

	it("errors when --transcript missing and no jsonl exists for sessionId", () => {
		expect(() =>
			run(["history", "capture", "--session", "missing", "--cwd", "/tmp/none", "--repo-key", "REPO"]),
		).toThrow();
	});

	it("errors when no --repo-key and cwd is not a git repo", () => {
		expect(() => run(["history", "list", "--cwd", "/tmp/not-a-repo"])).toThrow();
	});
});

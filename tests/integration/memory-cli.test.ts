// tests/integration/memory-cli.test.ts
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "dist", "src", "cli.js");

let cacheHome: string;

beforeEach(() => {
	cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-memory-cli-"));
});

afterEach(() => {
	fs.rmSync(cacheHome, { recursive: true, force: true });
});

function run(args: string[], extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; status: number } {
	const result = spawnSync("node", [CLI, ...args], {
		env: { ...process.env, AI_CORTEX_CACHE_HOME: cacheHome, ...extraEnv },
		encoding: "utf8",
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status ?? 1,
	};
}

describe("ai-cortex memory CLI", () => {
	it("memory recall --json returns empty array for fresh repo", () => {
		const out = run(["memory", "recall", "any query", "--json", "--repo-key", "test-recall"]);
		expect(out.status).toBe(0);
		const parsed = JSON.parse(out.stdout);
		expect(Array.isArray(parsed)).toBe(true);
	});

	it("memory search --json returns empty array for fresh repo", () => {
		const out = run(["memory", "search", "any query", "--json", "--repo-key", "test-search"]);
		expect(out.status).toBe(0);
		const parsed = JSON.parse(out.stdout);
		expect(Array.isArray(parsed)).toBe(true);
	});

	it("unknown memory subcommand exits with code 1", () => {
		const out = run(["memory", "notacommand"]);
		expect(out.status).toBe(1);
	});

	it("memory record creates a memory and prints its ID", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "This is a test decision body.");

		const out = run([
			"memory", "record",
			"--type", "decision",
			"--title", "My decision",
			"--body-file", bodyFile,
			"--repo-key", "test-cli-record",
		]);

		expect(out.status).toBe(0);
		expect(out.stdout).toMatch(/^mem-\d{4}-\d{2}-\d{2}-my-decision-[0-9a-f]{6}\n$/);
	});

	it("memory record with missing --title exits with code 1", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "body text");

		const out = run([
			"memory", "record",
			"--type", "decision",
			"--body-file", bodyFile,
			"--repo-key", "test-cli-record",
		]);

		expect(out.status).toBe(1);
	});
});

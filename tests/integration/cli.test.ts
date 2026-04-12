// tests/integration/cli.test.ts
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = path.join(ROOT, "dist/src/cli.js");

let tmpDir: string;

beforeAll(() => {
	execFileSync("pnpm", ["build"], { cwd: ROOT, stdio: "ignore" });

	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-cli-test-"));
	execFileSync("git", ["init", tmpDir]);
	execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@test.com"]);
	execFileSync("git", ["-C", tmpDir, "config", "user.name", "Test"]);
	execFileSync("git", ["-C", tmpDir, "config", "commit.gpgsign", "false"]);
	fs.writeFileSync(
		path.join(tmpDir, "package.json"),
		JSON.stringify({ name: "cli-test-repo", version: "1.0.0" }),
	);
	fs.writeFileSync(path.join(tmpDir, "README.md"), "# CLI Test Repo\n");
	execFileSync("git", ["-C", tmpDir, "add", "."]);
	execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("rehydrate CLI", () => {
	it("text output is two lines matching spec format", () => {
		const result = spawnSync("node", [CLI, "rehydrate", tmpDir], {
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		const lines = result.stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(
			/^rehydrated cli-test-repo \((reindexed|fresh|stale), \d+ files, \d+ docs\)$/,
		);
		expect(lines[1]).toMatch(/^\s+briefing: ~\//);
	});

	it("--json outputs valid JSON with required fields", () => {
		const result = spawnSync("node", [CLI, "rehydrate", "--json", tmpDir], {
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		const json = JSON.parse(result.stdout);
		expect(json).toMatchObject({
			briefingPath: expect.stringMatching(/\.md$/),
			cacheStatus: expect.stringMatching(/^(fresh|reindexed|stale)$/),
			packageName: "cli-test-repo",
			fileCount: expect.any(Number),
			docCount: expect.any(Number),
		});
		expect(path.isAbsolute(json.briefingPath)).toBe(true);
	});

	it("--stale flag succeeds and includes project name in output", () => {
		const result = spawnSync("node", [CLI, "rehydrate", "--stale", tmpDir], {
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("cli-test-repo");
	});

	it("exits with code 1 and writes to stderr when not a git repo", () => {
		const result = spawnSync("node", [CLI, "rehydrate", os.tmpdir()], {
			encoding: "utf8",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("ai-cortex:");
	});
});

function seedSuggestRepo(): void {
	fs.writeFileSync(
		path.join(tmpDir, "src.ts"),
		"export const persistenceStore = true;\n" +
			"export const restoreFlow = true;\n",
	);
	fs.writeFileSync(
		path.join(tmpDir, "guide.md"),
		"# Persistence Guide\nPersistence guide body.\n",
	);
	execFileSync("git", ["-C", tmpDir, "add", "."]);
	execFileSync("git", ["-C", tmpDir, "commit", "-m", "seed suggest fixtures"]);
}

describe("suggest CLI", () => {
	it("renders numbered text output", () => {
		seedSuggestRepo();

		const result = spawnSync("node", [CLI, "suggest", "persistence", tmpDir], {
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("suggested files for: persistence");
		expect(result.stdout).toMatch(/\n\n1\. /);
		expect(result.stdout).toContain("reason:");
	});

	it("supports --json output", () => {
		seedSuggestRepo();

		const result = spawnSync(
			"node",
			[CLI, "suggest", "persistence", "--json", tmpDir],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		const json = JSON.parse(result.stdout);
		expect(json).toMatchObject({
			task: "persistence",
			from: null,
			cacheStatus: expect.stringMatching(/^(fresh|reindexed|stale)$/),
			results: expect.any(Array),
		});
	});

	it("exits with code 2 for invalid limit", () => {
		seedSuggestRepo();

		const result = spawnSync(
			"node",
			[CLI, "suggest", "persistence", "--limit", "0", tmpDir],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("ai-cortex:");
	});

	it("exits with code 2 for an empty task", () => {
		seedSuggestRepo();

		const result = spawnSync("node", [CLI, "suggest", "", tmpDir], {
			encoding: "utf8",
		});

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("ai-cortex:");
	});
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRepoFingerprint } from "../../src/spike/cache-store.js";

const createdDirs: string[] = [];

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("buildRepoFingerprint", () => {
	it("changes when repo source files change", () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-fingerprint-"));
		createdDirs.push(repoRoot);

		fs.writeFileSync(path.join(repoRoot, "README.md"), "# Example\n");
		fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
		fs.writeFileSync(path.join(repoRoot, "src", "main.ts"), "export const value = 1;\n");

		const first = buildRepoFingerprint(repoRoot);
		fs.writeFileSync(path.join(repoRoot, "src", "main.ts"), "export const value = 2;\n");
		const second = buildRepoFingerprint(repoRoot);

		expect(second).not.toBe(first);
	});

	it("avoids statting every tracked file for a clean git repo", () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-fingerprint-git-"));
		createdDirs.push(repoRoot);

		execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "Codex"], { cwd: repoRoot, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: repoRoot, stdio: "ignore" });

		fs.writeFileSync(path.join(repoRoot, "README.md"), "# Example\n");
		fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
		fs.writeFileSync(path.join(repoRoot, "src", "main.ts"), "export const value = 1;\n");
		fs.writeFileSync(path.join(repoRoot, "src", "other.ts"), "export const other = 2;\n");

		execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });

		const statSpy = vi.spyOn(fs, "statSync");
		buildRepoFingerprint(repoRoot);
		expect(statSpy).toHaveBeenCalledTimes(0);
		statSpy.mockRestore();
	});

	it("does not change for dirty working-tree edits until a new commit exists", () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-fingerprint-head-"));
		createdDirs.push(repoRoot);

		execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "Codex"], { cwd: repoRoot, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: repoRoot, stdio: "ignore" });

		fs.writeFileSync(path.join(repoRoot, "README.md"), "# Example\n");
		fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
		fs.writeFileSync(path.join(repoRoot, "src", "main.ts"), "export const value = 1;\n");

		execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });

		const first = buildRepoFingerprint(repoRoot);
		fs.writeFileSync(path.join(repoRoot, "src", "main.ts"), "export const value = 2;\n");
		const second = buildRepoFingerprint(repoRoot);

		expect(second).toBe(first);
	});
});

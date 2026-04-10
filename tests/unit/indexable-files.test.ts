import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listIndexableFiles } from "../../src/spike/indexable-files.js";

const createdDirs: string[] = [];

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("listIndexableFiles", () => {
	it("uses git-aware filtering so ignored files are excluded but useful untracked files remain", () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-indexable-"));
		createdDirs.push(repoRoot);

		execFileSync("git", ["init"], { cwd: repoRoot });
		fs.writeFileSync(path.join(repoRoot, ".gitignore"), "release/\n");
		fs.writeFileSync(path.join(repoRoot, "README.md"), "# Example\n");
		fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
		fs.writeFileSync(path.join(repoRoot, "src", "tracked.ts"), "export const tracked = true;\n");
		fs.writeFileSync(path.join(repoRoot, "src", "draft.ts"), "export const draft = true;\n");
		fs.mkdirSync(path.join(repoRoot, "release"), { recursive: true });
		fs.writeFileSync(path.join(repoRoot, "release", "artifact.txt"), "ignore me\n");

		execFileSync("git", ["add", ".gitignore", "README.md", "src/tracked.ts"], { cwd: repoRoot });

		const files = listIndexableFiles(repoRoot);

		expect(files).toContain(".gitignore");
		expect(files).toContain("README.md");
		expect(files).toContain("src/tracked.ts");
		expect(files).toContain("src/draft.ts");
		expect(files).not.toContain("release/artifact.txt");
	});
});

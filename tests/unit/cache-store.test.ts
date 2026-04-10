import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});

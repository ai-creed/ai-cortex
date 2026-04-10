import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectFileTree } from "../../src/spike/file-tree.js";

describe("collectFileTree", () => {
	it("ignores hidden directories such as .worktrees", () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-tree-"));
		fs.mkdirSync(path.join(repoRoot, ".worktrees", "nested"), { recursive: true });
		fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
		fs.writeFileSync(path.join(repoRoot, ".worktrees", "nested", "noise.ts"), "export {};\n");
		fs.writeFileSync(path.join(repoRoot, "src", "main.ts"), "export const x = 1;\n");

		const files = collectFileTree(repoRoot).map(node => node.path);

		expect(files).toContain("src");
		expect(files).toContain("src/main.ts");
		expect(files.some(filePath => filePath.startsWith(".worktrees"))).toBe(false);
	});
});

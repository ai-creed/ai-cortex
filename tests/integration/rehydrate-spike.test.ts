import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCache } from "../../src/spike/build-cache.js";
import { extractImportEdgesFromSource } from "../../src/spike/ts-import-graph.js";

describe("phase 0 spike workspace", () => {
	it("loads the spike entrypoint", async () => {
		const mod = await import("../../src/spike/run-phase-0.js");
		expect(typeof mod.runPhase0).toBe("function");
	});

	it("extracts relative import edges from TypeScript source", () => {
		const edges = extractImportEdgesFromSource(
			"src/a.ts",
			"import { b } from './b';\nimport c from '../shared/c';\nimport x from 'react';"
		);

		expect(edges).toEqual([
			{ from: "src/a.ts", to: "src/b" },
			{ from: "src/a.ts", to: "shared/c" }
		]);
	});

	it("builds a repo cache with files and docs", () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-phase0-"));
		fs.writeFileSync(path.join(repoRoot, "README.md"), "# Example Repo\n");
		fs.mkdirSync(path.join(repoRoot, "src"));
		fs.writeFileSync(path.join(repoRoot, "src", "main.ts"), "export const x = 1;\n");

		// This spike currently writes cache files into the real user cache dir.
		// That is acceptable for Phase 0, but test runs will leave cache artifacts behind.
		const cache = buildCache(repoRoot);
		expect(cache.repoPath).toBe(repoRoot);
		expect(cache.files.some(node => node.path === "README.md")).toBe(true);
		expect(cache.docs[0]?.path).toBe("README.md");
	});
});

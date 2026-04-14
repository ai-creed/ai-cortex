// benchmarks/eval/fixtures/entry-files-eval.test.ts
//
// Pre-placed verification test for eval task "node-framework-detection".
// Copied into the worktree by the eval harness.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");

import fs from "node:fs";
import { readPackageMeta } from "../../../src/lib/entry-files.js";

const mockFs = vi.mocked(fs);

describe("node-framework-detection eval", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("detects node framework when tsx is in devDependencies", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({
				name: "my-cli",
				version: "1.0.0",
				devDependencies: { tsx: "^4.0.0" },
			}) as any,
		);
		expect(readPackageMeta("/repo").framework).toBe("node");
	});

	it("detects node framework when @types/node is in devDependencies", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({
				name: "my-cli",
				version: "1.0.0",
				devDependencies: { "@types/node": "^22.0.0" },
			}) as any,
		);
		expect(readPackageMeta("/repo").framework).toBe("node");
	});

	it("still detects electron over node", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({
				name: "app",
				version: "1.0.0",
				devDependencies: { electron: "^30.0.0", tsx: "^4.0.0" },
			}) as any,
		);
		expect(readPackageMeta("/repo").framework).toBe("electron");
	});
});

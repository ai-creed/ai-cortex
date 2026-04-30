// tests/unit/lib/indexable-files.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, exec: vi.fn() };
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { default: actual, ...actual };
});

import { exec } from "node:child_process";
import fs from "node:fs";
import { listIndexableFiles } from "../../../src/lib/indexable-files.js";

const mockExec = vi.mocked(exec);

function mockGitSuccess(stdout: string): void {
	mockExec.mockImplementation((...args: any[]) => {
		const cb = args[args.length - 1];
		cb(null, { stdout, stderr: "" });
		return {} as any;
	});
}

function mockGitFailure(): void {
	mockExec.mockImplementation((...args: any[]) => {
		const cb = args[args.length - 1];
		cb(new Error("git failed"), { stdout: "", stderr: "error" });
		return {} as any;
	});
}

describe("listIndexableFiles", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns sorted file paths from git ls-files", async () => {
		mockGitSuccess("src/b.ts\nsrc/a.ts\nREADME.md\n");
		vi.spyOn(fs.promises, "stat").mockResolvedValue({
			isDirectory: () => false,
		} as any);
		expect(await listIndexableFiles("/repo")).toEqual([
			"README.md",
			"src/a.ts",
			"src/b.ts",
		]);
	});

	it("filters empty lines from git output", async () => {
		mockGitSuccess("\n\nREADME.md\n\n");
		vi.spyOn(fs.promises, "stat").mockResolvedValue({
			isDirectory: () => false,
		} as any);
		expect(await listIndexableFiles("/repo")).toEqual(["README.md"]);
	});

	it("returns empty array when git returns no files", async () => {
		mockGitSuccess("\n");
		expect(await listIndexableFiles("/repo")).toEqual([]);
	});

	it("filters out files that do not exist on disk (stat throws)", async () => {
		mockGitSuccess("a.ts\ndeleted.ts\nb.ts\n");
		vi.spyOn(fs.promises, "stat").mockImplementation(async (p) => {
			if (String(p).includes("deleted.ts")) throw new Error("ENOENT");
			return { isDirectory: () => false } as any;
		});
		expect(await listIndexableFiles("/repo")).toEqual(["a.ts", "b.ts"]);
	});

	it("filters out directories (submodules, symlinked dirs)", async () => {
		mockGitSuccess("src/app.ts\nvendor\nlib/utils.ts\n");
		vi.spyOn(fs.promises, "stat").mockImplementation(
			async (p) =>
				({
					isDirectory: () => String(p).endsWith("vendor"),
				}) as any,
		);
		expect(await listIndexableFiles("/repo")).toEqual([
			"lib/utils.ts",
			"src/app.ts",
		]);
	});
});

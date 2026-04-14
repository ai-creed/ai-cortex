// tests/unit/lib/indexable-files.test.ts
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process");

import { execFileSync } from "node:child_process";
import { listIndexableFiles } from "../../../src/lib/indexable-files.js";

const mockExec = vi.mocked(execFileSync);

describe("listIndexableFiles", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(fs, "existsSync").mockReturnValue(true);
		vi.spyOn(fs, "statSync").mockReturnValue({ isDirectory: () => false } as any);
	});

	it("returns sorted file paths from git ls-files", () => {
		mockExec.mockReturnValue("src/b.ts\nsrc/a.ts\nREADME.md\n" as any);
		expect(listIndexableFiles("/repo")).toEqual([
			"README.md",
			"src/a.ts",
			"src/b.ts",
		]);
	});

	it("calls git with the correct arguments", () => {
		mockExec.mockReturnValue("" as any);
		listIndexableFiles("/my/repo");
		expect(mockExec).toHaveBeenCalledWith(
			"git",
			[
				"-C",
				"/my/repo",
				"ls-files",
				"--cached",
				"--others",
				"--exclude-standard",
			],
			expect.objectContaining({ encoding: "utf8" }),
		);
	});

	it("filters empty lines from git output", () => {
		mockExec.mockReturnValue("\n\nREADME.md\n\n" as any);
		expect(listIndexableFiles("/repo")).toEqual(["README.md"]);
	});

	it("returns empty array when git returns no files", () => {
		mockExec.mockReturnValue("\n" as any);
		expect(listIndexableFiles("/repo")).toEqual([]);
	});

	it("filters out files that do not exist on disk", () => {
		mockExec.mockReturnValue("a.ts\ndeleted.ts\nb.ts\n" as any);
		vi.mocked(fs.existsSync).mockImplementation((p) =>
			!String(p).includes("deleted.ts"),
		);
		expect(listIndexableFiles("/repo")).toEqual(["a.ts", "b.ts"]);
	});

	it("filters out directories (submodules, symlinked dirs)", () => {
		mockExec.mockReturnValue("src/app.ts\nvendor\nlib/utils.ts\n" as any);
		vi.spyOn(fs, "statSync").mockImplementation((p) => ({
			isDirectory: () => String(p).endsWith("vendor"),
		}) as any);
		expect(listIndexableFiles("/repo")).toEqual(["lib/utils.ts", "src/app.ts"]);
	});
});

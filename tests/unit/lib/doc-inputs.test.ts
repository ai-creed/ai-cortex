// tests/unit/lib/doc-inputs.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");

import fs from "node:fs";
import { loadDocs, rankDocCandidates } from "../../../src/lib/doc-inputs.js";

const mockFs = vi.mocked(fs);

describe("rankDocCandidates", () => {
	it("ranks README first, then shared architecture, then shared plan, then shared, then other md", () => {
		const ranked = rankDocCandidates([
			"src/app.ts",
			"other.md",
			"docs/shared/high_level_plan.md",
			"docs/shared/architecture_decisions.md",
			"docs/shared/notes.md",
			"README.md"
		]);
		expect(ranked).toEqual([
			"README.md",
			"docs/shared/architecture_decisions.md",
			"docs/shared/high_level_plan.md",
			"docs/shared/notes.md",
			"other.md"
		]);
	});

	it("excludes non-markdown files", () => {
		const ranked = rankDocCandidates(["src/app.ts", "README.md"]);
		expect(ranked).toEqual(["README.md"]);
	});
});

describe("loadDocs", () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it("loads ranked docs up to the limit", () => {
		mockFs.readFileSync.mockReturnValue("# My Project\nsome content\n" as any);
		const docs = loadDocs("/repo", ["README.md", "docs/shared/architecture.md"], 1);
		expect(docs).toHaveLength(1);
		expect(docs[0]?.path).toBe("README.md");
		expect(docs[0]?.title).toBe("My Project");
	});

	it("extracts title from first h1 heading", () => {
		mockFs.readFileSync.mockReturnValue("intro line\n# The Title\nbody\n" as any);
		const docs = loadDocs("/repo", ["docs/shared/notes.md"]);
		expect(docs[0]?.title).toBe("The Title");
	});

	it("falls back to file path when no h1 heading", () => {
		mockFs.readFileSync.mockReturnValue("no heading here\n" as any);
		const docs = loadDocs("/repo", ["docs/shared/notes.md"]);
		expect(docs[0]?.title).toBe("docs/shared/notes.md");
	});
});

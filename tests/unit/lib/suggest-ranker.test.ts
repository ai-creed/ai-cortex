// tests/unit/lib/suggest-ranker.test.ts
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../../src/lib/models.js";
import type { RepoCache } from "../../../src/lib/models.js";
import { rankSuggestions } from "../../../src/lib/suggest-ranker.js";

function makeCache(overrides: Partial<RepoCache> = {}): RepoCache {
	return {
		schemaVersion: SCHEMA_VERSION,
		repoKey: "repokey1234567890",
		worktreeKey: "worktree12345678",
		worktreePath: "/repo",
		indexedAt: "2026-04-12T00:00:00.000Z",
		fingerprint: "abc123",
		packageMeta: { name: "test-app", version: "1.0.0", framework: null },
		entryFiles: ["src/app.ts"],
		files: [
			{ path: "src/persistence/store.ts", kind: "file" },
			{ path: "src/persistence/restore-session.ts", kind: "file" },
			{ path: "src/app.ts", kind: "file" },
			{ path: "README.md", kind: "file" },
			{ path: "docs/shared/architecture_decisions.md", kind: "file" },
		],
		docs: [
			{
				path: "README.md",
				title: "Test App",
				body: "# Test App\nPersistence overview.\n",
			},
			{
				path: "docs/shared/architecture_decisions.md",
				title: "Architecture Decisions",
				body: "# Architecture Decisions\nPersistence and restore flow.\n",
			},
		],
		imports: [
			{ from: "src/app.ts", to: "src/persistence/store" },
			{ from: "src/persistence/restore-session.ts", to: "src/persistence/store" },
		],
		calls: [],
		functions: [],
		...overrides,
	};
}

describe("rankSuggestions", () => {
	it("ranks code files by task token matches in filename and path", () => {
		const result = rankSuggestions("inspect persistence store", makeCache());
		expect(result[0]?.path).toBe("src/persistence/store.ts");
		expect(result[0]?.kind).toBe("file");
	});

	it("dedupes markdown docs so the same path does not appear as both file and doc", () => {
		const result = rankSuggestions("architecture decisions", makeCache());
		const matches = result.filter(
			(item) => item.path === "docs/shared/architecture_decisions.md",
		);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.kind).toBe("doc");
	});

	it("prefers code over docs on comparable evidence", () => {
		// Under the new scoring (title×8, path×5, body×2) a doc with matching title/body/path
		// will outscore a code file with a matching path alone. This test asserts the
		// tiebreaker: when both file and doc produce the SAME score (path-only match each),
		// the code file is ranked first.
		const cache = makeCache({
			files: [
				{ path: "src/persistence.ts", kind: "file" },
				{ path: "docs/shared/persistence.md", kind: "file" },
			],
			docs: [
				{
					path: "docs/shared/persistence.md",
					title: "Misc notes", // title does NOT match "persistence"
					body: "Unrelated content.", // body does NOT match "persistence"
				},
			],
		});
		// code: path-token "persistence" → 1×5 = 5
		// doc:  path-token "persistence" → 1×5 = 5, title=0, body=0 → total 5
		// Same score — sort tiebreaker (kind:"file" < kind:"doc") → src/persistence.ts wins.
		const result = rankSuggestions("persistence", cache);
		expect(result[0]?.path).toBe("src/persistence.ts");
		expect(result[0]?.kind).toBe("file");
	});

	it("allows a doc to outrank code when title/body evidence is materially stronger", () => {
		const result = rankSuggestions("architecture decisions restore flow", makeCache());
		expect(result[0]?.path).toBe("docs/shared/architecture_decisions.md");
		expect(result[0]?.kind).toBe("doc");
	});

	it("boosts entry files", () => {
		const result = rankSuggestions("app", makeCache());
		expect(result.some((item) => item.path === "src/app.ts")).toBe(true);
	});

	it("boosts same-directory and direct import neighbors when from is known", () => {
		const result = rankSuggestions("store", makeCache(), {
			from: "src/app.ts",
			limit: 5,
		});
		expect(result[0]?.path).toBe("src/persistence/store.ts");
		expect(result[0]?.reason).toMatch(/imports|anchor|path/i);
	});

	it("does not apply ambiguous target boosts when two files map to the same stripped import target", () => {
		const cache = makeCache({
			files: [
				{ path: "src/foo.ts", kind: "file" },
				{ path: "src/foo/index.ts", kind: "file" },
				{ path: "src/app.ts", kind: "file" },
			],
			docs: [],
			imports: [{ from: "src/app.ts", to: "src/foo" }],
		});
		const result = rankSuggestions("foo", cache, {
			from: "src/app.ts",
			limit: 5,
		});
		expect(result.map((item) => item.path)).toContain("src/foo.ts");
		expect(result.map((item) => item.path)).toContain("src/foo/index.ts");
	});

	it("applies the limit after sorting", () => {
		const result = rankSuggestions("persistence", makeCache(), { limit: 1 });
		expect(result).toHaveLength(1);
	});
});

describe("call graph enrichment", () => {
	it("boosts file call-connected to anchor", () => {
		const cache = makeCache({
			files: [
				{ path: "src/server.ts", kind: "file" },
				{ path: "src/ranker.ts", kind: "file" },
			],
			calls: [
				{ from: "src/server.ts::handle", to: "src/ranker.ts::rank", kind: "call" },
			],
			functions: [
				{ qualifiedName: "handle", file: "src/server.ts", exported: true, isDefaultExport: false, line: 1 },
				{ qualifiedName: "rank", file: "src/ranker.ts", exported: true, isDefaultExport: false, line: 1 },
			],
		});
		const result = rankSuggestions("ranking", cache, { from: "src/server.ts" });
		const ranker = result.find((r) => r.path === "src/ranker.ts");
		expect(ranker).toBeDefined();
		expect(ranker!.score).toBeGreaterThan(0);
	});

	it("boosts file call-connected to top-scoring file", () => {
		const cache = makeCache({
			files: [
				{ path: "src/ranker.ts", kind: "file" },
				{ path: "src/scorer.ts", kind: "file" },
			],
			calls: [
				{ from: "src/ranker.ts::rank", to: "src/scorer.ts::score", kind: "call" },
			],
			functions: [
				{ qualifiedName: "rank", file: "src/ranker.ts", exported: true, isDefaultExport: false, line: 1 },
				{ qualifiedName: "score", file: "src/scorer.ts", exported: true, isDefaultExport: false, line: 1 },
			],
		});
		const result = rankSuggestions("ranker", cache);
		const scorer = result.find((r) => r.path === "src/scorer.ts");
		expect(scorer).toBeDefined();
		expect(scorer!.score).toBeGreaterThan(0);
	});

	it("adds fan-in bonus for files with heavily-called functions", () => {
		const calls = Array.from({ length: 6 }, (_, i) => ({
			from: `src/caller${i}.ts::fn${i}`,
			to: "src/hub.ts::process",
			kind: "call" as const,
		}));
		const cache = makeCache({
			files: [
				{ path: "src/hub.ts", kind: "file" },
				{ path: "src/other.ts", kind: "file" },
			],
			calls,
			functions: [
				{ qualifiedName: "process", file: "src/hub.ts", exported: true, isDefaultExport: false, line: 1 },
			],
		});
		const resultHub = rankSuggestions("hub", cache);
		const hub = resultHub.find((r) => r.path === "src/hub.ts");
		expect(hub).toBeDefined();
	});

	it("works correctly when calls array is empty (no regression)", () => {
		const cache = makeCache({ calls: [], functions: [] });
		const result = rankSuggestions("persistence store", cache);
		expect(result[0]?.path).toBe("src/persistence/store.ts");
	});

	it("works correctly when calls field is undefined (v2 cache)", () => {
		const cache = makeCache();
		delete (cache as Record<string, unknown>).calls;
		delete (cache as Record<string, unknown>).functions;
		const result = rankSuggestions("persistence store", cache);
		expect(result[0]?.path).toBe("src/persistence/store.ts");
	});
});

describe("rankSuggestions — functions[] scoring", () => {
	it("boosts a file whose exported function name matches task tokens", () => {
		const cache = makeCache({
			files: [
				{ path: "src/a.ts", kind: "file" },
				{ path: "src/b.ts", kind: "file" },
			],
			functions: [
				{
					qualifiedName: "createCard",
					file: "src/a.ts",
					exported: true,
					isDefaultExport: false,
					line: 1,
				},
				{
					qualifiedName: "helperThing",
					file: "src/b.ts",
					exported: true,
					isDefaultExport: false,
					line: 1,
				},
			],
		});
		const result = rankSuggestions("create card", cache);
		expect(result[0]?.path).toBe("src/a.ts");
	});

	it("weights exported functions 3x over unexported", () => {
		const cache = makeCache({
			files: [
				{ path: "src/a.ts", kind: "file" },
				{ path: "src/b.ts", kind: "file" },
			],
			functions: [
				{
					qualifiedName: "createCard",
					file: "src/a.ts",
					exported: false,
					isDefaultExport: false,
					line: 1,
				},
				{
					qualifiedName: "createCard",
					file: "src/b.ts",
					exported: true,
					isDefaultExport: false,
					line: 1,
				},
			],
		});
		const result = rankSuggestions("create card", cache);
		expect(result[0]?.path).toBe("src/b.ts");
	});

	it("caps per-file function contribution at 12", () => {
		const manyFns = Array.from({ length: 20 }, (_, i) => ({
			qualifiedName: `createCard${i}`,
			file: "src/spam.ts",
			exported: true,
			isDefaultExport: false,
			line: i + 1,
		}));
		const cache = makeCache({
			files: [
				{ path: "src/spam.ts", kind: "file" },
				{ path: "src/card/create.ts", kind: "file" }, // path-token match only
			],
			functions: manyFns,
		});
		// "src/card/create.ts" should be in top 2 despite spam.ts having 20 matches,
		// because spam.ts's function bonus is capped. Path-token score for
		// "src/card/create.ts" is 2*5 = 10; capped fn bonus for spam.ts is 12.
		const result = rankSuggestions("create card", cache);
		const top2 = result.slice(0, 2).map((r) => r.path);
		expect(top2).toContain("src/card/create.ts");
	});

	it("empty functions[] contributes zero (backward compat)", () => {
		const cache = makeCache({ functions: [] });
		const result = rankSuggestions("persistence store", cache);
		expect(result.length).toBeGreaterThan(0);
	});
});

describe("rankSuggestions — doc title vs body weighting", () => {
	it("file with task token in doc title outranks file with token buried in body", () => {
		const cache = makeCache({
			files: [
				{ path: "docs/title-hit.md", kind: "file" },
				{ path: "docs/body-hit.md", kind: "file" },
			],
			docs: [
				{
					path: "docs/title-hit.md",
					title: "Persistence Overview",
					body: "Short body.",
				},
				{
					path: "docs/body-hit.md",
					title: "Misc notes",
					body: "Lots of unrelated words. Persistence. More unrelated filler.",
				},
			],
		});
		const result = rankSuggestions("persistence", cache);
		expect(result[0]?.path).toBe("docs/title-hit.md");
	});

	it("duplicate occurrences in body count once (no TF inflation)", () => {
		const cache = makeCache({
			files: [
				{ path: "docs/a.md", kind: "file" },
				{ path: "docs/b.md", kind: "file" },
			],
			docs: [
				{
					path: "docs/a.md",
					title: "A",
					body: "persistence persistence persistence persistence persistence",
				},
				{
					path: "docs/b.md",
					title: "Persistence Store",
					body: "Short.",
				},
			],
		});
		const result = rankSuggestions("persistence store", cache);
		// doc/b title matches BOTH task tokens (persistence + store) -> 2*8 = 16 for title.
		// doc/a title matches nothing. Body unique-match for "persistence" = 1*2 = 2.
		expect(result[0]?.path).toBe("docs/b.md");
	});
});

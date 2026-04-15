import { describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "../../../src/lib/models.js";
import type { RepoCache } from "../../../src/lib/models.js";
import { rankSuggestionsDeep } from "../../../src/lib/suggest-ranker-deep.js";
import * as contentScanner from "../../../src/lib/content-scanner.js";

function makeCache(overrides: Partial<RepoCache> = {}): RepoCache {
	return {
		schemaVersion: SCHEMA_VERSION,
		repoKey: "r",
		worktreeKey: "w",
		worktreePath: "/repo",
		indexedAt: "2026-04-15T00:00:00.000Z",
		fingerprint: "fp",
		packageMeta: { name: "t", version: "1.0.0", framework: null },
		entryFiles: [],
		files: [],
		docs: [],
		imports: [],
		calls: [],
		functions: [],
		...overrides,
	};
}

describe("rankSuggestionsDeep", () => {
	it("returns results including files that fast alone would have cut (pool-vs-limit regression guard)", async () => {
		const files = Array.from({ length: 30 }, (_, i) => ({
			path: `src/file${i}.ts`,
			kind: "file" as const,
		}));
		const cache = makeCache({ files });

		const spy = vi.spyOn(contentScanner, "contentScan").mockReturnValue({
			hits: new Map([
				[
					"src/file29.ts",
					[
						{ line: 1, snippet: "createCardTitle", token: "card" },
						{ line: 2, snippet: "handleTitleEdit", token: "title" },
					],
				],
			]),
			truncated: false,
			durationMs: 10,
		});

		const result = await rankSuggestionsDeep(
			"card title file",
			cache,
			"/fake/worktree",
			{ limit: 5, poolSize: 60 },
		);
		const paths = result.results.map((r) => r.path);
		expect(paths).toContain("src/file29.ts");
		spy.mockRestore();
	});

	it("passes trigram-only rescue paths into contentScan (pool-union guard)", async () => {
		const files = [
			...Array.from({ length: 60 }, (_, i) => ({
				path: `src/foo${i}.ts`,
				kind: "file" as const,
			})),
			{ path: "src/misc.ts", kind: "file" as const },
		];
		const functions = [
			{
				file: "src/misc.ts",
				qualifiedName: "editorBootstrap",
				exported: false,
				isDefaultExport: false,
				line: 1,
			},
		];
		const cache = makeCache({ files, functions });

		const spy = vi.spyOn(contentScanner, "contentScan").mockReturnValue({
			hits: new Map(),
			truncated: false,
			durationMs: 1,
		});

		await rankSuggestionsDeep("foo edit", cache, "/w", {
			limit: 5,
			poolSize: 60,
		});

		expect(spy).toHaveBeenCalled();
		const passedPaths = spy.mock.calls[0][1] as string[];
		expect(passedPaths).toContain("src/misc.ts");
		expect(passedPaths.length).toBeLessThanOrEqual(60);
		spy.mockRestore();
	});

	it("populates contentHits on DeepSuggestItem when content scan hits", async () => {
		const cache = makeCache({
			files: [{ path: "src/a.ts", kind: "file" }],
		});
		const spy = vi.spyOn(contentScanner, "contentScan").mockReturnValue({
			hits: new Map([
				[
					"src/a.ts",
					[{ line: 42, snippet: "<RightPanel />", token: "rightpanel" }],
				],
			]),
			truncated: false,
			durationMs: 5,
		});
		const r = await rankSuggestionsDeep("right panel", cache, "/w", { limit: 5, poolSize: 5 });
		const hit = r.results.find((x) => x.path === "src/a.ts");
		expect(hit?.contentHits?.[0].line).toBe(42);
		spy.mockRestore();
	});

	it("slices final results to user-facing limit after deep augmentation", async () => {
		const files = Array.from({ length: 20 }, (_, i) => ({
			path: `src/f${i}.ts`,
			kind: "file" as const,
		}));
		const cache = makeCache({ files });
		const spy = vi.spyOn(contentScanner, "contentScan").mockReturnValue({
			hits: new Map(),
			truncated: false,
			durationMs: 1,
		});
		const r = await rankSuggestionsDeep("f", cache, "/w", { limit: 3, poolSize: 50 });
		expect(r.results.length).toBeLessThanOrEqual(3);
		spy.mockRestore();
	});

	it("sets staleMixedEvidence=true when stale flag is passed", async () => {
		const cache = makeCache({ files: [{ path: "src/a.ts", kind: "file" }] });
		const spy = vi.spyOn(contentScanner, "contentScan").mockReturnValue({
			hits: new Map(),
			truncated: false,
			durationMs: 1,
		});
		const r = await rankSuggestionsDeep("a", cache, "/w", {
			limit: 5,
			poolSize: 5,
			stale: true,
		});
		expect(r.staleMixedEvidence).toBe(true);
		spy.mockRestore();
	});

	it("content-scan candidate list never exceeds poolSize even when trigram rescues oversaturate", async () => {
		const files = Array.from({ length: 30 }, (_, i) => ({
			path: `src/rescue${i}.ts`,
			kind: "file" as const,
		}));
		const functions = files.map((f, i) => ({
			file: f.path,
			qualifiedName: `editorShim${i}`,
			exported: false,
			isDefaultExport: false,
			line: 1,
		}));
		const cache = makeCache({ files, functions });

		const spy = vi.spyOn(contentScanner, "contentScan").mockReturnValue({
			hits: new Map(),
			truncated: false,
			durationMs: 1,
		});

		await rankSuggestionsDeep("edit", cache, "/w", { limit: 5, poolSize: 5 });

		expect(spy).toHaveBeenCalled();
		const passedPaths = spy.mock.calls[0][1] as string[];
		expect(passedPaths.length).toBeLessThanOrEqual(5);
		spy.mockRestore();
	});

	it("propagates contentScanTruncated", async () => {
		const cache = makeCache({ files: [{ path: "src/a.ts", kind: "file" }] });
		const spy = vi.spyOn(contentScanner, "contentScan").mockReturnValue({
			hits: new Map(),
			truncated: true,
			durationMs: 400,
		});
		const r = await rankSuggestionsDeep("a", cache, "/w", { limit: 5, poolSize: 5 });
		expect(r.contentScanTruncated).toBe(true);
		spy.mockRestore();
	});
});

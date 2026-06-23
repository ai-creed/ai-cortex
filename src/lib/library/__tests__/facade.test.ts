// src/lib/library/__tests__/facade.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getSource,
	listSourceStatuses,
	registerSource,
	reindexLibrary,
	searchLibrary,
} from "../index.js";
import { computeO6Metrics } from "../index.js";
import type { Embedder } from "../index.js";

function fakeEmbedder(dim = 8): Embedder {
	return {
		modelId: "fake-test-model",
		dim,
		async embed(texts) {
			return texts.map((t) => {
				const v = new Float32Array(dim);
				for (let i = 0; i < t.length; i++) v[i % dim] += t.charCodeAt(i) / 100;
				let n = 0;
				for (let j = 0; j < dim; j++) n += v[j]! * v[j]!;
				n = Math.sqrt(n) || 1;
				for (let j = 0; j < dim; j++) v[j]! /= n;
				return v;
			});
		},
	};
}

describe("library facade", () => {
	let cacheHome: string;
	let dir: string;
	beforeEach(() => {
		cacheHome = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-fac-cache-")),
		);
		process.env.AI_CORTEX_CACHE_HOME = cacheHome;
		dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-fac-dir-")),
		);
		fs.writeFileSync(
			path.join(dir, "doc.md"),
			"# Topic\nThe widget pipeline batches writes.\n",
		);
	});
	afterEach(() => {
		delete process.env.AI_CORTEX_CACHE_HOME;
		for (const d of [cacheHome, dir])
			fs.rmSync(d, { recursive: true, force: true });
	});

	it("registers, reindexes, searches, and records telemetry end to end", async () => {
		const e = fakeEmbedder();
		registerSource({
			rootPath: dir,
			label: "docs",
			nowIso: "2026-06-23T00:00:00Z",
		});
		const reports = await reindexLibrary({
			embedder: e,
			nowIso: "2026-06-23T00:00:00Z",
		});
		expect(reports[0].status).toBe("ok");
		expect(reports[0].docsIndexed).toBe(1);

		const hits = await searchLibrary("widget pipeline batches", {
			embedder: e,
			nowIso: "2026-06-23T00:02:00Z",
			sessionId: "sX",
		});
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].citation.relPath).toBe("doc.md");

		const metrics = await computeO6Metrics({
			sessionFilePaths: async () => [],
		});
		expect(metrics.searches).toBe(1);
		expect(metrics.returnedNonemptyRate).toBeCloseTo(1);
	});

	it("the search path stamps session/turn so downstream touch is correlatable", async () => {
		const e = fakeEmbedder();
		fs.writeFileSync(
			path.join(dir, "k.md"),
			"# K\nthe rate limiter uses a leaky bucket\n",
		);
		registerSource({ rootPath: dir, label: "docs", nowIso: "t" });
		await reindexLibrary({ embedder: e, nowIso: "t" });

		// Inject a fake O6 source: the search fires at turn 2 of session sess-1.
		// This is exactly what the MCP/CLI search path does via historyO6Source.
		const o6 = {
			current: async () => ({ sessionId: "sess-1", turn: 2 }),
			filePaths: async () => [],
		};
		const hits = await searchLibrary("leaky bucket rate limiter", {
			embedder: e,
			nowIso: "t",
			ctx: { currentRepoKey: "repoK" },
			o6,
		});
		expect(hits.length).toBeGreaterThan(0);
		const hitPath = hits[0].citation.filePath;

		// The recorded search now carries sess-1/turn 2, so a later touch (turn 5)
		// of the returned file is counted as a downstream touch through the real path.
		const metrics = await computeO6Metrics({
			sessionFilePaths: async (sid) =>
				sid === "sess-1" ? [{ path: hitPath, turn: 5 }] : [],
		});
		expect(metrics.downstreamTouchRate).toBeCloseTo(1);
	});

	it("marks a vanished source errored, surfaces it in list, and skips it in search", async () => {
		const e = fakeEmbedder();
		fs.writeFileSync(
			path.join(dir, "z.md"),
			"# Z\nrare keyword zebra appears here\n",
		);
		const gone = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-fac-gone-")),
		);
		fs.writeFileSync(
			path.join(gone, "g.md"),
			"# G\nrare keyword zebra appears here\n",
		);
		registerSource({ rootPath: dir, label: "live", nowIso: "t" });
		const goneSrc = registerSource({
			rootPath: gone,
			label: "gone",
			nowIso: "t",
		}).source;
		await reindexLibrary({ embedder: e, nowIso: "t" }); // both index ok

		fs.rmSync(gone, { recursive: true, force: true }); // root vanishes
		const reports = await reindexLibrary({ embedder: e, nowIso: "t" });
		expect(reports.find((r) => r.sourceId === goneSrc.id)?.status).toBe(
			"errored",
		);
		expect(getSource(goneSrc.id)?.status).toBe("errored");

		// errored source is skipped; the live source still answers.
		const hits = await searchLibrary("zebra", { embedder: e, nowIso: "t" });
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.every((h) => h.citation.sourceId !== goneSrc.id)).toBe(true);
	});

	it("listSourceStatuses reports docCount and an optional staleness count", async () => {
		const e = fakeEmbedder();
		fs.writeFileSync(
			path.join(dir, "second.md"),
			"# Second\nanother document body\n",
		);
		registerSource({ rootPath: dir, label: "docs", nowIso: "t" });
		await reindexLibrary({ embedder: e, nowIso: "t" });

		const before = listSourceStatuses({ staleness: true });
		expect(before[0].docCount).toBe(2); // doc.md (from beforeEach) + second.md
		expect(before[0].staleCount).toBe(0);

		// mutate one indexed file; the staleness pass should count it
		const future = new Date(Date.now() + 60_000);
		fs.utimesSync(path.join(dir, "doc.md"), future, future);
		expect(listSourceStatuses({ staleness: true })[0].staleCount).toBe(1);

		// without the staleness pass, staleCount is null (not computed)
		expect(listSourceStatuses()[0].staleCount).toBeNull();
	});

	it("marks a source errored and skips it in search when its root vanishes (no reindex)", async () => {
		const e = fakeEmbedder();
		fs.writeFileSync(
			path.join(dir, "live.md"),
			"# Live\nshared keyword tangerine here\n",
		);
		const gone = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-fac-gone2-")),
		);
		fs.writeFileSync(
			path.join(gone, "g.md"),
			"# Gone\nshared keyword tangerine here\n",
		);
		registerSource({ rootPath: dir, label: "live", nowIso: "t" });
		const goneSrc = registerSource({
			rootPath: gone,
			label: "gone",
			nowIso: "t",
		}).source;
		await reindexLibrary({ embedder: e, nowIso: "t" }); // both indexed, both ok

		// remove the root WITHOUT reindexing; the source is still status "ok"
		fs.rmSync(gone, { recursive: true, force: true });
		expect(getSource(goneSrc.id)?.status).toBe("ok"); // not yet detected

		// search must detect the missing root, mark it errored, skip it, not crash
		const hits = await searchLibrary("tangerine keyword", {
			embedder: e,
			nowIso: "t",
		});
		expect(getSource(goneSrc.id)?.status).toBe("errored"); // marked at search time
		expect(hits.length).toBeGreaterThan(0); // live source still answers
		expect(hits.every((h) => h.citation.sourceId !== goneSrc.id)).toBe(true);
	});
});

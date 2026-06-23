// src/lib/library/__tests__/integration.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	listSources,
	registerSource,
	reindexLibrary,
	searchLibrary,
} from "../index.js";
import { updateSource } from "../source-registry.js";
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

describe("library integration (two sources)", () => {
	let cacheHome: string;
	let dirA: string;
	let dirB: string;
	beforeEach(() => {
		cacheHome = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-int-cache-")),
		);
		process.env.AI_CORTEX_CACHE_HOME = cacheHome;
		dirA = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-int-a-")),
		);
		dirB = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-int-b-")),
		);
	});
	afterEach(() => {
		delete process.env.AI_CORTEX_CACHE_HOME;
		for (const d of [cacheHome, dirA, dirB])
			fs.rmSync(d, { recursive: true, force: true });
	});

	it("indexes two sources and ranks the current-project doc first", async () => {
		fs.writeFileSync(
			path.join(dirA, "auth.md"),
			"# Auth\nRotate the signing key every ninety days.\n",
		);
		fs.writeFileSync(
			path.join(dirB, "auth.md"),
			"# Auth\nRotate the signing key every ninety days.\n",
		);

		const ra = registerSource({
			rootPath: dirA,
			label: "projA",
			nowIso: "t",
		}).source;
		const rb = registerSource({
			rootPath: dirB,
			label: "projB",
			nowIso: "t",
		}).source;
		// give each a synthetic repoKey so origin-affinity has something to match
		updateSource(ra.id, {
			kind: "repo",
			origin: { ...ra.origin, repoKey: "repoAAAAAAAAAAAA" },
		});
		updateSource(rb.id, {
			kind: "repo",
			origin: { ...rb.origin, repoKey: "repoBBBBBBBBBBBB" },
		});

		expect(listSources().length).toBe(2);

		const e = fakeEmbedder();
		const reports = await reindexLibrary({ embedder: e, nowIso: "t" });
		expect(reports.every((r) => r.status === "ok")).toBe(true);

		const hits = await searchLibrary("rotate signing key ninety days", {
			embedder: e,
			ctx: { currentRepoKey: "repoBBBBBBBBBBBB" },
			nowIso: "t",
		});

		// both sources surface the same content...
		const names = new Set(hits.map((h) => h.origin.name));
		expect(names.has("projA")).toBe(true);
		expect(names.has("projB")).toBe(true);
		// ...but the current project (B) ranks first via origin affinity.
		expect(hits[0].origin.name).toBe("projB");
		// citations point at real files and line spans.
		expect(hits[0].citation.relPath).toBe("auth.md");
		expect(fs.existsSync(hits[0].citation.filePath)).toBe(true);
		expect(hits[0].citation.lineStart).toBeGreaterThanOrEqual(1);
		expect(hits[0].freshness).toBe("fresh");
	});
});

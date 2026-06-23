// src/lib/library/__tests__/mcp-schemas.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSource, reindexLibrary, searchLibrary } from "../index.js";
import { LibrarySearchResultSchema } from "../mcp-schemas.js";
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

describe("library MCP result schema", () => {
	let cacheHome: string;
	let dir: string;
	beforeEach(() => {
		cacheHome = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-mcp-cache-")),
		);
		process.env.AI_CORTEX_CACHE_HOME = cacheHome;
		dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-mcp-dir-")),
		);
		fs.writeFileSync(
			path.join(dir, "n.md"),
			"# Note\nThe scheduler uses a token bucket.\n",
		);
	});
	afterEach(() => {
		delete process.env.AI_CORTEX_CACHE_HOME;
		for (const d of [cacheHome, dir])
			fs.rmSync(d, { recursive: true, force: true });
	});

	it("facade search output validates against the MCP result schema", async () => {
		const e = fakeEmbedder();
		registerSource({ rootPath: dir, nowIso: "t" });
		await reindexLibrary({ embedder: e, nowIso: "t" });
		const hits = await searchLibrary("token bucket scheduler", {
			embedder: e,
			nowIso: "t",
		});
		const structured = { hits, sourcesQueried: 1 };
		expect(() => LibrarySearchResultSchema.parse(structured)).not.toThrow();
		expect(structured.hits[0].citation.relPath).toBe("n.md");
	});
});

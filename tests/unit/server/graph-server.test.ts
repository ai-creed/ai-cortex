import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { mkRepoKey, cleanupRepo } from "../../helpers/memory-fixtures.js";
import { transcodeCacheToDb } from "../../../src/lib/cache-store-sqlite.js";
import { getCacheDbFilePath } from "../../../src/lib/cache-store.js";
import { startGraphServer } from "../../../src/server/graph-server.js";
import type { RepoCache } from "../../../src/lib/models.js";

function cache(repoKey: string): RepoCache {
	return {
		schemaVersion: "3.1",
		repoKey,
		worktreeKey: "wt00000000000000",
		worktreePath: "/wt",
		indexedAt: "t",
		fingerprint: "f",
		packageMeta: { name: "fix", version: "0.0.0", framework: null },
		entryFiles: [],
		files: [{ path: "a.ts", kind: "file" }],
		docs: [],
		imports: [],
		functions: [],
		calls: [],
	};
}

describe("graph server", () => {
	const keys: string[] = [];
	let stop: (() => Promise<void>) | null = null;
	afterEach(async () => {
		if (stop) await stop();
		stop = null;
		for (const k of keys.splice(0)) await cleanupRepo(k);
	});

	it("serves a GraphPayload from /graph and never writes the cache root", async () => {
		const repoKey = await mkRepoKey("graph-server");
		keys.push(repoKey);
		transcodeCacheToDb(
			cache(repoKey),
			getCacheDbFilePath(repoKey, "wt00000000000000"),
		);

		const webDir = fs.mkdtempSync(path.join(os.tmpdir(), "webdir-"));
		const srv = await startGraphServer({ webDir, host: "127.0.0.1", port: 0 });
		stop = srv.stop;

		const before = fs.statSync(process.env.AI_CORTEX_CACHE_HOME!).mtimeMs;
		const res = await fetch(`${srv.url}/graph?mode=code&scope=all`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.mode).toBe("code");
		expect(
			body.nodes.some((n: { id: string }) => n.id === `project:${repoKey}`),
		).toBe(true);
		const after = fs.statSync(process.env.AI_CORTEX_CACHE_HOME!).mtimeMs;
		expect(after).toBe(before);
	});

	it("GET /node/:id returns node detail", async () => {
		const repoKey = await mkRepoKey("graph-node");
		keys.push(repoKey);
		transcodeCacheToDb(
			cache(repoKey),
			getCacheDbFilePath(repoKey, "wt00000000000000"),
		);
		const webDir = fs.mkdtempSync(path.join(os.tmpdir(), "webdir-"));
		const srv = await startGraphServer({ webDir, host: "127.0.0.1", port: 0 });
		stop = srv.stop;

		const nodeId = `file:${repoKey}:a.ts`;
		const res = await fetch(`${srv.url}/node/${encodeURIComponent(nodeId)}`);
		expect(res.status).toBe(200);
		const detail = await res.json();
		expect(detail.kind).toBe("file");
		expect(detail.fields.path).toBe("a.ts");
	});

	it("GET /open is best-effort: no $EDITOR => opened:false, status 200", async () => {
		const repoKey = await mkRepoKey("graph-open");
		keys.push(repoKey);
		const webDir = fs.mkdtempSync(path.join(os.tmpdir(), "webdir-"));
		const srv = await startGraphServer({ webDir, host: "127.0.0.1", port: 0 });
		stop = srv.stop;

		const prev = process.env.EDITOR;
		delete process.env.EDITOR;
		try {
			const res = await fetch(`${srv.url}/open?path=/tmp/x.ts&line=3`);
			expect(res.status).toBe(200);
			expect((await res.json()).opened).toBe(false);
		} finally {
			if (prev !== undefined) process.env.EDITOR = prev;
		}
	});
});

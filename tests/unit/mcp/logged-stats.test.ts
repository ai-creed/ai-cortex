import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { logged } from "../../../src/mcp/server.js";
import { closeAllSinks } from "../../../src/lib/stats/registry.js";
import { statsDbPath } from "../../../src/lib/stats/paths.js";

const repoKey = "6c6f676765640000";

let originalCacheHome: string | undefined;
let tmp: string;

beforeEach(() => {
	originalCacheHome = process.env.AI_CORTEX_CACHE_HOME;
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logged-stats-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});

afterEach(() => {
	closeAllSinks();
	if (originalCacheHome === undefined) delete process.env.AI_CORTEX_CACHE_HOME;
	else process.env.AI_CORTEX_CACHE_HOME = originalCacheHome;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function readRows() {
	const db = new Database(statsDbPath(repoKey), { readonly: true });
	const rows = db.prepare("SELECT * FROM tool_calls ORDER BY ts").all();
	db.close();
	return rows as any[];
}

const flushSink = () => new Promise<void>((r) => setImmediate(r));

describe("logged() with stats hooks", () => {
	it("writes an ok row with result fields on success", async () => {
		const handler = logged<{ q: string }, { cacheStatus: "fresh"; n: number }>(
			"suggest_files",
			(p) => ({ q: p.q }),
			(p) => ({ query_len: p.q.length }),
			() => repoKey,
			(r) => ({ cache_status: r.cacheStatus, mode: "deep", result_count: r.n }),
			async () => ({ cacheStatus: "fresh", n: 3 }),
		);
		await handler({ q: "hello" });
		await flushSink();
		const rows = readRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			tool: "suggest_files",
			status: "ok",
			cache_status: "fresh",
			mode: "deep",
			result_count: 3,
			query_len: 5,
			err_class: null,
		});
	});

	it("writes an error row with err_class on throw", async () => {
		class MyErr extends Error {}
		const handler = logged<Record<string, never>, never>(
			"tool_x",
			() => ({}),
			() => null,
			() => repoKey,
			() => null,
			async () => {
				throw new MyErr("path /tmp/secret");
			},
		);
		await expect(handler({} as Record<string, never>)).rejects.toThrow();
		await flushSink();
		const rows = readRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			tool: "tool_x",
			status: "error",
			err_class: "MyErr",
			result_count: null,
			cache_status: null,
		});
	});

	it("drops the row when resolveRepoKey returns null but still runs the handler", async () => {
		const handler = logged<Record<string, never>, { ok: true }>(
			"global_tool",
			() => ({}),
			() => null,
			() => null,
			() => null,
			async () => ({ ok: true }),
		);
		const result = await handler({} as Record<string, never>);
		await flushSink();
		expect(result).toEqual({ ok: true });
		expect(fs.existsSync(statsDbPath(repoKey))).toBe(false);
	});

	it("drops the row but preserves handler error when resolveRepoKey throws", async () => {
		const handler = logged<Record<string, never>, never>(
			"bad_resolve",
			() => ({}),
			() => null,
			() => {
				throw new Error("bad path");
			},
			() => null,
			async () => {
				throw new Error("handler should still run");
			},
		);
		await expect(handler({} as Record<string, never>)).rejects.toThrow("handler should still run");
	});
});

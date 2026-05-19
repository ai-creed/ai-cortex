import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openSink, writeEvent } from "../../../../src/lib/stats/sink.js";
import { statsDbPath } from "../../../../src/lib/stats/paths.js";

const KEY = "0123456789abcdef"; // 16-hex repoKey
let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "aicx-sink-"));
	process.env.AI_CORTEX_CACHE_HOME = home;
});
afterEach(() => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	fs.rmSync(home, { recursive: true, force: true });
});

describe("sink session_id (schema v3)", () => {
	it("fresh DB has a session_id column and persists it", () => {
		const sink = openSink(KEY);
		writeEvent(sink, {
			ts: 1, tool: "get_memory", dur_ms: 5, status: "ok",
			session_id: "sess-A",
		});
		sink.close();
		const db = new Database(statsDbPath(KEY), { readonly: true });
		const row = db.prepare("SELECT session_id FROM tool_calls").get() as {
			session_id: string | null;
		};
		expect(row.session_id).toBe("sess-A");
		db.close();
	});

	it("null session_id is allowed", () => {
		const sink = openSink(KEY);
		writeEvent(sink, { ts: 2, tool: "recall_memory", dur_ms: 1, status: "ok" });
		sink.close();
		const db = new Database(statsDbPath(KEY), { readonly: true });
		const r = db.prepare("SELECT session_id FROM tool_calls").get() as {
			session_id: string | null;
		};
		expect(r.session_id).toBeNull();
		db.close();
	});

	it("migrates a legacy v2 DB and self-heals (idempotent)", () => {
		const now = Date.now();
		fs.mkdirSync(path.dirname(statsDbPath(KEY)), { recursive: true });
		const raw = new Database(statsDbPath(KEY));
		raw.exec(
			"CREATE TABLE tool_calls (ts INTEGER NOT NULL, tool TEXT NOT NULL, dur_ms INTEGER NOT NULL, status TEXT NOT NULL, err_class TEXT, err_code TEXT, cache_status TEXT, mode TEXT, result_count INTEGER, query_len INTEGER, meta TEXT, synthetic INTEGER NOT NULL DEFAULT 0)",
		);
		raw.pragma("user_version = 2");
		raw.prepare(
			"INSERT INTO tool_calls (ts,tool,dur_ms,status,synthetic) VALUES (?,'recall_memory',1,'ok',0)",
		).run(now);
		raw.close();

		const sink = openSink(KEY); // migrates v2→v3
		writeEvent(sink, { ts: now + 1, tool: "get_memory", dur_ms: 2, status: "ok", session_id: "s3" });
		sink.close();
		openSink(KEY).close(); // second open is a no-op (idempotent)

		const db = new Database(statsDbPath(KEY), { readonly: true });
		expect(db.pragma("user_version", { simple: true })).toBe(3);
		const rows = db.prepare("SELECT session_id FROM tool_calls ORDER BY ts").all() as Array<{ session_id: string | null }>;
		expect(rows.map((r) => r.session_id)).toEqual([null, "s3"]);
		db.close();
	});

	it("degrades to legacy insert if the column is absent (failed ALTER)", () => {
		fs.mkdirSync(path.dirname(statsDbPath(KEY)), { recursive: true });
		const raw = new Database(statsDbPath(KEY));
		raw.exec(
			"CREATE TABLE tool_calls (ts INTEGER NOT NULL, tool TEXT NOT NULL, dur_ms INTEGER NOT NULL, status TEXT NOT NULL, err_class TEXT, err_code TEXT, cache_status TEXT, mode TEXT, result_count INTEGER, query_len INTEGER, meta TEXT, synthetic INTEGER NOT NULL DEFAULT 0)",
		);
		raw.pragma("user_version = 3"); // claims v3 but column is missing
		raw.close();
		const sink = openSink(KEY); // must not throw
		expect(() =>
			writeEvent(sink, { ts: 4, tool: "get_memory", dur_ms: 1, status: "ok", session_id: "x" }),
		).not.toThrow();
		sink.close();
		const db = new Database(statsDbPath(KEY), { readonly: true });
		expect(db.prepare("SELECT count(*) c FROM tool_calls").get()).toEqual({ c: 1 });
		db.close();
	});

	it("a THROWING v2→v3 migration still degrades (sink never crashes)", () => {
		fs.mkdirSync(path.dirname(statsDbPath(KEY)), { recursive: true });
		const raw = new Database(statsDbPath(KEY));
		raw.exec(
			"CREATE TABLE tool_calls (ts INTEGER NOT NULL, tool TEXT NOT NULL, dur_ms INTEGER NOT NULL, status TEXT NOT NULL, err_class TEXT, err_code TEXT, cache_status TEXT, mode TEXT, result_count INTEGER, query_len INTEGER, meta TEXT, synthetic INTEGER NOT NULL DEFAULT 0)",
		);
		raw.pragma("user_version = 2");
		raw.close();
		const proto = Database.prototype as unknown as {
			exec: (sql: string) => unknown;
		};
		const orig = proto.exec;
		const spy = vi
			.spyOn(proto, "exec")
			.mockImplementation(function (this: unknown, sql: string) {
				if (String(sql).includes("ADD COLUMN session_id"))
					throw new Error("simulated locked DB");
				return (orig as (s: string) => unknown).call(this, sql);
			});
		try {
			let sink!: ReturnType<typeof openSink>;
			expect(() => {
				sink = openSink(KEY);
			}).not.toThrow();
			expect(() =>
				writeEvent(sink, {
					ts: Date.now(),
					tool: "get_memory",
					dur_ms: 1,
					status: "ok",
					session_id: "x",
				}),
			).not.toThrow();
			sink.close();
		} finally {
			spy.mockRestore();
		}
		const db = new Database(statsDbPath(KEY), { readonly: true });
		expect(db.prepare("SELECT count(*) c FROM tool_calls").get()).toEqual({ c: 1 });
		db.close();
	});
});

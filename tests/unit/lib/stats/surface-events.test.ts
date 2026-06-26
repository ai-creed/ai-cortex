import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	appendSurfaceEvent,
	readSurfaceEvents,
	appendGetEvent,
	readGetEvents,
} from "../../../../src/lib/stats/surface-events.js";

const KEY = "0123456789abcdef";
let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "aicx-se-"));
	process.env.AI_CORTEX_CACHE_HOME = home;
});
afterEach(() => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	fs.rmSync(home, { recursive: true, force: true });
});

describe("surface-events", () => {
	const now = Date.now();

	it("appends and reads back recent events", () => {
		appendSurfaceEvent(KEY, {
			ts: now,
			session_id: "s1",
			memoryIds: ["m1", "m2"],
			count: 2,
		});
		appendSurfaceEvent(KEY, {
			ts: now + 1,
			session_id: null,
			memoryIds: ["m3"],
			count: 1,
		});
		const evs = readSurfaceEvents(KEY);
		expect(evs.map((e) => e.ts)).toEqual([now, now + 1]);
		expect(evs[0]!.memoryIds).toEqual(["m1", "m2"]);
		expect(evs[1]!.session_id).toBeNull();
	});

	it("skips malformed lines and prunes stale ones, rewriting the file", () => {
		appendSurfaceEvent(KEY, {
			ts: now,
			session_id: "s",
			memoryIds: [],
			count: 0,
		});
		const p = path.join(home, KEY, "adoption", "surface-events.jsonl");
		fs.appendFileSync(
			p,
			JSON.stringify({
				ts: now - 91 * 24 * 3600 * 1000,
				session_id: "old",
				memoryIds: [],
				count: 0,
			}) + "\n{not json\n\n",
		);
		expect(() => readSurfaceEvents(KEY)).not.toThrow();
		const evs = readSurfaceEvents(KEY);
		expect(evs.length).toBe(1);
		expect(evs[0]!.session_id).toBe("s");
		expect(fs.readFileSync(p, "utf8").trim().split("\n").length).toBe(1);
	});

	it("read on missing file returns []", () => {
		expect(readSurfaceEvents(KEY)).toEqual([]);
	});
});

describe("get-events", () => {
	const now = Date.now();

	it("appends and reads back get-events round-trip", () => {
		appendGetEvent(KEY, { ts: now, session_id: "s1", memoryId: "mem-a" });
		appendGetEvent(KEY, { ts: now + 1, session_id: null, memoryId: "mem-b" });
		const evs = readGetEvents(KEY);
		expect(evs.map((e) => e.memoryId)).toEqual(["mem-a", "mem-b"]);
		expect(evs[0]!.session_id).toBe("s1");
		expect(evs[1]!.session_id).toBeNull();
	});

	it("skips malformed lines and prunes stale (>90d) ones, rewriting the file", () => {
		appendGetEvent(KEY, { ts: now, session_id: "s", memoryId: "fresh" });
		const p = path.join(home, KEY, "adoption", "get-events.jsonl");
		fs.appendFileSync(
			p,
			JSON.stringify({
				ts: now - 91 * 24 * 3600 * 1000,
				session_id: "old",
				memoryId: "stale",
			}) + "\n{not json\n\n",
		);
		expect(() => readGetEvents(KEY)).not.toThrow();
		const evs = readGetEvents(KEY);
		expect(evs.length).toBe(1);
		expect(evs[0]!.memoryId).toBe("fresh");
		expect(fs.readFileSync(p, "utf8").trim().split("\n").length).toBe(1);
	});

	it("read on missing file returns []", () => {
		expect(readGetEvents("fedcba9876543210")).toEqual([]);
	});
});

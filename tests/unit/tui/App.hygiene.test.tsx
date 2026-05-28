import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { App, type AppProps } from "../../../src/tui/App.js";
import { cacheRoot, statsConfigPath } from "../../../src/lib/stats/paths.js";
import type { Snapshot } from "../../../src/tui/readAll.js";

const SNAP: Snapshot = {
	projects: [
		{ repoKey: "aaaaaaaaaaaaaaaa", name: "ai-cortex", calls: 100 },
		{ repoKey: "bbbbbbbbbbbbbbbb", name: null, calls: 0 },
	],
	projectNames: { aaaaaaaaaaaaaaaa: "ai-cortex", bbbbbbbbbbbbbbbb: null },
	aggregate: { total: 100, errs: 1, p50: 10, p95: 100, cache_status: { fresh: 100, reindexed: 0, stale: 0 } },
	memory: { active: 0, candidate: 0, pinned: 0, deprecated: 0, topAccessed: [] },
	storage: { aaaaaaaaaaaaaaaa: 250_000, bbbbbbbbbbbbbbbb: 0 },
	latencyPerTool: {},
	topTools: [],
	meta: { indexedAt: null, fingerprint: null, fileCount: null, name: null },
	recallGetRatio: 0,
	suggestHit: 0,
	adoption: {
		sessions: [],
		summary: {
			sessionCount: 10,
			memoryUsedPct: 50,
			recallToGetPct: 50,
			sessionsRecalled: 4,
			sessionsRecallToGet: 2,
			surfaceToGetPct: 0,
			extractCleanupPct: 0,
			unattributedShare: 0,
			histogram: { used: 5, notUsed: 5 },
		},
	},
};

const flush = () => new Promise((r) => setTimeout(r, 50));

describe("App hygiene + help wiring", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-app-"));
		process.env.AI_CORTEX_CACHE_HOME = tmp;
		fs.mkdirSync(cacheRoot(), { recursive: true });
		fs.mkdirSync(path.join(cacheRoot(), "aaaaaaaaaaaaaaaa"), { recursive: true });
		fs.mkdirSync(path.join(cacheRoot(), "bbbbbbbbbbbbbbbb"), { recursive: true });
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		delete process.env.AI_CORTEX_CACHE_HOME;
	});

	const read: AppProps["read"] = () => SNAP;

	it("? opens help overlay; ? closes it", async () => {
		const { stdin, lastFrame } = render(<App read={read} termSize={{ cols: 100, rows: 40 }} />);
		await flush();
		stdin.write("?");
		await flush();
		expect(lastFrame()).toContain("What these numbers mean");
		stdin.write("?");
		await flush();
		expect(lastFrame()).not.toContain("What these numbers mean");
	});

	it("e excludes the selected project and shows a toast", async () => {
		const { stdin, lastFrame } = render(<App read={read} termSize={{ cols: 100, rows: 40 }} />);
		await flush();
		stdin.write("e");
		await flush();
		const cfg = JSON.parse(fs.readFileSync(statsConfigPath(), "utf8"));
		expect(cfg.excluded).toEqual(["aaaaaaaaaaaaaaaa"]);
		expect(lastFrame()).toContain("excluded");
	});

	it("x opens confirm showing calls + size + impact; y deletes the cache dir", async () => {
		const { stdin, lastFrame } = render(<App read={read} termSize={{ cols: 100, rows: 40 }} />);
		await flush();
		stdin.write("x");
		await flush();
		const frame = lastFrame() ?? "";
		// Spec §confirm dialog (clean only): must show calls, size,
		// and disk-impact framing so the user knows what's lost.
		expect(frame).toContain("Clean workspace?");
		expect(frame).toContain("100 calls");
		expect(frame).toContain("0.3 MB");
		expect(frame).toContain("frees ~0.3 MB");
		expect(frame).toContain("cannot be undone");
		stdin.write("y");
		await flush();
		expect(fs.existsSync(path.join(cacheRoot(), "aaaaaaaaaaaaaaaa"))).toBe(false);
		expect(lastFrame()).toContain("cleaned");
	});

	it("x then n cancels without deleting", async () => {
		const { stdin, lastFrame } = render(<App read={read} termSize={{ cols: 100, rows: 40 }} />);
		await flush();
		stdin.write("x");
		await flush();
		stdin.write("n");
		await flush();
		expect(lastFrame()).not.toContain("Clean workspace?");
		expect(fs.existsSync(path.join(cacheRoot(), "aaaaaaaaaaaaaaaa"))).toBe(true);
	});
});

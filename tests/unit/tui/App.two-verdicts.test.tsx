import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");
const flush = () => new Promise((r) => setTimeout(r, 50));

import { App, type AppProps } from "../../../src/tui/App.js";
import { cacheRoot } from "../../../src/lib/stats/paths.js";
import type { Snapshot } from "../../../src/tui/readAll.js";
import type { Aggregate, MemoryHealth, CacheMeta } from "../../../src/lib/stats/query.js";

const A = "aaaaaaaaaaaaaaaa";

// Distinguishable numbers for overall vs focused.
// Every value is unique across the two snapshots so a "wires the wrong
// one" regression flips the visible output. Types are spelled out
// rather than `as any` cast — the repo's lint override exempts only
// `tests/**/*.ts`; `.tsx` test files must satisfy `no-explicit-any`.

const OVERALL_AGGREGATE: Aggregate = {
	total: 999, errs: 30, p50: 88, p95: 444,
	cache_status: { fresh: 600, reindexed: 350, stale: 49 },
};
const OVERALL_MEMORY: MemoryHealth = {
	active: 222, candidate: 80, pinned: 7, deprecated: 90, topAccessed: [],
};
const NULL_META: CacheMeta = {
	indexedAt: null, fingerprint: null, fileCount: null, name: null, worktreePath: null,
};

const OVERALL: Snapshot = {
	projects: [{ repoKey: A, name: "ai-cortex", calls: 999 }],
	projectNames: { [A]: "ai-cortex" },
	aggregate: OVERALL_AGGREGATE,
	memory: OVERALL_MEMORY,
	// Storage that ONLY appears in OVERALL — the focused snapshot below
	// uses {} so an implementation that wrongly reads snap.det.storage
	// shows zero MB and fails the storage-source guard.
	storage: { [A]: 18_000_000 },
	latencyPerTool: {},
	topTools: [],
	meta: NULL_META,
	recallGetRatio: 0,
	suggestHit: 0.91, // overall — appears under (all projects) only
	adoption: {
		sessions: [],
		summary: {
			sessionCount: 25,
			memoryUsedPct: 80,
			recallToGetPct: 75,
			sessionsRecalled: 20,
			sessionsRecallToGet: 15,
			surfaceToGetPct: 0,
			extractCleanupPct: 0,
			unattributedShare: 0,
			histogram: { used: 20, notUsed: 5 },
		},
	},
};

const FOCUSED_AGGREGATE: Aggregate = {
	total: 111, errs: 2, p50: 12, p95: 80,
	cache_status: { fresh: 100, reindexed: 10, stale: 1 },
};
const FOCUSED_MEMORY: MemoryHealth = {
	active: 17, candidate: 3, pinned: 1, deprecated: 5, topAccessed: [],
};
const FOCUSED_META: CacheMeta = {
	indexedAt: null, fingerprint: null, fileCount: null, name: "ai-cortex", worktreePath: null,
};

const FOCUSED: Snapshot = {
	...OVERALL,
	aggregate: FOCUSED_AGGREGATE,
	memory: FOCUSED_MEMORY,
	// Storage is intentionally empty in the focused snapshot. If App
	// accidentally passes `snap.det.storage` into `Overview`'s `storage`
	// prop, the dashboard shows no MB at all and the storage-source guard
	// trips (instead of false-passing because of inherited 18 MB).
	storage: {},
	suggestHit: 0.44, // focused — appears under (this project) only
	adoption: {
		sessions: [],
		summary: {
			sessionCount: 6,
			memoryUsedPct: 41,
			recallToGetPct: 26,
			sessionsRecalled: 5,
			sessionsRecallToGet: 1,
			surfaceToGetPct: 0,
			extractCleanupPct: 0,
			unattributedShare: 0,
			histogram: { used: 2, notUsed: 4 },
		},
	},
	meta: FOCUSED_META,
};

describe("App two-verdicts wiring", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-app-2v-"));
		process.env.AI_CORTEX_CACHE_HOME = tmp;
		fs.mkdirSync(cacheRoot(), { recursive: true });
		fs.mkdirSync(path.join(cacheRoot(), A), { recursive: true });
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		delete process.env.AI_CORTEX_CACHE_HOME;
	});

	const read: AppProps["read"] = (_w, focus) => (focus === null ? OVERALL : FOCUSED);

	it("renders both band titles", async () => {
		const { lastFrame } = render(<App read={read} termSize={{ cols: 120, rows: 40 }} />);
		await flush();
		const frame = strip(lastFrame());
		expect(frame).toContain("(all projects)");
		expect(frame).toContain("ai-cortex (this project)");
	});

	it("overall band carries OVERALL values UNDER `(all projects)`; per-project band carries FOCUSED values UNDER `(this project)`", async () => {
		// Strict source-to-band guard. We split the frame on the band titles
		// so that an implementation that crossed `snap.ov` and `snap.det`
		// would put the wrong numbers under the wrong title and the
		// `not.toContain` assertions below would trip. Without this
		// segmentation, presence-anywhere assertions miss a verdict swap.
		const { lastFrame } = render(<App read={read} termSize={{ cols: 120, rows: 40 }} />);
		await flush();
		const frame = strip(lastFrame());

		const overallIdx = frame.indexOf("(all projects)");
		const projectIdx = frame.indexOf("(this project)");
		expect(overallIdx).toBeGreaterThanOrEqual(0);
		expect(projectIdx).toBeGreaterThan(overallIdx);

		const overallBand = frame.slice(overallIdx, projectIdx);

		const projectAndBelow = frame.slice(projectIdx);
		const panelAnchor = projectAndBelow.indexOf("Effectiveness");
		const projectBand =
			panelAnchor > 0 ? projectAndBelow.slice(0, panelAnchor) : projectAndBelow;

		expect(overallBand).toContain("memory used 80%");
		expect(overallBand).toContain("recall→get 75%");
		expect(overallBand).toContain("suggest hit 91%");
		expect(overallBand).not.toContain("memory used 41%");
		expect(overallBand).not.toContain("recall→get 26%");
		expect(overallBand).not.toContain("suggest hit 44%");

		expect(projectBand).toContain("memory used 41%");
		expect(projectBand).toContain("recall→get 26%");
		expect(projectBand).toContain("suggest hit 44%");
		expect(projectBand).not.toContain("memory used 80%");
		expect(projectBand).not.toContain("recall→get 75%");
		expect(projectBand).not.toContain("suggest hit 91%");
	});

	it("Activity panel uses FOCUSED aggregate, not OVERALL aggregate", async () => {
		const { lastFrame } = render(<App read={read} termSize={{ cols: 120, rows: 40 }} />);
		await flush();
		const frame = strip(lastFrame());
		expect(frame).toContain("111 calls");
		expect(frame).not.toContain("999 calls");
		expect(frame).toContain("p50 12ms");
		expect(frame).not.toContain("p50 88ms");
	});

	it("Memory panel uses FOCUSED memory (active 17), not OVERALL memory (active 222)", async () => {
		const { lastFrame } = render(<App read={read} termSize={{ cols: 120, rows: 40 }} />);
		await flush();
		const frame = strip(lastFrame());
		expect(frame).toContain("17 active");
		expect(frame).not.toContain("222 active");
	});

	it("Storage panel stays aggregate (uses snap.ov.storage, NOT snap.det.storage)", async () => {
		const { lastFrame } = render(<App read={read} termSize={{ cols: 120, rows: 40 }} />);
		await flush();
		const frame = strip(lastFrame());
		expect(frame).toMatch(/18\.0 MB/);
		expect(frame).toMatch(/18\.0 MB total/);
		expect(frame).toMatch(/Storage/);
	});

	// Spec line 228 explicitly requires App-level coverage for BOTH `det`
	// present and `det` null. The next two tests exercise the null path:
	// when no project is selected (empty `projects: []`), App must compute
	// `snap.det === null`, OMIT the `(this project)` band, and route panels
	// to the OVERALL aggregate fallback.

	const EMPTY: Snapshot = {
		...OVERALL,
		projects: [],
		projectNames: {},
	};
	const readEmpty: AppProps["read"] = () => EMPTY;

	it("App.det === null: omits the per-project band entirely", async () => {
		const { lastFrame } = render(
			<App read={readEmpty} termSize={{ cols: 120, rows: 40 }} />,
		);
		await flush();
		const frame = strip(lastFrame());
		expect(frame).toContain("(all projects)");
		expect(frame).not.toContain("(this project)");
		expect(frame).not.toMatch(/ai-cortex\s+\(this project\)/);
	});

	it("App.det === null: panels fall back to OVERALL aggregate (Spec line 228)", async () => {
		const { lastFrame } = render(
			<App read={readEmpty} termSize={{ cols: 120, rows: 40 }} />,
		);
		await flush();
		const frame = strip(lastFrame());
		expect(frame).toContain("999 calls");
		expect(frame).toContain("p50 88ms");
		expect(frame).toContain("222 active");
		expect(frame).not.toContain("111 calls");
		expect(frame).not.toContain("17 active");
	});
});

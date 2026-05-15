import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { App, type AppProps } from "../../../src/tui/App.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");
const flush = () => new Promise((r) => setTimeout(r, 50));

const fakeRead = () => ({
	projects: [{ repoKey: "ai-cortex", calls: 5 }],
	aggregate: {
		total: 5,
		errs: 0,
		p50: 10,
		p95: 12,
		cache_status: { fresh: 5, reindexed: 0, stale: 0 },
	},
	memory: { active: 0, candidate: 0, pinned: 0, deprecated: 0, topAccessed: [] },
	storage: { "ai-cortex": 100 },
	latencyPerTool: {},
	topTools: [{ tool: "suggest_files", n: 5, errs: 0 }],
	meta: { indexedAt: null, fingerprint: null, fileCount: null },
	recallGetRatio: 0,
});

describe("App", () => {
	it("renders Overview by default and shows last-error footer hint", async () => {
		const { lastFrame } = render(
			<App read={fakeRead as AppProps["read"]} initialWindow="7d" once={true} />,
		);
		await flush();
		const frame = strip(lastFrame());
		expect(frame).toContain("ai-cortex");
		expect(frame).toContain("[q]uit");
	});

	it("guards against terminals smaller than 80x24", () => {
		const { lastFrame } = render(
			<App
				read={fakeRead as AppProps["read"]}
				initialWindow="7d"
				once={true}
				termSize={{ cols: 40, rows: 10 }}
			/>,
		);
		expect(strip(lastFrame())).toContain("Terminal too small");
	});
});

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { App, type AppProps } from "../../../src/tui/App.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");
const flush = () => new Promise((r) => setTimeout(r, 80));

// App calls read twice per tick (cross-project, then selected repoKey).
// The fake returns a snapshot keyed off the focus arg so the detail header
// reflects the selected project.
const NAMES: Record<string, string> = {
	"ai-cortex": "ai-cortex",
	"ai-whisper": "ai-whisper",
};

function makeRead() {
	return vi.fn((_w: string, focus: string | null) => ({
		projects: [
			{ repoKey: "ai-cortex", name: "ai-cortex", calls: 5 },
			{ repoKey: "ai-whisper", name: "ai-whisper", calls: 9 },
		],
		projectNames: NAMES,
		aggregate: {
			total: 5,
			errs: 0,
			p50: 10,
			p95: 12,
			cache_status: { fresh: 5, reindexed: 0, stale: 0 },
		},
		memory: {
			active: 0,
			candidate: 0,
			pinned: 0,
			deprecated: 0,
			topAccessed: [],
		},
		storage: { "ai-cortex": 100, "ai-whisper": 200 },
		latencyPerTool: {},
		topTools: [{ tool: "suggest_files", n: 5, errs: 0 }],
		meta: focus
			? {
					indexedAt: "2026-05-15T01:00:00.000Z",
					fingerprint: "abc",
					fileCount: 10,
					name: NAMES[focus] ?? focus,
				}
			: { indexedAt: null, fingerprint: null, fileCount: null, name: null },
		recallGetRatio: 0,
	}));
}

describe("App", () => {
	it("renders the project list with an inline detail panel (Tools by default)", async () => {
		const { lastFrame } = render(
			<App read={makeRead() as AppProps["read"]} initialWindow="7d" once={true} />,
		);
		await flush();
		const frame = strip(lastFrame());
		expect(frame).toContain("ai-cortex");
		expect(frame).toContain("ai-whisper");
		expect(frame).toMatch(/Tools\*/);
		expect(frame).toContain("[q]uit");
		// No separate-screen back affordance.
		expect(frame).not.toContain("[Esc]");
	});

	it("moves selection with 'j' and the detail header follows", async () => {
		const { stdin, lastFrame } = render(
			<App read={makeRead() as AppProps["read"]} initialWindow="7d" />,
		);
		await flush();
		stdin.write("j");
		await flush();
		const frame = strip(lastFrame());
		expect(frame).toContain("── ai-whisper ──");
	});

	it("switches the detail tab with '2'", async () => {
		const { stdin, lastFrame } = render(
			<App read={makeRead() as AppProps["read"]} initialWindow="7d" />,
		);
		await flush();
		stdin.write("2");
		await flush();
		expect(strip(lastFrame())).toMatch(/Memory\*/);
	});

	it("guards against terminals smaller than 80x24", () => {
		const { lastFrame } = render(
			<App
				read={makeRead() as AppProps["read"]}
				initialWindow="7d"
				once={true}
				termSize={{ cols: 40, rows: 10 }}
			/>,
		);
		expect(strip(lastFrame())).toContain("Terminal too small");
	});
});

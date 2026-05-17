import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { MemoryBrowser } from "../../../src/tui/memory/MemoryBrowser.js";
import type { MemoryListGroups } from "../../../src/lib/stats/memory-browser.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");
const flush = () => new Promise((r) => setTimeout(r, 50));

const groups: MemoryListGroups = {
	error: null,
	groups: [
		{
			status: "active",
			count: 2,
			items: [
				{ id: "a", type: "decision", status: "active", title: "First", updatedAt: "2026-05-10", pinned: false },
				{ id: "b", type: "feedback", status: "active", title: "Second", updatedAt: "2026-05-09", pinned: false },
			],
		},
		{ status: "candidate", count: 0, items: [] },
		{
			status: "deprecated",
			count: 1,
			items: [
				{ id: "d1", type: "user", status: "deprecated", title: "Old", updatedAt: "2026-04-01", pinned: false },
			],
		},
	],
};

const deps = {
	loadMemoryList: () => groups,
	memoryActivity: () => ({
		recorded: [1, 2, 3],
		used: [0, 1, 0],
		recordedTotal: 6,
		usedTotal: 1,
		buckets: 30,
	}),
	loadMemoryBody: async (_rk: string, id: string) => ({
		record: {
			frontmatter: {
				id,
				type: "decision",
				status: "active",
				title: id,
				version: 1,
				createdAt: "2026-05-10T00:00:00.000Z",
				updatedAt: "2026-05-10T00:00:00.000Z",
				source: "explicit",
				confidence: 1,
				pinned: false,
				scope: { files: [], tags: [] },
				provenance: [],
				supersedes: [],
				mergedInto: null,
				deprecationReason: null,
				promotedFrom: [],
				rewrittenAt: null,
			},
			body: `body of ${id}`,
		},
		error: null,
	}),
};

describe("MemoryBrowser", () => {
	it("loads and shows the first selectable memory body", async () => {
		const { lastFrame } = render(
			<MemoryBrowser
				repoKey="rk"
				window="7d"
				onExit={() => {}}
				deps={deps as never}
			/>,
		);
		await flush();
		const f = strip(lastFrame());
		expect(f).toContain("First");
		expect(f).toContain("body of a");
		expect(f).toContain("rec");
	});

	it("j moves selection to the next row and loads its body", async () => {
		const { stdin, lastFrame } = render(
			<MemoryBrowser repoKey="rk" window="7d" onExit={() => {}} deps={deps as never} />,
		);
		await flush();
		stdin.write("j");
		await flush();
		expect(strip(lastFrame())).toContain("body of b");
	});

	it("J jumps to the next non-empty group; K jumps back", async () => {
		const { stdin, lastFrame } = render(
			<MemoryBrowser repoKey="rk" window="7d" onExit={() => {}} deps={deps as never} />,
		);
		await flush();
		// selection starts at 'a' (active group). J → first row of next
		// non-empty group, skipping the empty candidate group → 'd1'.
		stdin.write("J");
		await flush();
		expect(strip(lastFrame())).toContain("body of d1");
		stdin.write("K");
		await flush();
		expect(strip(lastFrame())).toContain("body of a");
	});

	it("Esc calls onExit", async () => {
		const onExit = vi.fn();
		const { stdin } = render(
			<MemoryBrowser repoKey="rk" window="7d" onExit={onExit} deps={deps as never} />,
		);
		await flush();
		stdin.write("\x1b");
		await flush();
		expect(onExit).toHaveBeenCalled();
	});

	it("shows the empty state when there are no memories", async () => {
		const empty: MemoryListGroups = {
			error: null,
			groups: [
				{ status: "active", count: 0, items: [] },
				{ status: "candidate", count: 0, items: [] },
				{ status: "deprecated", count: 0, items: [] },
			],
		};
		const { lastFrame } = render(
			<MemoryBrowser
				repoKey="rk"
				window="7d"
				onExit={() => {}}
				deps={{ ...deps, loadMemoryList: () => empty } as never}
			/>,
		);
		await flush();
		expect(strip(lastFrame())).toContain("No memories for");
	});
});

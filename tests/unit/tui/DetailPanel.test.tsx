import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { DetailPanel } from "../../../src/tui/detail/DetailPanel.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");
const flush = () => new Promise((r) => setTimeout(r, 50));

const detail = {
	repoKey: "ai-cortex",
	aggregate: {
		total: 1247,
		errs: 4,
		p50: 38,
		p95: 187,
		cache_status: { fresh: 800, reindexed: 400, stale: 47 },
	},
	latencyPerTool: {
		suggest_files: { p50: 38, p95: 187, samples: 600 },
		recall_memory: { p50: 12, p95: 44, samples: 200 },
	},
	topTools: [
		{ tool: "suggest_files", n: 600, errs: 1 },
		{ tool: "recall_memory", n: 200, errs: 0 },
	],
	memory: {
		active: 247,
		candidate: 62,
		pinned: 1,
		deprecated: 4,
		topAccessed: [
			{ id: "mem-a", get_count: 14, last_accessed_at: "2026-05-15" },
		],
	},
	storage: { "ai-cortex": 18_000_000 },
	meta: {
		indexedAt: "2026-05-15T01:00:00.000Z",
		fingerprint: "abc1234",
		fileCount: 348,
		name: "ai-cortex",
	},
};

describe("DetailPanel", () => {
	it("starts on the Tools tab and shows the project name header", () => {
		const { lastFrame } = render(<DetailPanel detail={detail} />);
		const frame = strip(lastFrame());
		expect(frame).toMatch(/Tools\*/);
		expect(frame).toContain("ai-cortex");
		expect(frame).toContain("suggest_files");
	});

	it("switches to Memory tab on '2'", async () => {
		const { stdin, lastFrame } = render(<DetailPanel detail={detail} />);
		stdin.write("2");
		await flush();
		const frame = strip(lastFrame());
		expect(frame).toMatch(/Memory\*/);
		expect(frame).toContain("mem-a");
	});

	it("cycles tabs on Tab", async () => {
		const { stdin, lastFrame } = render(<DetailPanel detail={detail} />);
		stdin.write("\t");
		await flush();
		expect(strip(lastFrame())).toMatch(/Memory\*/);
	});

	it("shows an empty-state hint when detail is null", () => {
		const { lastFrame } = render(<DetailPanel detail={null} />);
		expect(strip(lastFrame())).toContain("Select a project");
	});
});

describe("DetailPanel onOpenMemoryBrowser", () => {
	it("fires with repoKey when Enter pressed on the Memory tab", async () => {
		const onOpen = vi.fn();
		const { stdin } = render(
			<DetailPanel detail={detail} onOpenMemoryBrowser={onOpen} />,
		);
		stdin.write("2"); // switch to Memory tab
		await flush();
		stdin.write("\r"); // Enter
		await flush();
		expect(onOpen).toHaveBeenCalledWith(detail.repoKey);
	});

	it("does not fire on non-Memory tabs", async () => {
		const onOpen = vi.fn();
		const { stdin } = render(
			<DetailPanel detail={detail} onOpenMemoryBrowser={onOpen} />,
		);
		stdin.write("\r"); // Enter on Tools (default)
		await flush();
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("does not fire when detail is null", async () => {
		const onOpen = vi.fn();
		const { stdin } = render(
			<DetailPanel detail={null} onOpenMemoryBrowser={onOpen} />,
		);
		stdin.write("2");
		await flush();
		stdin.write("\r");
		await flush();
		expect(onOpen).not.toHaveBeenCalled();
	});
});

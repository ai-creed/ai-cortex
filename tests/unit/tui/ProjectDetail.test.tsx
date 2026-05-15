import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ProjectDetail } from "../../../src/tui/detail/ProjectDetail.js";

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
	},
};

describe("ProjectDetail", () => {
	it("starts on the Tools tab", () => {
		const { lastFrame } = render(<ProjectDetail detail={detail} onBack={() => {}} />);
		const frame = strip(lastFrame());
		expect(frame).toMatch(/Tools\*/);
		expect(frame).toContain("suggest_files");
	});

	it("switches to Memory tab on '2'", async () => {
		const { stdin, lastFrame } = render(
			<ProjectDetail detail={detail} onBack={() => {}} />,
		);
		stdin.write("2");
		await flush();
		const frame = strip(lastFrame());
		expect(frame).toMatch(/Memory\*/);
		expect(frame).toContain("mem-a");
	});

	it("calls onBack on Esc", async () => {
		const onBack = vi.fn();
		const { stdin } = render(<ProjectDetail detail={detail} onBack={onBack} />);
		stdin.write("\x1b");
		await flush();
		expect(onBack).toHaveBeenCalled();
	});
});

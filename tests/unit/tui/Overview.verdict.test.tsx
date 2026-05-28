import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Overview } from "../../../src/tui/overview/Overview.js";
import type { Aggregate, MemoryHealth } from "../../../src/lib/stats/query.js";

const overallAggregate: Aggregate = {
	total: 999, errs: 30, p50: 88, p95: 444,
	cache_status: { fresh: 600, reindexed: 350, stale: 49 },
};
const overallMemory: MemoryHealth = {
	active: 200, candidate: 50, pinned: 5, deprecated: 100, topAccessed: [],
};

const selectedAggregate: Aggregate = {
	total: 111, errs: 2, p50: 12, p95: 80,
	cache_status: { fresh: 100, reindexed: 10, stale: 1 },
};
const selectedMemory: MemoryHealth = {
	active: 17, candidate: 3, pinned: 1, deprecated: 5, topAccessed: [],
};

const baseProps = {
	window: "7d" as const,
	projects: [{ repoKey: "aaaaaaaaaaaaaaaa", name: "ai-cortex", calls: 111 }],
	aggregate: overallAggregate,
	memory: overallMemory,
	memoryUsedPct: 80,
	recallToGetPct: 70,
	suggestHitPct: 60,
	totalSessions: 25,
	storage: { aaaaaaaaaaaaaaaa: 18_000_000 },
	projectNames: { aaaaaaaaaaaaaaaa: "ai-cortex" },
	selected: 0,
	onSelect: () => {},
	interactive: false,
};

describe("Overview renders VerdictBand on top", () => {
	it("VerdictBand appears above the projects/panels block", () => {
		const { lastFrame } = render(
			<Overview
				{...baseProps}
				selectedRepoKey={null}
				selectedName={null}
				selectedAggregate={null}
				selectedMemory={null}
				selectedMemoryUsedPct={0}
				selectedRecallToGetPct={0}
				selectedSuggestHitPct={0}
				selectedTotalSessions={0}
			/>,
		);
		const s = lastFrame() ?? "";
		const verdictIdx = s.indexOf("Is ai-cortex helping?");
		const effIdx = s.indexOf("Effectiveness");
		expect(verdictIdx).toBeGreaterThanOrEqual(0);
		expect(effIdx).toBeGreaterThan(verdictIdx);
	});
});

describe("Overview — two verdict bands", () => {
	it("renders both bands when a project is selected", () => {
		const { lastFrame } = render(
			<Overview
				{...baseProps}
				selectedRepoKey="aaaaaaaaaaaaaaaa"
				selectedName="ai-cortex"
				selectedAggregate={selectedAggregate}
				selectedMemory={selectedMemory}
				selectedMemoryUsedPct={40}
				selectedRecallToGetPct={20}
				selectedSuggestHitPct={55}
				selectedTotalSessions={6}
			/>,
		);
		const s = lastFrame() ?? "";
		expect(s).toContain("Is ai-cortex helping? (all projects)");
		expect(s).toContain("memory used 80%");
		expect(s).toContain("recall→get 70%");
		expect(s).toContain("suggest hit 60%");
		expect(s).toContain("ai-cortex (this project)");
		expect(s).toContain("memory used 40%");
		expect(s).toContain("recall→get 20%");
		expect(s).toContain("suggest hit 55%");
	});

	it("hides the per-project band when no project is selected", () => {
		const { lastFrame } = render(
			<Overview
				{...baseProps}
				projects={[]}
				selectedRepoKey={null}
				selectedName={null}
				selectedAggregate={null}
				selectedMemory={null}
				selectedMemoryUsedPct={0}
				selectedRecallToGetPct={0}
				selectedSuggestHitPct={0}
				selectedTotalSessions={0}
			/>,
		);
		const s = lastFrame() ?? "";
		expect(s).toContain("Is ai-cortex helping? (all projects)");
		expect(s).not.toContain("(this project)");
	});

	it("Effectiveness / Activity panels render the SELECTED project's numbers (not the aggregate)", () => {
		const { lastFrame } = render(
			<Overview
				{...baseProps}
				selectedRepoKey="aaaaaaaaaaaaaaaa"
				selectedName="ai-cortex"
				selectedAggregate={selectedAggregate}
				selectedMemory={selectedMemory}
				selectedMemoryUsedPct={40}
				selectedRecallToGetPct={20}
				selectedSuggestHitPct={55}
				selectedTotalSessions={6}
			/>,
		);
		const s = lastFrame() ?? "";
		expect(s).toContain("111 calls");
		expect(s).not.toContain("999 calls");
		expect(s).toContain("p50 12ms");
		expect(s).not.toContain("p50 88ms");
	});

	it("falls back to aggregate panels when no project is selected", () => {
		const { lastFrame } = render(
			<Overview
				{...baseProps}
				projects={[]}
				selectedRepoKey={null}
				selectedName={null}
				selectedAggregate={null}
				selectedMemory={null}
				selectedMemoryUsedPct={0}
				selectedRecallToGetPct={0}
				selectedSuggestHitPct={0}
				selectedTotalSessions={0}
			/>,
		);
		const s = lastFrame() ?? "";
		expect(s).toContain("999 calls");
		expect(s).toContain("p50 88ms");
	});

	it("Storage panel stays cross-project aggregate regardless of selection", () => {
		const { lastFrame } = render(
			<Overview
				{...baseProps}
				storage={{ aaaaaaaaaaaaaaaa: 18_000_000, bbbbbbbbbbbbbbbb: 7_500_000 }}
				projectNames={{ aaaaaaaaaaaaaaaa: "ai-cortex", bbbbbbbbbbbbbbbb: "ai-whisper" }}
				selectedRepoKey="aaaaaaaaaaaaaaaa"
				selectedName="ai-cortex"
				selectedAggregate={selectedAggregate}
				selectedMemory={selectedMemory}
				selectedMemoryUsedPct={40}
				selectedRecallToGetPct={20}
				selectedSuggestHitPct={55}
				selectedTotalSessions={6}
			/>,
		);
		const s = lastFrame() ?? "";
		expect(s).toContain("ai-whisper");
		expect(s).toMatch(/7\.5 MB/);
	});
});

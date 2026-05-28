import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Overview } from "../../../src/tui/overview/Overview.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");

describe("Overview", () => {
	it("renders project list with call counts and aggregate widgets", () => {
		const { lastFrame } = render(
			<Overview
				window="7d"
				projects={[
					{ repoKey: "ai-cortex", name: "ai-cortex", calls: 1247 },
					{ repoKey: "ai-whisper", name: "ai-whisper", calls: 842 },
				]}
				aggregate={{
					total: 2089,
					errs: 9,
					p50: 42,
					p95: 210,
					cache_status: { fresh: 1400, reindexed: 600, stale: 89 },
				}}
				memory={{ active: 247, candidate: 62, pinned: 1, deprecated: 4, topAccessed: [] }}
				storage={{ "ai-cortex": 18_000_000, "ai-whisper": 11_000_000 }}
				projectNames={{ "ai-cortex": "ai-cortex", "ai-whisper": "ai-whisper" }}
				memoryUsedPct={72}
				recallToGetPct={73}
				suggestHitPct={61}
				totalSessions={11}
				selectedRepoKey={null}
				selectedName={null}
				selectedAggregate={null}
				selectedMemory={null}
				selectedMemoryUsedPct={0}
				selectedRecallToGetPct={0}
				selectedSuggestHitPct={0}
				selectedTotalSessions={0}
				selected={0}
				onSelect={() => {}}
			/>,
		);
		const frame = strip(lastFrame());
		expect(frame).toContain("ai-cortex");
		expect(frame).toContain("ai-whisper");
		expect(frame).toContain("2089");
		expect(frame).toContain("247 active");
		expect(frame).toMatch(/18 MB|18.0 MB/);
	});

	it("shows empty state when no projects", () => {
		const { lastFrame } = render(
			<Overview
				window="7d"
				projects={[]}
				aggregate={{
					total: 0,
					errs: 0,
					p50: 0,
					p95: 0,
					cache_status: { fresh: 0, reindexed: 0, stale: 0 },
				}}
				memory={{ active: 0, candidate: 0, pinned: 0, deprecated: 0, topAccessed: [] }}
				storage={{}}
				projectNames={{}}
				memoryUsedPct={0}
				recallToGetPct={0}
				suggestHitPct={0}
				totalSessions={0}
				selectedRepoKey={null}
				selectedName={null}
				selectedAggregate={null}
				selectedMemory={null}
				selectedMemoryUsedPct={0}
				selectedRecallToGetPct={0}
				selectedSuggestHitPct={0}
				selectedTotalSessions={0}
				selected={0}
				onSelect={() => {}}
			/>,
		);
		expect(strip(lastFrame())).toContain("No calls in this window yet");
	});
});

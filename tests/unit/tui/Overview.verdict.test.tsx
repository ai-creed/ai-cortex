import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Overview } from "../../../src/tui/overview/Overview.js";
import type { Aggregate, MemoryHealth } from "../../../src/lib/stats/query.js";

const aggregate: Aggregate = {
	total: 321, errs: 10, p50: 41, p95: 374,
	cache_status: { fresh: 100, reindexed: 50, stale: 0 },
};
const memory: MemoryHealth = { active: 0, candidate: 0, pinned: 0, deprecated: 0, topAccessed: [] };

describe("Overview renders VerdictBand on top", () => {
	it("VerdictBand appears above the projects/panels block", () => {
		const { lastFrame } = render(
			<Overview
				window="7d"
				projects={[{ repoKey: "aaaaaaaaaaaaaaaa", name: "ai-cortex", calls: 321 }]}
				aggregate={aggregate}
				memory={memory}
				storage={{}}
				projectNames={{ aaaaaaaaaaaaaaaa: "ai-cortex" }}
				memoryUsedPct={72}
				recallToGetPct={72}
				suggestHitPct={61}
				totalSessions={11}
				selected={0}
				onSelect={() => {}}
				interactive={false}
			/>,
		);
		const s = lastFrame() ?? "";
		const verdictIdx = s.indexOf("Is ai-cortex helping?");
		const effIdx = s.indexOf("Effectiveness");
		expect(verdictIdx).toBeGreaterThanOrEqual(0);
		expect(effIdx).toBeGreaterThan(verdictIdx);
	});
});

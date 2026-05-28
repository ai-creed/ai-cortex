import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { AggregatePanels } from "../../../src/tui/overview/AggregatePanels.js";

const aggregate = {
	total: 321, errs: 10, p50: 41, p95: 374,
	cache_status: { fresh: 100, reindexed: 50, stale: 0 },
};
const memory = {
	active: 72, candidate: 139, pinned: 1, deprecated: 231,
	topAccessed: [], recallToGet: 0.72,
} as any;

describe("AggregatePanels recompose", () => {
	it("renders Effectiveness first and Activity second in row 1", () => {
		const { lastFrame } = render(
			<AggregatePanels
				aggregate={aggregate as any}
				memory={memory}
				storage={{ aaaaaaaaaaaaaaaa: 18_000_000 }}
				projectNames={{ aaaaaaaaaaaaaaaa: "ai-cortex" }}
				memoryUsedPct={72}
				recallToGetPct={72}
				suggestHitPct={61}
			/>,
		);
		const s = lastFrame() ?? "";
		const effIdx = s.indexOf("Effectiveness");
		const actIdx = s.indexOf("Activity");
		expect(effIdx).toBeGreaterThanOrEqual(0);
		expect(actIdx).toBeGreaterThan(effIdx);
	});

	it("Memory panel does not duplicate recall→get from Effectiveness", () => {
		const { lastFrame } = render(
			<AggregatePanels
				aggregate={aggregate as any}
				memory={memory}
				storage={{}}
				projectNames={{}}
				memoryUsedPct={72}
				recallToGetPct={72}
				suggestHitPct={61}
			/>,
		);
		const s = lastFrame() ?? "";
		const occurrences = s.split("recall→get").length - 1;
		expect(occurrences).toBe(1);
	});

	it("removes the Cache mix panel from the overview grid", () => {
		const { lastFrame } = render(
			<AggregatePanels
				aggregate={aggregate as any}
				memory={memory}
				storage={{}}
				projectNames={{}}
				memoryUsedPct={72}
				recallToGetPct={72}
				suggestHitPct={61}
			/>,
		);
		expect(lastFrame()).not.toContain("Cache mix");
	});
});

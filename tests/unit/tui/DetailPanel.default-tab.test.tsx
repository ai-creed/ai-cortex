import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { DetailPanel, type Detail } from "../../../src/tui/detail/DetailPanel.js";
import { EMPTY_ADOPTION } from "../../../src/lib/stats/sessions.js";

const detail: Detail = {
	repoKey: "aaaaaaaaaaaaaaaa",
	aggregate: { total: 0, errs: 0, p50: 0, p95: 0, cache_status: { fresh: 0, reindexed: 0, stale: 0 } },
	latencyPerTool: {},
	topTools: [],
	memory: { active: 0, candidate: 0, pinned: 0, deprecated: 0, topAccessed: [] },
	storage: {},
	meta: { indexedAt: null, fingerprint: null, fileCount: null, name: "ai-cortex", worktreePath: null },
	adoption: EMPTY_ADOPTION,
	suggestHit: 0,
};

describe("DetailPanel tab reorder + default", () => {
	it("opens on Effectiveness", () => {
		const { lastFrame } = render(<DetailPanel detail={detail} interactive={false} />);
		const s = lastFrame() ?? "";
		expect(s).toContain("[ Effectiveness*");
	});

	it("renders tabs in the new order with Effectiveness first", () => {
		const { lastFrame } = render(<DetailPanel detail={detail} interactive={false} />);
		const s = lastFrame() ?? "";
		const order = ["Effectiveness", "Tools", "Memory", "Suggest", "Storage"];
		let cursor = -1;
		for (const t of order) {
			const i = s.indexOf(t, cursor + 1);
			expect(i, `expected ${t} after position ${cursor}`).toBeGreaterThan(cursor);
			cursor = i;
		}
	});

	it("does not expose a Sessions tab anymore", () => {
		const { lastFrame } = render(<DetailPanel detail={detail} interactive={false} />);
		expect(lastFrame()).not.toContain("[ Sessions");
	});
});

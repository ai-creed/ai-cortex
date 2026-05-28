import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { DetailPanel } from "../../../src/tui/detail/DetailPanel.js";
import { EMPTY_ADOPTION } from "../../../src/lib/stats/sessions.js";

const detail = {
	repoKey: "aaaaaaaaaaaaaaaa",
	aggregate: { total: 0, errs: 0, p50: 0, p95: 0, cache_status: { fresh: 0, reindexed: 0, stale: 0 } } as any,
	latencyPerTool: {},
	topTools: [],
	memory: { active: 0, candidate: 0, pinned: 0, deprecated: 0, topAccessed: [], recallToGet: 0 } as any,
	storage: {},
	meta: { indexedAt: null, fingerprint: null, fileCount: null, name: "ai-cortex" } as any,
	adoption: EMPTY_ADOPTION,
};

describe("DetailPanel tab reorder + default", () => {
	it("opens on Effectiveness", () => {
		const { lastFrame } = render(<DetailPanel detail={detail as any} interactive={false} />);
		const s = lastFrame() ?? "";
		expect(s).toContain("[ Effectiveness*");
	});

	it("renders tabs in the new order with Effectiveness first", () => {
		const { lastFrame } = render(<DetailPanel detail={detail as any} interactive={false} />);
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
		const { lastFrame } = render(<DetailPanel detail={detail as any} interactive={false} />);
		expect(lastFrame()).not.toContain("[ Sessions");
	});
});

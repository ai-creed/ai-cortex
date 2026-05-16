import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { ToolsTab } from "../../../src/tui/detail/ToolsTab.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");

const aggregate = {
	total: 26,
	errs: 1,
	p50: 0,
	p95: 0,
	cache_status: { fresh: 2, reindexed: 1, stale: 0 },
};

describe("ToolsTab", () => {
	it("renders a column header row", () => {
		const { lastFrame } = render(
			<ToolsTab
				aggregate={aggregate}
				latencyPerTool={{ recall_memory: { p50: 0, p95: 0, samples: 24 } }}
				topTools={[{ tool: "recall_memory", n: 24, errs: 0 }]}
			/>,
		);
		const frame = strip(lastFrame());
		expect(frame).toContain("TOOL");
		expect(frame).toContain("p50");
		expect(frame).toContain("p95");
		expect(frame).toContain("CALLS");
		expect(frame).toContain("ERR");
	});

	it("renders per-tool rows with aligned values", () => {
		const { lastFrame } = render(
			<ToolsTab
				aggregate={aggregate}
				latencyPerTool={{
					suggest_files: { p50: 38, p95: 187, samples: 3 },
				}}
				topTools={[{ tool: "suggest_files", n: 3, errs: 2 }]}
			/>,
		);
		const frame = strip(lastFrame());
		expect(frame).toContain("suggest_files");
		expect(frame).toContain("38");
		expect(frame).toContain("187");
		// volume and error count both present
		expect(frame).toMatch(/suggest_files\s+38\s+187\s+3\s+2/);
	});

	it("renders the legend explaining the columns", () => {
		const { lastFrame } = render(
			<ToolsTab
				aggregate={aggregate}
				latencyPerTool={{}}
				topTools={[{ tool: "recall_memory", n: 24, errs: 0 }]}
			/>,
		);
		const frame = strip(lastFrame());
		expect(frame).toContain("median & 95th-pct latency");
		expect(frame).toContain("backfilled history has no timing");
		expect(frame).toContain("invocations in the selected window");
	});

	it("renders the cache results line", () => {
		const { lastFrame } = render(
			<ToolsTab
				aggregate={aggregate}
				latencyPerTool={{}}
				topTools={[{ tool: "recall_memory", n: 24, errs: 0 }]}
			/>,
		);
		const frame = strip(lastFrame());
		expect(frame).toContain("Cache results");
		expect(frame).toContain("fresh 2");
		expect(frame).toContain("stale 0");
	});

	it("shows empty state when no tools", () => {
		const { lastFrame } = render(
			<ToolsTab aggregate={aggregate} latencyPerTool={{}} topTools={[]} />,
		);
		expect(strip(lastFrame())).toContain("No tool data yet.");
	});
});

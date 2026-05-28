import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { ActivityPanel } from "../../../src/tui/overview/ActivityPanel.js";

describe("ActivityPanel", () => {
	it("renders calls, latency, and explicit error framing", () => {
		const { lastFrame } = render(
			<ActivityPanel total={321} p50={41} p95={374} errs={10} />,
		);
		const s = lastFrame() ?? "";
		expect(s).toContain("Activity");
		expect(s).toContain("321 calls");
		expect(s).toContain("p50 41ms");
		expect(s).toContain("p95 374ms");
		expect(s).toContain("err 3.1%");
		expect(s).toContain("(10 of 321)");
	});
});

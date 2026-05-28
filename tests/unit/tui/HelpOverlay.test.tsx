import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { HelpOverlay } from "../../../src/tui/components/HelpOverlay.js";
import { THRESHOLD_TEXT } from "../../../src/lib/stats/verdict.js";

describe("HelpOverlay", () => {
	it("renders every documented metric label", () => {
		const { lastFrame } = render(<HelpOverlay />);
		const s = lastFrame() ?? "";
		expect(s).toContain("What these numbers mean");
		for (const label of ["memory used %", "recall→get %", "suggest hit %", "p50 / p95", "cache mix"]) {
			expect(s).toContain(label);
		}
	});

	it("renders the threshold string from verdict.ts verbatim for each metric", () => {
		const { lastFrame } = render(<HelpOverlay />);
		const s = lastFrame() ?? "";
		expect(s).toContain(THRESHOLD_TEXT.memoryUsed);
		expect(s).toContain(THRESHOLD_TEXT.recallToGet);
		expect(s).toContain(THRESHOLD_TEXT.suggestHit);
		expect(s).toContain(THRESHOLD_TEXT.p50);
		expect(s).toContain(THRESHOLD_TEXT.p95);
		expect(s).toContain(THRESHOLD_TEXT.cacheMix);
	});

	it("renders the verdict legend with all three dots", () => {
		const { lastFrame } = render(<HelpOverlay />);
		const s = lastFrame() ?? "";
		expect(s).toContain("● helping");
		expect(s).toContain("◐ mixed");
		expect(s).toContain("○ too little data yet");
	});

	it("shows the dismiss hint", () => {
		const { lastFrame } = render(<HelpOverlay />);
		expect(lastFrame()).toContain("press ? or Esc to close");
	});
});

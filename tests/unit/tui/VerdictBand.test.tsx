import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { VerdictBand } from "../../../src/tui/overview/VerdictBand.js";

describe("VerdictBand", () => {
	it("renders the green verdict text and the 4-metric strip", () => {
		const { lastFrame } = render(
			<VerdictBand
				title="Is ai-cortex helping?"
				memoryUsedPct={72}
				recallToGetPct={72}
				suggestHitPct={61}
				errPct={3.2}
				totalSessions={11}
				totalCalls={321}
			/>,
		);
		const s = lastFrame() ?? "";
		expect(s).toContain("Is ai-cortex helping?");
		expect(s).toContain("YES — saved memories get used in most sessions");
		expect(s).toContain("memory used 72%");
		expect(s).toContain("recall→get 72%");
		expect(s).toContain("suggest hit 61%");
		expect(s).toContain("err 3.2%");
	});

	it("renders muted verdict on low data", () => {
		const { lastFrame } = render(
			<VerdictBand title="Is ai-cortex helping?" memoryUsedPct={0} recallToGetPct={0} suggestHitPct={0} errPct={0} totalSessions={1} totalCalls={3} />,
		);
		expect(lastFrame()).toContain("too little data yet to tell");
	});

	it("renders mixed verdict naming error rate when err% >= 5", () => {
		const { lastFrame } = render(
			<VerdictBand title="Is ai-cortex helping?" memoryUsedPct={72} recallToGetPct={72} suggestHitPct={61} errPct={5.6} totalSessions={11} totalCalls={321} />,
		);
		expect(lastFrame()).toContain("mixed — error rate is high");
	});

	it("renders the `title` prop verbatim (parameterized title)", () => {
		const { lastFrame } = render(
			<VerdictBand
				title="ai-cortex (this project)"
				memoryUsedPct={72}
				recallToGetPct={72}
				suggestHitPct={61}
				errPct={3.2}
				totalSessions={11}
				totalCalls={321}
			/>,
		);
		expect(lastFrame()).toContain("ai-cortex (this project)");
		expect(lastFrame()).not.toContain("Is ai-cortex helping?");
	});
});

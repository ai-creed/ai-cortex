import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { EffectivenessPanel } from "../../../src/tui/overview/EffectivenessPanel.js";

describe("EffectivenessPanel", () => {
	it("renders the three adoption rows", () => {
		const { lastFrame } = render(
			<EffectivenessPanel memoryUsedPct={72} recallToGetPct={72} suggestHitPct={61} />,
		);
		const s = lastFrame() ?? "";
		expect(s).toContain("Effectiveness");
		expect(s).toContain("memory used");
		expect(s).toContain("72%");
		expect(s).toContain("recall→get");
		expect(s).toContain("suggest hit");
		expect(s).toContain("61%");
	});
});

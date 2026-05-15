import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Sparkline } from "../../../src/tui/components/Sparkline.js";

describe("Sparkline", () => {
	it("renders an empty placeholder for empty input", () => {
		const { lastFrame } = render(<Sparkline values={[]} width={5} />);
		expect(lastFrame()).toBe("·····");
	});

	it("normalizes values to unicode block heights", () => {
		const { lastFrame } = render(<Sparkline values={[0, 1, 2, 3, 4, 5, 6, 7]} width={8} />);
		const frame = lastFrame() ?? "";
		expect(frame).toHaveLength(8);
		expect(frame[0]).toBe("▁");
		expect(frame[7]).toBe("█");
	});

	it("clamps to requested width by sampling/aggregating", () => {
		const { lastFrame } = render(
			<Sparkline values={Array.from({ length: 50 }, (_, i) => i)} width={10} />,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toHaveLength(10);
	});
});

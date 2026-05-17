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

	it("applies the color prop without dropping bars", () => {
		const { lastFrame } = render(
			<Sparkline values={[0, 1, 2, 3, 4, 5, 6, 7]} width={8} color="green" />,
		);
		// ANSI strip is intentional: box/bar chars are not ANSI, so the visible
		// bar count must be unchanged even with color applied.
		// eslint-disable-next-line no-control-regex
		const visible = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
		expect(visible).toHaveLength(8);
		expect(visible[0]).toBe("▁");
		expect(visible[7]).toBe("█");
	});

	it("applies the color prop to the empty placeholder", () => {
		const { lastFrame } = render(
			<Sparkline values={[]} width={5} color="green" />,
		);
		// eslint-disable-next-line no-control-regex
		const visible = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
		expect(visible).toBe("·····");
	});
});

// tests/unit/tui/MemoryActivityStrip.test.tsx
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { MemoryActivityStrip } from "../../../src/tui/memory/MemoryActivityStrip.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");

describe("MemoryActivityStrip", () => {
	it("renders rec and use rows with totals", () => {
		const { lastFrame } = render(
			<MemoryActivityStrip
				recorded={[0, 1, 2, 3]}
				used={[1, 0, 0, 2]}
				recordedTotal={6}
				usedTotal={3}
			/>,
		);
		const f = strip(lastFrame());
		expect(f).toContain("rec");
		expect(f).toContain("6");
		expect(f).toContain("use");
		expect(f).toContain("3");
	});

	it("renders all-zero series without crashing", () => {
		const { lastFrame } = render(
			<MemoryActivityStrip
				recorded={[0, 0, 0]}
				used={[0, 0, 0]}
				recordedTotal={0}
				usedTotal={0}
			/>,
		);
		expect(strip(lastFrame())).toContain("rec");
	});
});

import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { MemoryTab } from "../../../src/tui/detail/MemoryTab.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");

const memory = {
	active: 1,
	candidate: 205,
	pinned: 1,
	deprecated: 0,
	topAccessed: [
		{ id: "mem-a", get_count: 14, last_accessed_at: "2026-05-02" },
	],
};

const fakeActivity = () => ({
	recorded: [1, 2, 3, 4],
	used: [0, 1, 0, 2],
	recordedTotal: 10,
	usedTotal: 3,
	buckets: 30,
});

describe("MemoryTab", () => {
	it("renders counts, both sparklines with totals, and top-accessed", () => {
		const { lastFrame } = render(
			<MemoryTab
				memory={memory}
				repoKey="rk"
				window="7d"
				activityFn={fakeActivity}
			/>,
		);
		const f = strip(lastFrame());
		expect(f).toContain("active 1");
		expect(f).toContain("candidate 205");
		expect(f).toContain("recorded");
		expect(f).toContain("10");
		expect(f).toContain("used");
		expect(f).toContain("3");
		expect(f).toContain("mem-a");
	});

	it("renders an empty state when there are no memories and no activity", () => {
		const { lastFrame } = render(
			<MemoryTab
				memory={{ active: 0, candidate: 0, pinned: 0, deprecated: 0, topAccessed: [] }}
				repoKey="rk"
				window="7d"
				activityFn={() => ({ recorded: [0], used: [0], recordedTotal: 0, usedTotal: 0, buckets: 30 })}
			/>,
		);
		expect(strip(lastFrame())).toContain("No memory data yet");
	});
});

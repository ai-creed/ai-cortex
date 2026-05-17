// tests/unit/tui/MemoryList.test.tsx
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { MemoryList } from "../../../src/tui/memory/MemoryList.js";
import type { MemoryListGroups } from "../../../src/lib/stats/memory-browser.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");

const groups: MemoryListGroups = {
	error: null,
	groups: [
		{
			status: "active",
			count: 1,
			items: [
				{ id: "a", type: "decision", status: "active", title: "Never writes", updatedAt: "2026-05-10", pinned: true },
			],
		},
		{ status: "candidate", count: 0, items: [] },
		{
			status: "deprecated",
			count: 1,
			items: [
				{ id: "z", type: "user", status: "deprecated", title: "Old pref", updatedAt: "2026-04-01", pinned: false },
			],
		},
	],
};

const WIDTH = 40;

describe("MemoryList", () => {
	it("shows all three status headers with counts including (0)", () => {
		const { lastFrame } = render(
			<MemoryList groups={groups} selectedId="a" viewportRows={20} width={WIDTH} />,
		);
		const f = strip(lastFrame());
		expect(f).toMatch(/ACTIVE \(1\)/);
		expect(f).toMatch(/CANDIDATE \(0\)/);
		expect(f).toMatch(/DEPRECATED \(1\)/);
	});

	it("renders rows with type tag + title and the selected marker ▸", () => {
		const { lastFrame } = render(
			<MemoryList groups={groups} selectedId="a" viewportRows={20} width={WIDTH} />,
		);
		const f = strip(lastFrame());
		// 'a' is selected → it shows the ▸ marker (not the 📌 pin)
		expect(f).toContain("▸");
		expect(f).toContain("[decision]");
		expect(f).toContain("Never writes");
		expect(f).toContain("[user]");
	});

	it("shows the 📌 pin marker on a pinned, non-selected row", () => {
		const { lastFrame } = render(
			// select the unpinned 'z' so the pinned 'a' shows its pin marker
			<MemoryList groups={groups} selectedId="z" viewportRows={20} width={WIDTH} />,
		);
		expect(strip(lastFrame())).toContain("📌");
	});

	it("hard-truncates a long title to the given width with an ellipsis", () => {
		const long: MemoryListGroups = {
			error: null,
			groups: [
				{
					status: "active",
					count: 1,
					items: [
						{
							id: "a",
							type: "decision",
							status: "active",
							title:
								"This is an extremely long memory title that must be cut",
							updatedAt: "2026-05-10",
							pinned: false,
						},
					],
				},
			],
		};
		const { lastFrame } = render(
			<MemoryList groups={long} selectedId={null} viewportRows={20} width={30} />,
		);
		const f = strip(lastFrame());
		expect(f).toContain("…");
		// the overflowing tail of the title is dropped
		expect(f).not.toContain("must be cut");
		// the visible (truncated) title prefix is still present
		expect(f).toContain("This is an");
	});

	it("shows the error line when groups.error is set", () => {
		const { lastFrame } = render(
			<MemoryList
				groups={{ ...groups, error: "boom" }}
				selectedId={null}
				viewportRows={20}
				width={WIDTH}
			/>,
		);
		expect(strip(lastFrame())).toContain("⚠ memory index unavailable");
	});
});

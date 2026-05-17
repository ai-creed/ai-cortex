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

describe("MemoryList", () => {
	it("shows all three status headers with counts including (0)", () => {
		const { lastFrame } = render(
			<MemoryList groups={groups} selectedId="a" viewportRows={20} />,
		);
		const f = strip(lastFrame());
		expect(f).toMatch(/ACTIVE \(1\)/);
		expect(f).toMatch(/CANDIDATE \(0\)/);
		expect(f).toMatch(/DEPRECATED \(1\)/);
	});

	it("renders rows with pin marker + type tag + title", () => {
		const { lastFrame } = render(
			<MemoryList groups={groups} selectedId="a" viewportRows={20} />,
		);
		const f = strip(lastFrame());
		expect(f).toContain("📌");
		expect(f).toContain("[decision]");
		expect(f).toContain("Never writes");
		expect(f).toContain("[user]");
	});

	it("shows the error line when groups.error is set", () => {
		const { lastFrame } = render(
			<MemoryList
				groups={{ ...groups, error: "boom" }}
				selectedId={null}
				viewportRows={20}
			/>,
		);
		expect(strip(lastFrame())).toContain("⚠ memory index unavailable");
	});
});

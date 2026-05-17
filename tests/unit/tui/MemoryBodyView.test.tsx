// tests/unit/tui/MemoryBodyView.test.tsx
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { MemoryBodyView } from "../../../src/tui/memory/MemoryBodyView.js";
import type { MemoryRecord } from "../../../src/lib/stats/memory-browser.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");

const rec = {
	frontmatter: {
		id: "a",
		type: "decision",
		status: "active",
		title: "Never writes into target repo",
		version: 2,
		createdAt: "2026-05-02T00:00:00.000Z",
		updatedAt: "2026-05-02T00:00:00.000Z",
		source: "explicit",
		confidence: 1,
		pinned: true,
		scope: { files: [], tags: ["safety"] },
		provenance: [],
		supersedes: [],
		mergedInto: null,
		deprecationReason: null,
		promotedFrom: [],
		rewrittenAt: null,
	},
	body: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"),
} as unknown as MemoryRecord;

describe("MemoryBodyView", () => {
	it("renders the metadata header fields", () => {
		const { lastFrame } = render(
			<MemoryBodyView record={rec} error={null} scroll={0} viewportLines={10} />,
		);
		const f = strip(lastFrame());
		expect(f).toContain("decision");
		expect(f).toContain("active");
		expect(f).toContain("pinned");
		expect(f).toContain("2026-05-02");
		expect(f).toContain("safety");
	});

	it("shows ↓ more when the body overflows the viewport", () => {
		const { lastFrame } = render(
			<MemoryBodyView record={rec} error={null} scroll={0} viewportLines={5} />,
		);
		expect(strip(lastFrame())).toContain("↓ more");
	});

	it("scrolls — later lines visible at a scroll offset", () => {
		const { lastFrame } = render(
			<MemoryBodyView record={rec} error={null} scroll={30} viewportLines={5} />,
		);
		expect(strip(lastFrame())).toContain("line 31");
	});

	it("renders the error state", () => {
		const { lastFrame } = render(
			<MemoryBodyView record={null} error="body unavailable (a)" scroll={0} viewportLines={5} />,
		);
		expect(strip(lastFrame())).toContain("⚠ body unavailable (a)");
	});

	it("renders an empty hint when no record and no error", () => {
		const { lastFrame } = render(
			<MemoryBodyView record={null} error={null} scroll={0} viewportLines={5} />,
		);
		expect(strip(lastFrame())).toContain("No memory selected");
	});
});

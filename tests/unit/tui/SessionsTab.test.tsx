import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { SessionsTab } from "../../../src/tui/detail/SessionsTab.js";
import { EMPTY_ADOPTION } from "../../../src/lib/stats/sessions.js";
import type { AdoptionSummary, SessionRow } from "../../../src/lib/stats/sessions.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");

describe("SessionsTab", () => {
	it("shows empty state when no data", () => {
		const { lastFrame } = render(
			<SessionsTab adoption={EMPTY_ADOPTION} window="7d" />,
		);
		expect(strip(lastFrame())).toMatch(/memory used/i);
	});

	it("renders session rows when sessions exist", () => {
		const session: SessionRow = {
			sessionId: "S1",
			firstTs: 1000,
			lastTs: 2000,
			totalCalls: 2,
			recall: 1,
			get: 1,
			record: 0,
			surfacings: 0,
			memoryUsed: true,
		};
		const summary: AdoptionSummary = {
			sessionCount: 1,
			memoryUsedPct: 100,
			recallToGetPct: 100,
			surfaceToGetPct: 0,
			extractCleanupPct: 0,
			unattributedShare: 0,
			histogram: { used: 1, notUsed: 0 },
		};
		const { lastFrame } = render(
			<SessionsTab adoption={{ sessions: [session], summary }} window="7d" />,
		);
		const frame = strip(lastFrame());
		expect(frame).toContain("S1");
		expect(frame).toContain("USED");
	});
});

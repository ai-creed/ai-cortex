import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { KeyBar } from "../../../src/tui/components/KeyBar.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");

describe("KeyBar", () => {
	it("renders space-separated [k]label hints", () => {
		const { lastFrame } = render(
			<KeyBar
				hints={[
					["q", "quit"],
					["r", "refresh"],
				]}
			/>,
		);
		expect(strip(lastFrame())).toContain("[q]quit");
		expect(strip(lastFrame())).toContain("[r]refresh");
	});
});

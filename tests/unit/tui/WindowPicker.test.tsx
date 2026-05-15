import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { WindowPicker } from "../../../src/tui/components/WindowPicker.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");

describe("WindowPicker", () => {
	it("renders 1h/24h/7d/30d with current marked", () => {
		const { lastFrame } = render(<WindowPicker current="7d" onSelect={() => {}} />);
		const frame = strip(lastFrame());
		expect(frame).toContain("1h");
		expect(frame).toContain("24h");
		expect(frame).toContain("7d");
		expect(frame).toContain("30d");
		expect(frame).toMatch(/▸\s*\[3\] 7d/);
	});

	it("calls onSelect when a number key is pressed", () => {
		const onSelect = vi.fn();
		const { stdin } = render(<WindowPicker current="7d" onSelect={onSelect} />);
		stdin.write("2");
		expect(onSelect).toHaveBeenCalledWith("24h");
	});
});

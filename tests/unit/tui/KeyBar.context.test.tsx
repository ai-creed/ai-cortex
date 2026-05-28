import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { KeyBar } from "../../../src/tui/components/KeyBar.js";

describe("KeyBar context-aware hygiene line", () => {
	it("hides the hygiene line when no selection", () => {
		const { lastFrame } = render(
			<KeyBar hints={[["q","uit"]]} selectedLabel={null} />,
		);
		const s = lastFrame() ?? "";
		expect(s).not.toContain("exclude");
		expect(s).not.toContain("archive");
		expect(s).not.toContain("clean");
	});

	it("shows e/a/x hints when a project is selected", () => {
		const { lastFrame } = render(
			<KeyBar hints={[["q","uit"]]} selectedLabel="ai-whisper" />,
		);
		const s = lastFrame() ?? "";
		expect(s).toContain("selected:");
		expect(s).toContain("ai-whisper");
		expect(s).toContain("exclude");
		expect(s).toContain("archive");
		expect(s).toContain("clean");
	});
});

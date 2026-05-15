import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { TopList } from "../../../src/tui/components/TopList.js";

describe("TopList", () => {
	it("renders rows aligned in two columns", () => {
		const { lastFrame } = render(
			<TopList items={[["suggest_files", "1,247"], ["recall_memory", "412"]]} />,
		);
		const frame = lastFrame() ?? "";
		const lines = frame.split("\n");
		expect(lines[0]).toMatch(/^suggest_files\s+1,247$/);
		expect(lines[1]).toMatch(/^recall_memory\s+412$/);
	});

	it("renders an empty hint when items is empty", () => {
		const { lastFrame } = render(<TopList items={[]} empty="no data" />);
		expect(lastFrame()).toBe("no data");
	});
});

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { Toast } from "../../../src/tui/components/Toast.js";

describe("Toast", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it("renders nothing when message is null", () => {
		const { lastFrame } = render(<Toast message={null} onDismiss={() => {}} />);
		expect(lastFrame()).toBe("");
	});

	it("renders the message when present", () => {
		const { lastFrame } = render(
			<Toast message="✓ excluded aaaa — hidden" onDismiss={() => {}} />,
		);
		expect(lastFrame()).toContain("excluded aaaa");
	});

	it("calls onDismiss after 3 seconds", () => {
		const onDismiss = vi.fn();
		render(<Toast message="x" onDismiss={onDismiss} />);
		vi.advanceTimersByTime(2999);
		expect(onDismiss).not.toHaveBeenCalled();
		vi.advanceTimersByTime(2);
		expect(onDismiss).toHaveBeenCalledOnce();
	});
});

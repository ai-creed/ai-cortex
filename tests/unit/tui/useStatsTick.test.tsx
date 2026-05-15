import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useStatsTick } from "../../../src/tui/hooks/useStatsTick.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function Probe({ fn }: { fn: () => number }) {
	const { data } = useStatsTick(fn, 100);
	return <Text>n={data ?? "x"}</Text>;
}

describe("useStatsTick", () => {
	it("invokes fn initially and on each interval", async () => {
		let n = 0;
		const fn = vi.fn(() => ++n);
		const { lastFrame } = render(<Probe fn={fn} />);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(lastFrame()).toContain("n=1");
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(0);
		expect(lastFrame()).toContain("n=2");
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(0);
		expect(lastFrame()).toContain("n=3");
	});

	it("skips a tick if previous call still pending", async () => {
		const resolves: Array<() => void> = [];
		const fn = vi.fn(
			() =>
				new Promise<number>((r) => {
					resolves.push(() => r(resolves.length));
				}),
		);
		render(<Probe fn={fn as unknown as () => number} />);
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);
		expect(fn).toHaveBeenCalledTimes(1);
	});
});

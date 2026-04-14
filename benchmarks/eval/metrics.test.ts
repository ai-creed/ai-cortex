// benchmarks/eval/metrics.test.ts
import { describe, it, expect } from "vitest";
import { parseStreamJson } from "./metrics.js";

const TOOL_READ = JSON.stringify({
	type: "assistant",
	message: { content: [{ type: "tool_use", name: "Read", id: "1", input: {} }] },
});
const TOOL_GREP = JSON.stringify({
	type: "assistant",
	message: { content: [{ type: "tool_use", name: "Grep", id: "2", input: {} }] },
});
const TOOL_EDIT = JSON.stringify({
	type: "assistant",
	message: { content: [{ type: "tool_use", name: "Edit", id: "3", input: {} }] },
});
const TOOL_WRITE = JSON.stringify({
	type: "assistant",
	message: { content: [{ type: "tool_use", name: "Write", id: "4", input: {} }] },
});
const TOOL_BASH = JSON.stringify({
	type: "assistant",
	message: { content: [{ type: "tool_use", name: "Bash", id: "5", input: {} }] },
});
const TEXT_BLOCK = JSON.stringify({
	type: "assistant",
	message: { content: [{ type: "text", text: "hello" }] },
});
const RESULT_LINE = JSON.stringify({
	type: "result",
	num_turns: 5,
	duration_ms: 12345,
});

describe("parseStreamJson", () => {
	it("counts exploration calls before first edit", () => {
		const output = [TOOL_READ, TOOL_GREP, TOOL_BASH, TOOL_EDIT, TOOL_READ].join("\n");
		const metrics = parseStreamJson(output);
		expect(metrics.explorationCalls).toBe(3);
		expect(metrics.totalToolCalls).toBe(5);
	});

	it("counts all calls as exploration when no edits", () => {
		const output = [TOOL_READ, TOOL_GREP, TOOL_READ, RESULT_LINE].join("\n");
		const metrics = parseStreamJson(output);
		expect(metrics.explorationCalls).toBe(3);
		expect(metrics.totalToolCalls).toBe(3);
	});

	it("handles Write as first mutation tool", () => {
		const output = [TOOL_READ, TOOL_WRITE, TOOL_READ].join("\n");
		const metrics = parseStreamJson(output);
		expect(metrics.explorationCalls).toBe(1);
		expect(metrics.totalToolCalls).toBe(3);
	});

	it("ignores text blocks and unknown types", () => {
		const output = [TEXT_BLOCK, TOOL_READ, TEXT_BLOCK, TOOL_EDIT].join("\n");
		const metrics = parseStreamJson(output);
		expect(metrics.explorationCalls).toBe(1);
		expect(metrics.totalToolCalls).toBe(2);
	});

	it("extracts duration from result line", () => {
		const output = [TOOL_READ, RESULT_LINE].join("\n");
		const metrics = parseStreamJson(output);
		expect(metrics.durationMs).toBe(12345);
	});

	it("returns 0 for empty output", () => {
		const metrics = parseStreamJson("");
		expect(metrics.explorationCalls).toBe(0);
		expect(metrics.totalToolCalls).toBe(0);
		expect(metrics.durationMs).toBe(0);
	});
});

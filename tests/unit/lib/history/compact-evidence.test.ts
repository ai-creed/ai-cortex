import { describe, expect, it } from "vitest";
import { extractEvidence } from "../../../../src/lib/history/compact.js";
import type { RawTurn } from "../../../../src/lib/history/types.js";

const turns: RawTurn[] = [
	{ turn: 0, role: "user", text: "please look at src/foo.ts" },
	{
		turn: 1,
		role: "assistant",
		text: "",
		toolUses: [{ name: "Read", input: { file_path: "src/foo.ts" } }],
	},
	{
		turn: 2,
		role: "assistant",
		text: "",
		toolUses: [{ name: "Bash", input: { command: "pnpm vitest run" } }],
	},
	{ turn: 3, role: "user", text: "no, use watch mode instead" },
	{ turn: 4, role: "user", text: "actually we already do that" },
	{ turn: 5, role: "user", text: "fine, ship it" },
];

describe("extractEvidence", () => {
	it("captures user prompts verbatim", () => {
		const e = extractEvidence(turns);
		expect(e.userPrompts.map((u) => u.text)).toEqual([
			"please look at src/foo.ts",
			"no, use watch mode instead",
			"actually we already do that",
			"fine, ship it",
		]);
	});

	it("flags corrections starting with no/stop/dont/wait/actually/instead/but", () => {
		const e = extractEvidence(turns);
		expect(e.corrections.map((c) => c.turn).sort()).toEqual([3, 4]);
	});

	it("does not flag prompts where keyword appears later in sentence", () => {
		const t: RawTurn[] = [{ turn: 0, role: "user", text: "we should not stop here" }];
		expect(extractEvidence(t).corrections).toEqual([]);
	});

	it("captures Read/Write/Edit/Glob/Grep tool calls with path summary", () => {
		const e = extractEvidence(turns);
		expect(e.toolCalls).toContainEqual({ turn: 1, name: "Read", args: "src/foo.ts" });
	});

	it("captures Bash tool calls with first 120 chars of command", () => {
		const e = extractEvidence(turns);
		expect(e.toolCalls).toContainEqual({ turn: 2, name: "Bash", args: "pnpm vitest run" });
	});

	it("extracts file paths from tool inputs", () => {
		const e = extractEvidence(turns);
		expect(e.filePaths).toContainEqual({ turn: 1, path: "src/foo.ts" });
	});
});

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
		const t: RawTurn[] = [
			{ turn: 0, role: "user", text: "we should not stop here" },
		];
		expect(extractEvidence(t).corrections).toEqual([]);
	});

	it("captures Read/Write/Edit/Glob/Grep tool calls with path summary", () => {
		const e = extractEvidence(turns);
		expect(e.toolCalls).toContainEqual({
			turn: 1,
			name: "Read",
			args: "src/foo.ts",
		});
	});

	it("captures Bash tool calls with first 120 chars of command", () => {
		const e = extractEvidence(turns);
		expect(e.toolCalls).toContainEqual({
			turn: 2,
			name: "Bash",
			args: "pnpm vitest run",
		});
	});

	it("extracts file paths from tool inputs", () => {
		const e = extractEvidence(turns);
		expect(e.filePaths).toContainEqual({ turn: 1, path: "src/foo.ts" });
	});

	it("skips harness-injected pseudo-prompts", () => {
		const t: RawTurn[] = [
			{ turn: 0, role: "user", text: "real user question?" },
			{
				turn: 1,
				role: "user",
				text: "Base directory for this skill: /Users/x/.claude/skills/foo\n\n# Foo\n\nMUST always do bar",
			},
			{
				turn: 2,
				role: "user",
				text: "<command-name>/resume</command-name>",
			},
			{
				turn: 3,
				role: "user",
				text: "<system-reminder>\nThe task tools haven't been used\n</system-reminder>",
			},
			{
				turn: 4,
				role: "user",
				text: "<local-command-stdout>No conversations</local-command-stdout>",
			},
			{ turn: 5, role: "user", text: "<bash-input>ls</bash-input>" },
			{ turn: 6, role: "user", text: "another real prompt" },
		];
		const e = extractEvidence(t);
		expect(e.userPrompts.map((u) => u.turn)).toEqual([0, 6]);
		expect(e.corrections).toEqual([]);
	});

	it("skips slash-command output templates and skill-heading injections", () => {
		const t: RawTurn[] = [
			{ turn: 0, role: "user", text: "real prompt" },
			{
				turn: 1,
				role: "user",
				text: "The user just ran /insights to generate a usage report\nHere is the data:\n{...}",
			},
			{
				turn: 2,
				role: "user",
				text: "# Update Config Skill\n\nModify Claude Code configuration by updating settings.json files.",
			},
			{
				turn: 3,
				role: "user",
				text: "# Brainstorming Skill\n\nHelp turn ideas into designs",
			},
			// Negative: ordinary user docs with a Skill word should NOT be filtered
			{
				turn: 4,
				role: "user",
				text: "# How to use the skill panel\n\nClick the skill button.",
			},
		];
		const e = extractEvidence(t);
		expect(e.userPrompts.map((u) => u.turn)).toEqual([0, 4]);
	});

	it("skips harness injection even with leading whitespace", () => {
		const t: RawTurn[] = [
			{
				turn: 0,
				role: "user",
				text: "  \n<system-reminder>noisy</system-reminder>",
			},
		];
		expect(extractEvidence(t).userPrompts).toEqual([]);
	});
});

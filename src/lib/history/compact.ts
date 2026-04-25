import fs from "node:fs";
import type { EvidenceLayer, RawTurn } from "./types.js";

type RawLine = {
	type?: string;
	turn?: number;
	summary?: string;
	message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
};

export function parseTranscript(transcriptPath: string): RawTurn[] {
	const text = fs.readFileSync(transcriptPath, "utf8");
	const out: RawTurn[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) continue;
		let parsed: RawLine;
		try {
			parsed = JSON.parse(line) as RawLine;
		} catch {
			process.stderr.write(`[ai-cortex] history: skipping malformed transcript line\n`);
			continue;
		}
		const turn = toTurn(parsed);
		if (turn) out.push(turn);
	}
	return out;
}

function toTurn(p: RawLine): RawTurn | null {
	if (typeof p.turn !== "number") return null;
	if (p.type === "summary") {
		return { turn: p.turn, role: "system", text: p.summary ?? "", isCompactSummary: true };
	}
	const role: RawTurn["role"] = p.type === "user" ? "user" : p.type === "assistant" ? "assistant" : "system";
	const blocks = p.message?.content ?? [];
	const textParts: string[] = [];
	const toolUses: { name: string; input: unknown }[] = [];
	for (const b of blocks) {
		if (b.type === "text" && typeof b.text === "string") textParts.push(b.text);
		if (b.type === "tool_use" && typeof b.name === "string") toolUses.push({ name: b.name, input: b.input });
	}
	return {
		turn: p.turn,
		role,
		text: textParts.join("\n"),
		toolUses: toolUses.length > 0 ? toolUses : undefined,
	};
}

const CORRECTION_RE = /^\s*(no|stop|don't|dont|wait|actually|instead|but)\b/i;
const PATH_TOOL_KEYS = ["file_path", "path", "pattern"] as const;
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "Glob", "Grep", "MultiEdit", "NotebookEdit"]);

export function extractEvidence(turns: RawTurn[]): EvidenceLayer {
	const userPrompts: EvidenceLayer["userPrompts"] = [];
	const corrections: EvidenceLayer["corrections"] = [];
	const toolCalls: EvidenceLayer["toolCalls"] = [];
	const filePaths: EvidenceLayer["filePaths"] = [];

	for (const t of turns) {
		if (t.role === "user" && t.text.length > 0) {
			userPrompts.push({ turn: t.turn, text: t.text });
			if (CORRECTION_RE.test(t.text)) {
				corrections.push({ turn: t.turn, text: t.text });
			}
		}
		if (!t.toolUses) continue;
		for (const u of t.toolUses) {
			toolCalls.push({ turn: t.turn, name: u.name, args: summarizeToolArgs(u.name, u.input) });
			const p = pathFromToolInput(u.input);
			if (p && FILE_TOOLS.has(u.name)) {
				filePaths.push({ turn: t.turn, path: p });
			}
		}
	}

	return { userPrompts, corrections, toolCalls, filePaths };
}

function summarizeToolArgs(name: string, input: unknown): string {
	if (input === null || typeof input !== "object") return "";
	const obj = input as Record<string, unknown>;
	if (name === "Bash") {
		const cmd = typeof obj.command === "string" ? obj.command : "";
		return cmd.slice(0, 120);
	}
	const p = pathFromToolInput(input);
	return p ?? "";
}

function pathFromToolInput(input: unknown): string | null {
	if (input === null || typeof input !== "object") return null;
	const obj = input as Record<string, unknown>;
	for (const key of PATH_TOOL_KEYS) {
		const v = obj[key];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return null;
}

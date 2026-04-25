import fs from "node:fs";
import type { RawTurn } from "./types.js";

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

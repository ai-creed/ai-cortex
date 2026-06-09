import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTranscript, extractEvidence } from "../../../../src/lib/history/compact.js";

// This transcript is BYTE-FOR-BYTE what ezio's CortexSessionSink/renderCortexLines emits
// (ai-ezio: packages/session-recorder/src/cortex-projection.ts): a user line, then an
// assistant line whose content is [text, tool_use{name,input}…]. The round-trip proves
// cortex's real parser+evidence layer extracts the prompts/tools/paths the recorder needs.
function ezioProjection(): string {
	return (
		[
			JSON.stringify({ type: "user", turn: 0, message: { content: [{ type: "text", text: "analyze auth" }] } }),
			JSON.stringify({
				type: "assistant",
				turn: 1,
				message: {
					content: [
						{ type: "text", text: "reading" },
						{ type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } },
						{ type: "tool_use", name: "bash", input: "grep -n token src/auth.ts" },
					],
				},
			}),
		].join("\n") + "\n"
	);
}

describe("ezio projection → cortex evidence", () => {
	it("extracts user prompts, tool calls, and file paths via the real parser", () => {
		const dir = mkdtempSync(join(tmpdir(), "cortex-ev-"));
		const file = join(dir, "t.jsonl");
		writeFileSync(file, ezioProjection());
		const ev = extractEvidence(parseTranscript(file));
		expect(ev.userPrompts.map((u) => u.text)).toContain("analyze auth");
		expect(ev.toolCalls.map((t) => t.name)).toEqual(expect.arrayContaining(["Read", "bash"]));
		expect(ev.filePaths.map((f) => f.path)).toContain("src/auth.ts");
	});
});

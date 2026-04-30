import { describe, it, expect } from "vitest";
import { extractEvidence } from "../../../../src/lib/history/compact.js";
import type { RawTurn } from "../../../../src/lib/history/types.js";

function turn(t: number, role: RawTurn["role"], text: string, toolUses?: RawTurn["toolUses"]): RawTurn {
	return { turn: t, role, text, toolUses };
}

describe("extractEvidence — nextAssistantSnippet", () => {
	it("populates nextAssistantSnippet on corrections from the next assistant turn", () => {
		const turns: RawTurn[] = [
			turn(1, "user", "no, that's wrong — use POST not GET"),
			turn(2, "assistant", "Got it — switching to POST."),
		];
		const ev = extractEvidence(turns);
		expect(ev.corrections).toHaveLength(1);
		expect(ev.corrections[0].nextAssistantSnippet).toBe("Got it — switching to POST.");
	});

	it("populates nextAssistantSnippet on userPrompts from the next assistant turn", () => {
		const turns: RawTurn[] = [
			turn(1, "user", "How do I deploy this?"),
			turn(2, "assistant", "1. Build the image\n2. Push to registry\n3. Trigger deploy"),
		];
		const ev = extractEvidence(turns);
		expect(ev.userPrompts[0].nextAssistantSnippet).toBe(
			"1. Build the image\n2. Push to registry\n3. Trigger deploy",
		);
	});

	it("skips intervening tool-only assistant turns to find the next text turn", () => {
		const turns: RawTurn[] = [
			turn(1, "user", "no, change the path"),
			turn(2, "assistant", "", [{ name: "Read", input: { file_path: "/x" } }]),
			turn(3, "assistant", "Okay, the path is updated."),
		];
		const ev = extractEvidence(turns);
		expect(ev.corrections[0].nextAssistantSnippet).toBe("Okay, the path is updated.");
	});

	it("truncates snippets at 500 chars", () => {
		const long = "x".repeat(800);
		const turns: RawTurn[] = [
			turn(1, "user", "How do I tile this?"),
			turn(2, "assistant", long),
		];
		const ev = extractEvidence(turns);
		expect(ev.userPrompts[0].nextAssistantSnippet!.length).toBe(500);
	});

	it("leaves nextAssistantSnippet undefined when there is no next assistant turn", () => {
		const turns: RawTurn[] = [
			turn(1, "user", "no, that's wrong"),
		];
		const ev = extractEvidence(turns);
		expect(ev.corrections[0].nextAssistantSnippet).toBeUndefined();
	});

	it("leaves nextAssistantSnippet undefined when only tool-use turns follow", () => {
		const turns: RawTurn[] = [
			turn(1, "user", "no, undo that"),
			turn(2, "assistant", "", [{ name: "Read", input: {} }]),
		];
		const ev = extractEvidence(turns);
		expect(ev.corrections[0].nextAssistantSnippet).toBeUndefined();
	});
});

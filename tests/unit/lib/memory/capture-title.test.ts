import { describe, it, expect } from "vitest";
import { sanitizeCaptureTitle } from "../../../../src/lib/memory/extract.js";

describe("sanitizeCaptureTitle", () => {
	it("multi-line prompt collapses to the first meaningful line, single line always", () => {
		const text =
			"need to update the seed a bit\nai-creed should own the doc\nsecond para";
		const t = sanitizeCaptureTitle(text, text);
		expect(t).toBe("need to update the seed a bit");
		expect(t.includes("\n")).toBe(false);
	});

	it("strips markdown/quote markers and collapses whitespace", () => {
		expect(sanitizeCaptureTitle("## >  fix   the \t gate", "fix the gate")).toBe(
			"fix the gate",
		);
	});

	it("caps at 80 chars with ellipsis", () => {
		const t = sanitizeCaptureTitle("a".repeat(200), "a".repeat(200));
		expect(t.length).toBe(78);
		expect(t.endsWith("…")).toBe(true);
	});

	it("a single-line bare-hash prompt derives its title from the composed body (spec §4.2)", () => {
		// The normal production case: prompt IS just a hash; the stored body is
		// prompt + acknowledgement echo, and the echo carries the meaning.
		const t = sanitizeCaptureTitle(
			"9135201f3ab37",
			"9135201f3ab37\n\n_Acknowledged:_ Reverted the tag; release gate must rerun before tagging.",
		);
		expect(t).not.toMatch(/^[0-9a-f]{7,40}$/i);
		expect(t).toContain("release");
		expect(t.toLowerCase()).not.toContain("acknowledged");
	});

	it("multi-line hash prompt still derives from later prompt/body lines", () => {
		const text =
			"9135201f3ab37\nrelease gate skipped before tagging burned the version bump";
		const t = sanitizeCaptureTitle(text, text);
		expect(t).not.toMatch(/^[0-9a-f]{7,40}$/i);
		expect(t).toContain("release");
	});

	it("whitespace-only input yields the fixed fallback", () => {
		expect(sanitizeCaptureTitle("   \n  ", "   ")).toBe("capture");
	});
});

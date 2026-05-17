import { describe, it, expect } from "vitest";
import { typeColor, TYPE_PALETTE } from "../../../src/tui/theme.js";

describe("typeColor", () => {
	it("returns fixed hues for known types", () => {
		expect(typeColor("decision")).toBe("#D97757");
		expect(typeColor("gotcha")).toBe("#E5544B");
		expect(typeColor("feedback")).toBe("#5FB3C9");
		expect(typeColor("project")).toBe("#7FB069");
		expect(typeColor("reference")).toBe("#B589D6");
		expect(typeColor("pattern")).toBe("#E0A93B");
		expect(typeColor("how-to")).toBe("#4FAF8E");
		expect(typeColor("user")).toBe("#6F9FD9");
	});
	it("maps a custom type deterministically into the palette", () => {
		const a = typeColor("my-custom-type");
		const b = typeColor("my-custom-type");
		expect(a).toBe(b);
		expect(TYPE_PALETTE).toContain(a);
	});
	it("different custom types are stable across calls", () => {
		expect(typeColor("alpha")).toBe(typeColor("alpha"));
		expect(typeColor("beta")).toBe(typeColor("beta"));
	});
});

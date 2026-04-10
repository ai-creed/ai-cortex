import { describe, expect, it } from "vitest";
import { extractImportEdgesFromSource } from "../../src/spike/ts-import-graph.js";

describe("phase 0 spike workspace", () => {
	it("loads the spike entrypoint", async () => {
		const mod = await import("../../src/spike/run-phase-0.js");
		expect(typeof mod.runPhase0).toBe("function");
	});

	it("extracts relative import edges from TypeScript source", () => {
		const edges = extractImportEdgesFromSource(
			"src/a.ts",
			"import { b } from './b';\nimport c from '../shared/c';\nimport x from 'react';"
		);

		expect(edges).toEqual([
			{ from: "src/a.ts", to: "src/b" },
			{ from: "src/a.ts", to: "shared/c" }
		]);
	});
});

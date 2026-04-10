import { describe, expect, it } from "vitest";
import { rankDocCandidates } from "../../src/spike/doc-inputs.js";

describe("rankDocCandidates", () => {
	it("prefers README and shared planning docs", () => {
		const ranked = rankDocCandidates([
			"src/app.ts",
			"README.md",
			"docs/shared/architecture_decisions.md",
			"docs/shared/high_level_plan.md"
		]);

		expect(ranked.slice(0, 3)).toEqual([
			"README.md",
			"docs/shared/architecture_decisions.md",
			"docs/shared/high_level_plan.md"
		]);
	});
});

import { describe, it, expect } from "vitest";
import { produceHowToCandidates } from "../../../../src/lib/memory/extract.js";
import type { EvidenceLayer } from "../../../../src/lib/history/types.js";

const ev = (overrides: Partial<EvidenceLayer> = {}): EvidenceLayer => ({
	toolCalls: [], filePaths: [], userPrompts: [], corrections: [], ...overrides,
});

describe("produceHowToCandidates", () => {
	it("emits a how-to when prompt regex matches AND ≥3 sequential tool calls follow", () => {
		const out = produceHowToCandidates("s-1", ev({
			userPrompts: [{ turn: 1, text: "how do I deploy this service" }],
			toolCalls: [
				{ turn: 2, name: "Bash", args: "docker build" },
				{ turn: 3, name: "Bash", args: "docker push" },
				{ turn: 4, name: "Bash", args: "kubectl apply" },
			],
			filePaths: [{ turn: 2, path: "Dockerfile" }, { turn: 4, path: "k8s.yaml" }],
		}));
		expect(out).toHaveLength(1);
		expect(out[0].type).toBe("how-to");
		expect(out[0].confidence).toBeCloseTo(0.40, 2);
		expect(out[0].scopeFiles).toEqual(["Dockerfile", "k8s.yaml"]);
	});

	it("bumps confidence when nextAssistantSnippet contains a numbered list", () => {
		const out = produceHowToCandidates("s-2", ev({
			userPrompts: [{
				turn: 1,
				text: "what are the steps to publish",
				nextAssistantSnippet: "1. Build\n2. Tag\n3. Push",
			}],
			toolCalls: [
				{ turn: 2, name: "Bash", args: "build" },
				{ turn: 3, name: "Bash", args: "tag" },
				{ turn: 4, name: "Bash", args: "push" },
			],
		}));
		expect(out[0].confidence).toBeCloseTo(0.50, 2);
	});

	it("ignores prompts that don't match the how-to regex", () => {
		const out = produceHowToCandidates("s-3", ev({
			userPrompts: [{ turn: 1, text: "tell me a joke" }],
			toolCalls: [
				{ turn: 2, name: "Bash", args: "x" },
				{ turn: 3, name: "Bash", args: "y" },
				{ turn: 4, name: "Bash", args: "z" },
			],
		}));
		expect(out).toEqual([]);
	});

	it("ignores how-to prompts followed by fewer than 3 tool calls", () => {
		const out = produceHowToCandidates("s-4", ev({
			userPrompts: [{ turn: 1, text: "how do i build the docker image" }],
			toolCalls: [
				{ turn: 2, name: "Bash", args: "x" },
				{ turn: 3, name: "Bash", args: "y" },
			],
		}));
		expect(out).toEqual([]);
	});
});

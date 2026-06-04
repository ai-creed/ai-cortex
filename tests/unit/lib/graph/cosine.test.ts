import { describe, it, expect } from "vitest";
import { dot } from "../../../../src/lib/graph/cosine.js";

describe("dot (cosine for L2-normalized vectors)", () => {
	it("is 1 for identical unit vectors", () => {
		const v = Float32Array.from([0.6, 0.8]);
		expect(dot(v, v)).toBeCloseTo(1, 6);
	});
	it("is 0 for orthogonal unit vectors", () => {
		const a = Float32Array.from([1, 0]);
		const b = Float32Array.from([0, 1]);
		expect(dot(a, b)).toBeCloseTo(0, 6);
	});
});

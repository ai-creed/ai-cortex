import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import { evaluateLedger } from "../../../../src/lib/memory/surface-ledger.js";

let repoKey: string;
beforeEach(async () => { repoKey = await mkRepoKey("surface-ledger"); });
afterEach(async () => { await cleanupRepo(repoKey); });

describe("evaluateLedger", () => {
	it("emits the first time, silent the second time (same set)", () => {
		const perFile = new Map([["src/a.ts", ["m1", "m2"]]]);
		expect(evaluateLedger(repoKey, "sess1", perFile).emit).toBe(true);
		expect(evaluateLedger(repoKey, "sess1", perFile).emit).toBe(false);
	});

	it("re-emits when the memory set for the file changes", () => {
		expect(
			evaluateLedger(repoKey, "s", new Map([["src/a.ts", ["m1"]]])).emit,
		).toBe(true);
		expect(
			evaluateLedger(repoKey, "s", new Map([["src/a.ts", ["m1", "m2"]]])).emit,
		).toBe(true);
	});

	it("set order does not matter", () => {
		expect(
			evaluateLedger(repoKey, "s", new Map([["src/a.ts", ["m1", "m2"]]])).emit,
		).toBe(true);
		expect(
			evaluateLedger(repoKey, "s", new Map([["src/a.ts", ["m2", "m1"]]])).emit,
		).toBe(false);
	});

	it("different sessions are independent", () => {
		const pf = new Map([["src/a.ts", ["m1"]]]);
		expect(evaluateLedger(repoKey, "sA", pf).emit).toBe(true);
		expect(evaluateLedger(repoKey, "sB", pf).emit).toBe(true);
	});

	it("sanitizes session id and never throws on odd input", () => {
		const pf = new Map([["src/a.ts", ["m1"]]]);
		let res: { emit: boolean } | undefined;
		expect(() => {
			res = evaluateLedger(repoKey, "../../etc/passwd", pf);
		}).not.toThrow();
		// Assert the FIRST call's result; calling again would dedup to false.
		expect(res!.emit).toBe(true);
	});
});

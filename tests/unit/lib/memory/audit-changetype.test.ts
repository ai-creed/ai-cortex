import { describe, it, expect } from "vitest";
import type { AuditChangeType } from "../../../../src/lib/memory/types.js";

describe("AuditChangeType", () => {
	it("accepts the retype arm at the type level", () => {
		// If "retype" is NOT in the union this line is a tsc compile error,
		// which `pnpm typecheck` (Step 2) reports. Runtime assertion is a
		// trivial keep-green guard.
		const v: AuditChangeType = "retype";
		expect(v).toBe("retype");
	});
});

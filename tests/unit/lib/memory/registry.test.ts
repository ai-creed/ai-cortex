import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
	ensureRegistry,
	readRegistry,
	validateRegistration,
	typeContractHint,
	applyTypeFieldDefaults,
	BUILT_IN_TYPES,
} from "../../../../src/lib/memory/registry.js";

describe("typeContractHint", () => {
	it("lists the built-in types and the gotcha severity requirement, not internal 'capture'", () => {
		const h = typeContractHint();
		for (const t of BUILT_IN_TYPES) expect(h).toContain(t);
		expect(h).not.toContain("capture");
		expect(h.toLowerCase()).toContain("severity");
		for (const s of ["info", "warning", "critical"]) expect(h).toContain(s);
	});
});

let tmp: string;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-registry-"));
});

describe("ensureRegistry", () => {
	it("creates types.json with the built-in types when missing", async () => {
		await ensureRegistry(tmp);
		const reg = await readRegistry(tmp);
		expect(Object.keys(reg.types).sort()).toEqual([
			"capture",
			"constraint",
			"decision",
			"deferred",
			"gotcha",
			"how-to",
			"pattern",
			"preference",
		]);
		for (const t of BUILT_IN_TYPES) {
			expect(reg.types[t].builtIn).toBe(true);
		}
	});

	it("preserves user-added types on re-run", async () => {
		await ensureRegistry(tmp);
		const p = path.join(tmp, "types.json");
		const reg = JSON.parse(await fs.readFile(p, "utf8"));
		reg.types["incident"] = {
			builtIn: false,
			bodySections: ["Trigger", "Impact"],
		};
		await fs.writeFile(p, JSON.stringify(reg, null, 2));

		await ensureRegistry(tmp); // idempotent re-run
		const reg2 = await readRegistry(tmp);
		expect(reg2.types["incident"]).toBeDefined();
	});
});

describe("validateRegistration", () => {
	it("accepts a memory whose type is registered with required extras", async () => {
		await ensureRegistry(tmp);
		const reg = await readRegistry(tmp);
		const result = validateRegistration(reg, {
			type: "gotcha",
			typeFields: { severity: "critical" },
		});
		expect(result.ok).toBe(true);
	});

	it("rejects a gotcha missing severity", async () => {
		await ensureRegistry(tmp);
		const reg = await readRegistry(tmp);
		const result = validateRegistration(reg, {
			type: "gotcha",
			typeFields: {},
		});
		expect(result.ok).toBe(false);
		expect((result as { ok: false; errors: string[] }).errors[0]).toMatch(
			/severity/,
		);
	});

	it("rejects a gotcha with severity outside the enum", async () => {
		await ensureRegistry(tmp);
		const reg = await readRegistry(tmp);
		const result = validateRegistration(reg, {
			type: "gotcha",
			typeFields: { severity: "catastrophic" },
		});
		expect(result.ok).toBe(false);
		expect((result as { ok: false; errors: string[] }).errors[0]).toMatch(
			/severity/,
		);
	});

	it("rejects an unregistered type", async () => {
		await ensureRegistry(tmp);
		const reg = await readRegistry(tmp);
		const result = validateRegistration(reg, { type: "rumor", typeFields: {} });
		expect(result.ok).toBe(false);
		expect((result as { ok: false; errors: string[] }).errors[0]).toMatch(
			/unregistered type/,
		);
	});
});

describe("v3 types", () => {
	it("registers constraint, preference, deferred as built-ins", () => {
		expect(BUILT_IN_TYPES).toContain("constraint");
		expect(BUILT_IN_TYPES).toContain("preference");
		expect(BUILT_IN_TYPES).toContain("deferred");
	});
	it("contract hint carries the decision tree and the severity default", () => {
		const hint = typeContractHint();
		expect(hint).toContain("constraint");
		expect(hint).toContain("preference");
		expect(hint).toContain("deferred");
		expect(hint).toContain("defaults to warning");
	});
});

describe("applyTypeFieldDefaults", () => {
	it("fills severity=warning for gotcha when absent", () => {
		expect(applyTypeFieldDefaults("gotcha", undefined)).toEqual({ severity: "warning" });
		expect(applyTypeFieldDefaults("gotcha", { severity: "critical" })).toEqual({ severity: "critical" });
		expect(applyTypeFieldDefaults("decision", undefined)).toBeUndefined();
	});
});

describe("validateRegistration — v3 types", () => {
	it("accepts constraint, preference, deferred with no typeFields", async () => {
		await ensureRegistry(tmp);
		const reg = await readRegistry(tmp);
		for (const type of ["constraint", "preference", "deferred"]) {
			expect(validateRegistration(reg, { type })).toEqual({ ok: true });
		}
	});
	it("still rejects unregistered types", async () => {
		await ensureRegistry(tmp);
		const reg = await readRegistry(tmp);
		const res = validateRegistration(reg, { type: "constraintz" });
		expect(res.ok).toBe(false);
		expect((res as { ok: false; errors: string[] }).errors[0]).toContain(
			"unregistered type",
		);
	});
});

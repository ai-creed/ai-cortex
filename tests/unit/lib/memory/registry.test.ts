import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ensureRegistry, readRegistry, validateRegistration, BUILT_IN_TYPES } from "../../../../src/lib/memory/registry.js";

let tmp: string;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-registry-"));
});

describe("ensureRegistry", () => {
	it("creates types.json with the four built-in types when missing", async () => {
		await ensureRegistry(tmp);
		const reg = await readRegistry(tmp);
		expect(Object.keys(reg.types).sort()).toEqual(["decision", "gotcha", "how-to", "pattern"]);
		for (const t of BUILT_IN_TYPES) {
			expect(reg.types[t].builtIn).toBe(true);
		}
	});

	it("preserves user-added types on re-run", async () => {
		await ensureRegistry(tmp);
		const p = path.join(tmp, "types.json");
		const reg = JSON.parse(await fs.readFile(p, "utf8"));
		reg.types["incident"] = { builtIn: false, bodySections: ["Trigger", "Impact"] };
		await fs.writeFile(p, JSON.stringify(reg, null, 2));

		await ensureRegistry(tmp);  // idempotent re-run
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
		const result = validateRegistration(reg, { type: "gotcha", typeFields: {} });
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatch(/severity/);
	});

	it("rejects a gotcha with severity outside the enum", async () => {
		await ensureRegistry(tmp);
		const reg = await readRegistry(tmp);
		const result = validateRegistration(reg, {
			type: "gotcha",
			typeFields: { severity: "catastrophic" },
		});
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatch(/severity/);
	});

	it("rejects an unregistered type", async () => {
		await ensureRegistry(tmp);
		const reg = await readRegistry(tmp);
		const result = validateRegistration(reg, { type: "rumor", typeFields: {} });
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatch(/unregistered type/);
	});
});

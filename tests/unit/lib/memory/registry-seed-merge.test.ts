import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	ensureRegistry,
	readRegistry,
	REGISTRY_VERSION,
} from "../../../../src/lib/memory/registry.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("registry seed-merge", () => {
	it("REGISTRY_VERSION is 2", () => {
		expect(REGISTRY_VERSION).toBe(2);
	});

	it("brand-new repo is seeded with capture present", async () => {
		await ensureRegistry(dir);
		const reg = await readRegistry(dir);
		expect(reg.version).toBe(2);
		expect(reg.types.capture).toBeDefined();
		expect(reg.types.capture.bodySections).toBeUndefined();
		expect(reg.types.capture.extraFrontmatter).toBeUndefined();
		expect(reg.types.decision).toBeDefined();
	});

	it("old registry without capture is migrated; user types preserved; idempotent", async () => {
		const p = path.join(dir, "types.json");
		fs.writeFileSync(
			p,
			JSON.stringify({
				version: 1,
				types: {
					decision: { builtIn: true, bodySections: ["Rule"] },
					"my-custom": { builtIn: false, bodySections: ["X"] },
				},
			}),
		);
		await ensureRegistry(dir);
		let reg = await readRegistry(dir);
		expect(reg.version).toBe(2);
		expect(reg.types.capture).toBeDefined();
		expect(reg.types["my-custom"]).toEqual({
			builtIn: false,
			bodySections: ["X"],
		});
		// idempotent
		await ensureRegistry(dir);
		reg = await readRegistry(dir);
		expect(reg.version).toBe(2);
		expect(reg.types["my-custom"]).toBeDefined();
	});

	it("same-name user 'capture' is force-overwritten with the built-in spec + diagnostic", async () => {
		const p = path.join(dir, "types.json");
		fs.writeFileSync(
			p,
			JSON.stringify({
				version: 1,
				types: {
					capture: { builtIn: false, bodySections: ["Required"] },
				},
			}),
		);
		const errs: string[] = [];
		const orig = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((s: string | Uint8Array) => {
			errs.push(String(s));
			return true;
		}) as typeof process.stderr.write;
		try {
			await ensureRegistry(dir);
		} finally {
			process.stderr.write = orig;
		}
		const reg = await readRegistry(dir);
		expect(reg.types.capture.bodySections).toBeUndefined();
		expect(reg.types.capture.builtIn).toBe(true);
		expect(errs.join("")).toMatch(/capture.*overrid/i);
	});
});

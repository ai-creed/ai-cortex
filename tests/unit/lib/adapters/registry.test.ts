// tests/unit/lib/adapters/registry.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import {
	getAdapterForFile,
	adapterSupports,
	isAdapterExt,
} from "../../../../src/lib/adapters/index.js";
import {
	ensureAdapters,
	resetEnsureAdapters,
} from "../../../../src/lib/adapters/ensure.js";
import type { AdapterCapabilities } from "../../../../src/lib/lang-adapter.js";

beforeEach(() => {
	resetEnsureAdapters();
});

describe("getAdapterForFile", () => {
	it("returns TS adapter for .ts files", async () => {
		await ensureAdapters();
		const adapter = getAdapterForFile("src/main.ts");
		expect(adapter).not.toBeNull();
		expect(adapter?.extensions).toContain(".ts");
	});

	it("returns Python adapter for .py files", async () => {
		await ensureAdapters();
		const adapter = getAdapterForFile("src/main.py");
		expect(adapter).not.toBeNull();
		expect(adapter?.extensions).toContain(".py");
	});

	it("returns C adapter for .c files", async () => {
		await ensureAdapters();
		const adapter = getAdapterForFile("src/main.c");
		expect(adapter).not.toBeNull();
		expect(adapter?.extensions).toContain(".c");
	});

	it("returns null for unsupported extensions", async () => {
		await ensureAdapters();
		const adapter = getAdapterForFile("src/main.txt");
		expect(adapter).toBeNull();
	});
});

describe("adapterSupports", () => {
	it("returns true for callGraph on .ts files", async () => {
		await ensureAdapters();
		expect(adapterSupports("src/main.ts", "callGraph")).toBe(true);
	});

	it("returns true for callGraph on .py files", async () => {
		await ensureAdapters();
		expect(adapterSupports("src/main.py", "callGraph")).toBe(true);
	});

	it("returns false for callGraph on .txt files (no adapter)", async () => {
		await ensureAdapters();
		expect(adapterSupports("src/main.txt", "callGraph")).toBe(false);
	});

	it("returns true for importExtraction on .ts files", async () => {
		await ensureAdapters();
		expect(adapterSupports("src/main.ts", "importExtraction")).toBe(true);
	});
});

describe("LanguageAdapter capabilities shape", () => {
	it("TS adapter has capabilities object with required keys", async () => {
		await ensureAdapters();
		const adapter = getAdapterForFile("src/main.ts");
		expect(adapter?.capabilities).toBeDefined();
		const caps = adapter!.capabilities as AdapterCapabilities;
		expect(typeof caps.importExtraction).toBe("boolean");
		expect(typeof caps.callGraph).toBe("boolean");
		expect(typeof caps.symbolIndex).toBe("boolean");
	});

	it("Python adapter has callGraph: true", async () => {
		await ensureAdapters();
		const adapter = getAdapterForFile("src/main.py");
		expect(adapter?.capabilities.callGraph).toBe(true);
	});

	it("TS adapter exposes async extractImports method", async () => {
		await ensureAdapters();
		const adapter = getAdapterForFile("src/main.ts");
		expect(typeof adapter?.extractImports).toBe("function");
	});

	it("TS adapter exposes extractCallGraph method", async () => {
		await ensureAdapters();
		const adapter = getAdapterForFile("src/main.ts");
		expect(typeof adapter?.extractCallGraph).toBe("function");
	});
});

describe("isAdapterExt backward compatibility", () => {
	it("still returns true for .ts", async () => {
		await ensureAdapters();
		expect(isAdapterExt("src/main.ts")).toBe(true);
	});

	it("still returns false for .txt", async () => {
		await ensureAdapters();
		expect(isAdapterExt("src/main.txt")).toBe(false);
	});
});

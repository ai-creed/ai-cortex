import { describe, expect, it, beforeEach } from "vitest";
import {
	registerAdapter,
	adapterForFile,
	clearAdapters,
	isAdapterExt,
	adapterExtensions,
} from "../../../src/lib/adapters/index.js";
import type { LanguageAdapter } from "../../../src/lib/lang-adapter.js";

const stubAdapter: LanguageAdapter = {
	extensions: [".ts", ".tsx"],
	capabilities: { importExtraction: true, callGraph: true, symbolIndex: false },
	extractImports: async () => [],
	extractCallGraph: async () => ({
		functions: [],
		rawCalls: [],
		importBindings: [],
	}),
};

describe("adapter registry", () => {
	beforeEach(() => {
		clearAdapters();
	});

	it("returns undefined for unregistered extension", () => {
		expect(adapterForFile("foo.py")).toBeUndefined();
	});

	it("returns registered adapter for matching extension", () => {
		registerAdapter(stubAdapter);
		expect(adapterForFile("src/lib/foo.ts")).toBe(stubAdapter);
	});

	it("matches .tsx extension", () => {
		registerAdapter(stubAdapter);
		expect(adapterForFile("src/App.tsx")).toBe(stubAdapter);
	});

	it("returns undefined when no adapter matches", () => {
		registerAdapter(stubAdapter);
		expect(adapterForFile("styles.css")).toBeUndefined();
	});

	it("returns undefined for file with no extension", () => {
		registerAdapter(stubAdapter);
		expect(adapterForFile("Makefile")).toBeUndefined();
	});
});

describe("registry helpers", () => {
	beforeEach(() => clearAdapters());

	it("isAdapterExt returns true for any registered extension", () => {
		registerAdapter({
			extensions: [".foo", ".bar"],
			capabilities: {
				importExtraction: true,
				callGraph: false,
				symbolIndex: false,
			},
			extractImports: async () => [],
		});
		expect(isAdapterExt("a.foo")).toBe(true);
		expect(isAdapterExt("a.bar")).toBe(true);
		expect(isAdapterExt("a.baz")).toBe(false);
		expect(isAdapterExt("noext")).toBe(false);
	});

	it("adapterExtensions returns the union of registered extensions", () => {
		registerAdapter({
			extensions: [".x"],
			capabilities: {
				importExtraction: true,
				callGraph: false,
				symbolIndex: false,
			},
			extractImports: async () => [],
		});
		registerAdapter({
			extensions: [".y", ".z"],
			capabilities: {
				importExtraction: true,
				callGraph: false,
				symbolIndex: false,
			},
			extractImports: async () => [],
		});
		const exts = adapterExtensions();
		expect(new Set(exts)).toEqual(new Set([".x", ".y", ".z"]));
	});
});

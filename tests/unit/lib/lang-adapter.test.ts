import { describe, expect, it, beforeEach } from "vitest";
import { registerAdapter, adapterForFile, clearAdapters } from "../../../src/lib/adapters/index.js";
import type { LangAdapter } from "../../../src/lib/lang-adapter.js";

const stubAdapter: LangAdapter = {
	extensions: [".ts", ".tsx"],
	extractFile: () => ({ functions: [], rawCalls: [], importBindings: [] }),
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

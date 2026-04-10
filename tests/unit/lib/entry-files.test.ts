// tests/unit/lib/entry-files.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");

import fs from "node:fs";
import { pickEntryFiles, readPackageMeta } from "../../../src/lib/entry-files.js";

const mockFs = vi.mocked(fs);

describe("readPackageMeta", () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it("reads name, version, and detects electron framework", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({ name: "my-app", version: "1.2.3", devDependencies: { electron: "^30.0.0" } }) as any
		);
		const meta = readPackageMeta("/repo");
		expect(meta).toEqual({ name: "my-app", version: "1.2.3", framework: "electron" });
	});

	it("detects next framework", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({ name: "app", version: "1.0.0", dependencies: { next: "^14.0.0" } }) as any
		);
		expect(readPackageMeta("/repo").framework).toBe("next");
	});

	it("detects vite framework", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			JSON.stringify({ name: "app", version: "1.0.0", devDependencies: { vite: "^5.0.0" } }) as any
		);
		expect(readPackageMeta("/repo").framework).toBe("vite");
	});

	it("returns safe defaults when package.json is missing", () => {
		mockFs.existsSync.mockReturnValue(false);
		const meta = readPackageMeta("/repo/my-project");
		expect(meta.name).toBe("my-project");
		expect(meta.version).toBe("0.0.0");
		expect(meta.framework).toBeNull();
	});

	it("returns safe defaults when package.json is malformed", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue("not json{{{" as any);
		const meta = readPackageMeta("/repo/my-project");
		expect(meta.name).toBe("my-project");
	});
});

describe("pickEntryFiles", () => {
	it("prefers package.json main field when it points to source", () => {
		const files = ["src/main.ts", "src/index.ts", "index.ts"];
		const meta = { name: "app", version: "1.0.0", main: "src/main.ts", framework: null as null };
		expect(pickEntryFiles(files, meta)[0]).toBe("src/main.ts");
	});

	it("excludes package.json main when it points to dist/", () => {
		const files = ["dist/index.js", "src/index.ts"];
		const meta = { name: "app", version: "1.0.0", main: "dist/index.js", framework: null as null };
		const entries = pickEntryFiles(files, meta);
		expect(entries).not.toContain("dist/index.js");
	});

	it("uses electron conventions when framework is electron", () => {
		const files = ["electron/main/index.ts", "src/renderer.tsx"];
		const meta = { name: "app", version: "1.0.0", framework: "electron" as const };
		expect(pickEntryFiles(files, meta)).toContain("electron/main/index.ts");
	});

	it("falls back to common conventions when no other match", () => {
		const files = ["src/index.ts", "lib/helper.ts"];
		const meta = { name: "app", version: "1.0.0", framework: null as null };
		expect(pickEntryFiles(files, meta)).toContain("src/index.ts");
	});

	it("returns only paths present in the provided file list", () => {
		const files = ["lib/helper.ts"];
		const meta = { name: "app", version: "1.0.0", framework: null as null };
		expect(pickEntryFiles(files, meta)).toEqual([]);
	});

	it("caps results at 8", () => {
		const files = Array.from({ length: 20 }, (_, i) => `src/index${i}.ts`);
		const meta = { name: "app", version: "1.0.0", framework: null as null, main: "src/index0.ts" };
		expect(pickEntryFiles(files, meta).length).toBeLessThanOrEqual(8);
	});
});

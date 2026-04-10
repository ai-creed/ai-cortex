// tests/unit/lib/diff-files.test.ts
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashFileContent } from "../../../src/lib/diff-files.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-diff-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("hashFileContent", () => {
	it("returns SHA-256 hex of file content", () => {
		const content = "export const x = 1;\n";
		fs.writeFileSync(path.join(tmpDir, "a.ts"), content);
		const expected = createHash("sha256").update(content).digest("hex");

		expect(hashFileContent(tmpDir, "a.ts")).toBe(expected);
	});

	it("returns different hash for different content", () => {
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "const a = 1;\n");
		fs.writeFileSync(path.join(tmpDir, "b.ts"), "const b = 2;\n");

		expect(hashFileContent(tmpDir, "a.ts")).not.toBe(
			hashFileContent(tmpDir, "b.ts"),
		);
	});

	it("returns same hash for identical content", () => {
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "same\n");
		fs.writeFileSync(path.join(tmpDir, "b.ts"), "same\n");

		expect(hashFileContent(tmpDir, "a.ts")).toBe(
			hashFileContent(tmpDir, "b.ts"),
		);
	});
});

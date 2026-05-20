import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	readHeadline,
	writeHeadline,
} from "../../../scripts/lib/release-headline.js";

describe("release-headline helper", () => {
	let tmpFile: string;

	beforeEach(() => {
		tmpFile = path.join(
			os.tmpdir(),
			`pkg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
		);
	});

	afterEach(() => {
		if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
	});

	it("readHeadline returns '' when aiCortex key is absent", () => {
		fs.writeFileSync(
			tmpFile,
			JSON.stringify({ name: "ai-cortex", version: "0.10.0" }, null, "\t") + "\n",
		);
		expect(readHeadline(tmpFile)).toBe("");
	});

	it("readHeadline returns '' when aiCortex.releaseHeadline is missing", () => {
		fs.writeFileSync(
			tmpFile,
			JSON.stringify({ aiCortex: {} }, null, "\t") + "\n",
		);
		expect(readHeadline(tmpFile)).toBe("");
	});

	it("readHeadline returns the string when present", () => {
		fs.writeFileSync(
			tmpFile,
			JSON.stringify(
				{ aiCortex: { releaseHeadline: "edit-time surfacing" } },
				null,
				"\t",
			) + "\n",
		);
		expect(readHeadline(tmpFile)).toBe("edit-time surfacing");
	});

	it("writeHeadline creates the aiCortex object if absent", () => {
		fs.writeFileSync(
			tmpFile,
			JSON.stringify({ name: "ai-cortex", version: "0.10.0" }, null, "\t") + "\n",
		);
		writeHeadline(tmpFile, "new headline");
		const parsed = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
		expect(parsed.aiCortex.releaseHeadline).toBe("new headline");
		expect(parsed.name).toBe("ai-cortex");
		expect(parsed.version).toBe("0.10.0");
	});

	it("writeHeadline overwrites an existing headline", () => {
		fs.writeFileSync(
			tmpFile,
			JSON.stringify(
				{ aiCortex: { releaseHeadline: "old" } },
				null,
				"\t",
			) + "\n",
		);
		writeHeadline(tmpFile, "new");
		expect(readHeadline(tmpFile)).toBe("new");
	});

	it("writeHeadline accepts empty string (clear)", () => {
		fs.writeFileSync(
			tmpFile,
			JSON.stringify(
				{ aiCortex: { releaseHeadline: "previous" } },
				null,
				"\t",
			) + "\n",
		);
		writeHeadline(tmpFile, "");
		expect(readHeadline(tmpFile)).toBe("");
		const parsed = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
		expect("releaseHeadline" in parsed.aiCortex).toBe(true);
	});

	it("writeHeadline preserves tab indentation", () => {
		fs.writeFileSync(
			tmpFile,
			JSON.stringify({ name: "x" }, null, "\t") + "\n",
		);
		writeHeadline(tmpFile, "h");
		const raw = fs.readFileSync(tmpFile, "utf-8");
		expect(raw).toMatch(/\n\t"/);
		expect(raw).not.toMatch(/\n {2}"/);
	});

	it("writeHeadline preserves the trailing newline", () => {
		fs.writeFileSync(
			tmpFile,
			JSON.stringify({ name: "x" }, null, "\t") + "\n",
		);
		writeHeadline(tmpFile, "h");
		const raw = fs.readFileSync(tmpFile, "utf-8");
		expect(raw.endsWith("\n")).toBe(true);
	});

	it("writeHeadline is idempotent (re-running with the same value produces the same file)", () => {
		fs.writeFileSync(
			tmpFile,
			JSON.stringify({ name: "x" }, null, "\t") + "\n",
		);
		writeHeadline(tmpFile, "h");
		const first = fs.readFileSync(tmpFile, "utf-8");
		writeHeadline(tmpFile, "h");
		const second = fs.readFileSync(tmpFile, "utf-8");
		expect(second).toBe(first);
	});
});

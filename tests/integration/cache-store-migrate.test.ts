import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	renameStore,
	classifyStore,
} from "../../src/lib/cache-store-migrate.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-int-"));
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function makePopulated(dir: string): void {
	fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
	const db = new Database(path.join(dir, "memory", "index.sqlite"));
	db.pragma("journal_mode = WAL");
	db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY)");
	db.prepare("INSERT INTO memories(id) VALUES(?)").run("m1");
	db.close();
}

describe("renameStore", () => {
	it("renames literal dir to hashed when target does not exist", () => {
		const literal = path.join(tmp, "MyRepo");
		const hashed = path.join(tmp, "0123456789abcdef");
		makePopulated(literal);

		renameStore(literal, hashed);

		expect(fs.existsSync(literal)).toBe(false);
		expect(
			fs.existsSync(path.join(hashed, "memory", "index.sqlite-wal")),
		).toBe(false);
		expect(classifyStore(hashed)).toBe("populated");
	});

	it("throws when destination exists", () => {
		const literal = path.join(tmp, "L");
		const hashed = path.join(tmp, "abcdef0123456789");
		makePopulated(literal);
		fs.mkdirSync(hashed);

		expect(() => renameStore(literal, hashed)).toThrow(
			/destination exists/i,
		);
	});
});

describe("renameStore EXDEV fallback", () => {
	it("falls back to copy+unlink when rename throws EXDEV", () => {
		const literal = path.join(tmp, "L2");
		const hashed = path.join(tmp, "fedcba9876543210");
		makePopulated(literal);

		const spy = vi.spyOn(fs, "renameSync").mockImplementation(((
			from: fs.PathLike,
			to: fs.PathLike,
		) => {
			const err: NodeJS.ErrnoException = new Error(
				"cross-device link not permitted",
			);
			err.code = "EXDEV";
			throw err;
		}) as typeof fs.renameSync);

		try {
			renameStore(literal, hashed);
		} finally {
			spy.mockRestore();
		}

		expect(fs.existsSync(literal)).toBe(false);
		expect(classifyStore(hashed)).toBe("populated");
	});
});

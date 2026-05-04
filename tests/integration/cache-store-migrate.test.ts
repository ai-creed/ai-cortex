import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	renameStore,
	classifyStore,
	quarantineStore,
	acquireMigrationLock,
	SENTINEL_NAME,
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

describe("quarantineStore", () => {
	it("moves the literal dir under .quarantine and writes MIGRATION-CONFLICT.md", () => {
		const literal = path.join(tmp, "MyRepo");
		const hashed = path.join(tmp, "0123456789abcdef");
		makePopulated(literal);
		makePopulated(hashed);

		const result = quarantineStore({
			cacheRoot: tmp,
			literalKey: "MyRepo",
			literalDir: literal,
			canonicalDir: hashed,
		});

		expect(fs.existsSync(literal)).toBe(false);
		expect(fs.existsSync(result.quarantinePath)).toBe(true);
		expect(
			fs.existsSync(path.join(result.quarantinePath, "MIGRATION-CONFLICT.md")),
		).toBe(true);
		expect(classifyStore(hashed)).toBe("populated");
	});

	it("includes literal/canonical paths and row-count summary in the report", () => {
		const literal = path.join(tmp, "X");
		const hashed = path.join(tmp, "1111111111111111");
		makePopulated(literal);
		makePopulated(hashed);

		const result = quarantineStore({
			cacheRoot: tmp,
			literalKey: "X",
			literalDir: literal,
			canonicalDir: hashed,
		});

		const md = fs.readFileSync(
			path.join(result.quarantinePath, "MIGRATION-CONFLICT.md"),
			"utf8",
		);
		expect(md).toMatch(/canonical hashed dir/i);
		expect(md).toMatch(/1111111111111111/);
		expect(md).toMatch(/memories.*1/i);
	});

	it("preserves the source when EXDEV copy parity fails", () => {
		const literal = path.join(tmp, "PartialCopy");
		const hashed = path.join(tmp, "2222222222222222");
		makePopulated(literal);
		makePopulated(hashed);

		const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(((
			from: fs.PathLike,
			_to: fs.PathLike,
		) => {
			const err: NodeJS.ErrnoException = new Error("cross-device");
			err.code = "EXDEV";
			throw err;
		}) as typeof fs.renameSync);
		const cpSpy = vi
			.spyOn(fs, "cpSync")
			.mockImplementation(((
				_from: fs.PathLike,
				to: fs.PathLike,
				_opts: any,
			) => {
				fs.mkdirSync(to as string, { recursive: true });
			}) as typeof fs.cpSync);

		try {
			expect(() =>
				quarantineStore({
					cacheRoot: tmp,
					literalKey: "PartialCopy",
					literalDir: literal,
					canonicalDir: hashed,
				}),
			).toThrow(/parity/i);
		} finally {
			renameSpy.mockRestore();
			cpSpy.mockRestore();
		}

		expect(fs.existsSync(literal)).toBe(true);
		expect(classifyStore(literal)).toBe("populated");
	});
});

describe("acquireMigrationLock", () => {
	it("acquires when not held", async () => {
		process.env.AI_CORTEX_CACHE_HOME = tmp;
		const result = await acquireMigrationLock("0123456789abcdef", {
			timeoutMs: 1000,
		});
		expect(result.kind).toBe("acquired");
		if (result.kind === "acquired") result.release();
		delete process.env.AI_CORTEX_CACHE_HOME;
	});

	it("blocks a second caller until first releases", async () => {
		process.env.AI_CORTEX_CACHE_HOME = tmp;
		const repoKey = "abcdef0123456789";
		const r1 = await acquireMigrationLock(repoKey, { timeoutMs: 5000 });
		expect(r1.kind).toBe("acquired");

		let acquired2 = false;
		const p2 = (async () => {
			const r = await acquireMigrationLock(repoKey, { timeoutMs: 5000 });
			acquired2 = true;
			if (r.kind === "acquired") r.release();
		})();

		await new Promise((r) => setTimeout(r, 100));
		expect(acquired2).toBe(false);

		if (r1.kind === "acquired") r1.release();
		await p2;
		expect(acquired2).toBe(true);
		delete process.env.AI_CORTEX_CACHE_HOME;
	});

	it("returns sentinel-found when sentinel appears during polling", async () => {
		process.env.AI_CORTEX_CACHE_HOME = tmp;
		const repoKey = "1111111111111111";
		const cacheRoot = tmp;
		const repoDir = path.join(cacheRoot, repoKey);
		fs.mkdirSync(repoDir, { recursive: true });

		const orphan = await acquireMigrationLock(repoKey, { timeoutMs: 5000 });
		expect(orphan.kind).toBe("acquired");
		fs.writeFileSync(
			path.join(repoDir, SENTINEL_NAME),
			JSON.stringify({ migratedAt: "x", outcomes: [] }),
		);

		const result = await acquireMigrationLock(repoKey, {
			timeoutMs: 5000,
			pollMs: 25,
		});
		expect(result.kind).toBe("sentinel-found");

		if (orphan.kind === "acquired") orphan.release();
		delete process.env.AI_CORTEX_CACHE_HOME;
	});

	it("times out only when neither lock nor sentinel becomes available", async () => {
		process.env.AI_CORTEX_CACHE_HOME = tmp;
		const repoKey = "deadbeefcafebabe";
		const r1 = await acquireMigrationLock(repoKey, { timeoutMs: 5000 });

		await expect(
			acquireMigrationLock(repoKey, { timeoutMs: 200, pollMs: 25 }),
		).rejects.toThrow(/timeout/i);

		if (r1.kind === "acquired") r1.release();
		delete process.env.AI_CORTEX_CACHE_HOME;
	});
});

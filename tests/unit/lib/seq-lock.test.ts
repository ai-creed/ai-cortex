// tests/unit/lib/seq-lock.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
	readCanonicalIndexSeq,
	seqDbPathFor,
	setSequenceLockTimeoutForTests,
	withSequenceLock,
} from "../../../src/lib/seq-lock.js";
import { STORE_FORMAT_VERSION } from "../../../src/lib/cache-store-sqlite.js";

let tmpDir: string;
beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-seq-lock-"));
});
afterEach(() => {
	setSequenceLockTimeoutForTests(null);
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("withSequenceLock", () => {
	it("bootstraps the sidecar inside the lock on first use", () => {
		const dbPath = path.join(tmpDir, "wk.db");
		const n = withSequenceLock(dbPath, (seq) => {
			expect(seq.read()).toBe(0);
			seq.write(4);
			return seq.read();
		});
		expect(n).toBe(4);
		expect(withSequenceLock(dbPath, (seq) => seq.read())).toBe(4);
	});

	it("throws an error naming the sidecar path when a holder keeps the lock past the timeout", async () => {
		const dbPath = path.join(tmpDir, "wk.db");
		withSequenceLock(dbPath, () => undefined);
		const seqSrc = path.resolve(process.cwd(), "src/lib/seq-lock.ts").split(path.sep).join("/");
		const holder = path.join(tmpDir, "holder.ts");
		fs.writeFileSync(holder, `
      import { withSequenceLock } from ${JSON.stringify(seqSrc)};
      withSequenceLock(process.argv[2], () => { process.stdout.write("held " + process.pid + "\\n"); const end = Date.now() + 60_000; while (Date.now() < end) {} });
    `);
		const tsxBin = path.resolve(process.cwd(), "node_modules/.bin/tsx");
		const child = spawn(tsxBin, [holder, dbPath], { stdio: ["ignore", "pipe", "ignore"] });
		const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
		let out = "";
		await new Promise<void>((resolve) => child.stdout!.on("data", (d) => { out += d; if (/held \d+\n/.test(out)) resolve(); }));
		// tsx runs the script in a grandchild node process; kill the real lock holder.
		const holderPid = Number(/held (\d+)/.exec(out)![1]);
		try {
			setSequenceLockTimeoutForTests(200);
			let caught: unknown;
			try {
				withSequenceLock(dbPath, () => undefined);
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(Error);
			const e = caught as Error & { cause?: { code?: string } };
			expect(e.message).toContain(seqDbPathFor(dbPath));
			expect(e.message).toContain("index sequence lock timed out");
			expect(e.cause?.code).toBe("SQLITE_BUSY");
		} finally {
			try {
				process.kill(holderPid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
		await closed;
	}, 20_000);
});

describe("readCanonicalIndexSeq", () => {
	function storeWithSeq(value: string): string {
		const dbPath = path.join(tmpDir, `wk-${Math.random().toString(16).slice(2)}.db`);
		const db = new Database(dbPath);
		try {
			db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
			db.prepare("INSERT INTO meta (key, value) VALUES ('indexSeq', ?)").run(value);
			db.pragma(`user_version = ${STORE_FORMAT_VERSION}`);
		} finally {
			db.close();
		}
		return dbPath;
	}

	it("returns a non-negative safe integer as is", () => {
		expect(readCanonicalIndexSeq(storeWithSeq("7"))).toBe(7);
		expect(readCanonicalIndexSeq(storeWithSeq("0"))).toBe(0);
	});

	it.each(["-3", "1.5", "1e300", "9007199254740993", "abc", "Infinity"])("treats %s as 0", (v) => {
		expect(readCanonicalIndexSeq(storeWithSeq(v))).toBe(0);
	});
});

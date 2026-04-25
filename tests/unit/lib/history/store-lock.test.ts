import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLock, releaseLock, lockPath, sessionDir } from "../../../../src/lib/history/store.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-lock-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("acquireLock / releaseLock", () => {
	it("creates lock file on success", () => {
		const result = acquireLock("REPO", "abc");
		expect(result.acquired).toBe(true);
		expect(fs.existsSync(lockPath("REPO", "abc"))).toBe(true);
	});

	it("returns acquired:false when lock already exists with live pid", () => {
		fs.mkdirSync(sessionDir("REPO", "abc"), { recursive: true });
		fs.writeFileSync(lockPath("REPO", "abc"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
		const result = acquireLock("REPO", "abc");
		expect(result.acquired).toBe(false);
		expect((result as Extract<typeof result, { acquired: false }>).reason).toBe("locked");
	});

	it("steals lock when existing pid is dead", () => {
		fs.mkdirSync(sessionDir("REPO", "abc"), { recursive: true });
		const deadPid = 999999;
		fs.writeFileSync(lockPath("REPO", "abc"), JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }));
		const result = acquireLock("REPO", "abc");
		expect(result.acquired).toBe(true);
		expect((result as Extract<typeof result, { acquired: true }>).stoleFrom).toBe(deadPid);
	});

	it("steals lock when existing lock older than 10 minutes", () => {
		fs.mkdirSync(sessionDir("REPO", "abc"), { recursive: true });
		const eleven = new Date(Date.now() - 11 * 60_000).toISOString();
		fs.writeFileSync(lockPath("REPO", "abc"), JSON.stringify({ pid: process.pid, startedAt: eleven }));
		const result = acquireLock("REPO", "abc");
		expect(result.acquired).toBe(true);
		expect((result as Extract<typeof result, { acquired: true }>).stoleFrom).toBe(process.pid);
	});

	it("releaseLock removes the lock file", () => {
		acquireLock("REPO", "abc");
		releaseLock("REPO", "abc");
		expect(fs.existsSync(lockPath("REPO", "abc"))).toBe(false);
	});

	it("releaseLock is idempotent (no-op if absent)", () => {
		expect(() => releaseLock("REPO", "abc")).not.toThrow();
	});
});

// tests/unit/lib/update-notifier.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	shouldCheck,
	compareVersions,
	isCacheStale,
	formatNotice,
	readCache,
	writeCache,
} from "../../../src/lib/update-notifier.js";

describe("compareVersions", () => {
	it("returns -1 when a < b", () => {
		expect(compareVersions("0.4.0", "0.5.0")).toBe(-1);
		expect(compareVersions("0.4.0", "0.4.1")).toBe(-1);
		expect(compareVersions("0.99.99", "1.0.0")).toBe(-1);
	});

	it("returns 1 when a > b", () => {
		expect(compareVersions("0.5.0", "0.4.0")).toBe(1);
		expect(compareVersions("1.0.0", "0.99.0")).toBe(1);
	});

	it("returns 0 when equal", () => {
		expect(compareVersions("0.4.0", "0.4.0")).toBe(0);
	});

	it("treats missing segments as zero", () => {
		expect(compareVersions("0.4", "0.4.0")).toBe(0);
		expect(compareVersions("1", "1.0.0")).toBe(0);
	});

	it("ignores pre-release suffixes (compares numeric prefix only)", () => {
		expect(compareVersions("0.4.0-beta.1", "0.4.0")).toBe(0);
	});
});

describe("shouldCheck", () => {
	const baseEnv = {} as NodeJS.ProcessEnv;

	it("returns true for normal command in TTY without CI/env flags", () => {
		expect(
			shouldCheck({ command: "index", env: baseEnv, isTTY: true }),
		).toBe(true);
	});

	it("skips when CI env var is truthy", () => {
		expect(
			shouldCheck({ command: "index", env: { CI: "true" }, isTTY: true }),
		).toBe(false);
	});

	it("skips when AI_CORTEX_NO_UPDATE_CHECK is set", () => {
		expect(
			shouldCheck({
				command: "index",
				env: { AI_CORTEX_NO_UPDATE_CHECK: "1" },
				isTTY: true,
			}),
		).toBe(false);
	});

	it("skips when not in TTY", () => {
		expect(
			shouldCheck({ command: "index", env: baseEnv, isTTY: false }),
		).toBe(false);
	});

	it.each(["mcp", "--version", "-v", "version", "--help", "-h", "help"])(
		"skips for command '%s'",
		(cmd) => {
			expect(shouldCheck({ command: cmd, env: baseEnv, isTTY: true })).toBe(
				false,
			);
		},
	);

	it("skips for the internal background-fetch flag", () => {
		expect(
			shouldCheck({
				command: "--__internal-update-check",
				env: baseEnv,
				isTTY: true,
			}),
		).toBe(false);
	});
});

describe("isCacheStale", () => {
	const now = Date.parse("2026-05-01T00:00:00Z");

	it("returns false if checked < 24h ago", () => {
		const checkedAt = new Date(now - 23 * 60 * 60 * 1000).toISOString();
		expect(isCacheStale(checkedAt, now)).toBe(false);
	});

	it("returns true if checked > 24h ago", () => {
		const checkedAt = new Date(now - 25 * 60 * 60 * 1000).toISOString();
		expect(isCacheStale(checkedAt, now)).toBe(true);
	});

	it("returns true if checkedAt is invalid", () => {
		expect(isCacheStale("not-a-date", now)).toBe(true);
	});
});

describe("formatNotice", () => {
	it("includes current and latest versions and install command", () => {
		const out = formatNotice("0.4.0", "0.5.0");
		expect(out).toContain("0.4.0");
		expect(out).toContain("0.5.0");
		expect(out).toContain("npm install -g ai-cortex@latest");
	});
});

describe("readCache / writeCache", () => {
	let tmpFile: string;

	beforeEach(() => {
		tmpFile = path.join(
			os.tmpdir(),
			`update-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
		);
	});

	afterEach(() => {
		if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
	});

	it("round-trips cache data", () => {
		writeCache(tmpFile, {
			checkedAt: "2026-05-01T00:00:00Z",
			latestVersion: "0.5.0",
		});
		expect(readCache(tmpFile)).toEqual({
			checkedAt: "2026-05-01T00:00:00Z",
			latestVersion: "0.5.0",
		});
	});

	it("returns null when file doesn't exist", () => {
		expect(readCache("/nonexistent/path/update-cache.json")).toBeNull();
	});

	it("returns null when file is invalid JSON", () => {
		fs.writeFileSync(tmpFile, "not json");
		expect(readCache(tmpFile)).toBeNull();
	});

	it("creates parent directory when writing", () => {
		const nested = path.join(os.tmpdir(), `update-nested-${Date.now()}`, "sub", "cache.json");
		try {
			writeCache(nested, {
				checkedAt: "2026-05-01T00:00:00Z",
				latestVersion: "0.5.0",
			});
			expect(fs.existsSync(nested)).toBe(true);
		} finally {
			fs.rmSync(path.dirname(path.dirname(nested)), { recursive: true, force: true });
		}
	});
});

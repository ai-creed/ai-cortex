// tests/unit/lib/update-notifier.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
	compareSeverity,
	shownTodayUTC,
	checkForUpdate,
	getBriefingNotice,
} from "../../../src/lib/update-notifier.js";

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => ({
		unref: vi.fn(),
		on: vi.fn(),
	})),
}));

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

describe("formatNotice — tier-aware, surface-aware", () => {
	const baseArgs = {
		current: "0.10.0",
		latest: "0.10.1",
		headline: "fix briefing render bug",
	} as const;

	// eslint-disable-next-line no-control-regex
	const ANSI = /\x1b\[[0-9;]*m/;

	it("patch + cli: single line, includes versions, install command, headline", () => {
		const out = formatNotice({
			...baseArgs,
			tier: "patch",
			surface: "cli",
		});
		expect(out).toContain("0.10.1");
		expect(out).toContain("fix briefing render bug");
		expect(out).toContain("npm install -g ai-cortex@latest");
		// patch tier is subtle on CLI — no ANSI bold.
		expect(out).not.toMatch(ANSI);
	});

	it("patch + mcp: same fields, never contains ANSI escapes", () => {
		const out = formatNotice({
			...baseArgs,
			tier: "patch",
			surface: "mcp",
		});
		expect(out).toContain("0.10.1");
		expect(out).toContain("fix briefing render bug");
		expect(out).toContain("npm install -g ai-cortex@latest");
		expect(out).not.toMatch(ANSI);
	});

	it("minor + cli: two-line block with --- rules; contains ANSI bold", () => {
		const out = formatNotice({
			current: "0.10.0",
			latest: "0.11.0",
			headline: "edit-time surfacing",
			tier: "minor",
			surface: "cli",
		});
		expect(out).toContain("---");
		expect(out).toMatch(ANSI);
		expect(out).toContain("0.11.0");
		expect(out).toContain("edit-time surfacing");
	});

	it("minor + mcp: two-line block with --- rules; NO ANSI", () => {
		const out = formatNotice({
			current: "0.10.0",
			latest: "0.11.0",
			headline: "edit-time surfacing",
			tier: "minor",
			surface: "mcp",
		});
		expect(out).toContain("---");
		expect(out).not.toMatch(ANSI);
		expect(out).toContain("0.11.0");
	});

	it("multi-minor + cli: includes 'N minor releases behind' and ANSI bold", () => {
		const out = formatNotice({
			current: "0.9.0",
			latest: "0.11.0",
			headline: "Phase 11 telemetry",
			tier: "multi-minor",
			surface: "cli",
		});
		expect(out).toContain("2 minor releases behind");
		expect(out).toMatch(ANSI);
	});

	it("multi-minor + mcp: includes 'N minor releases behind'; NO ANSI", () => {
		const out = formatNotice({
			current: "0.9.0",
			latest: "0.11.0",
			headline: "Phase 11 telemetry",
			tier: "multi-minor",
			surface: "mcp",
		});
		expect(out).toContain("2 minor releases behind");
		expect(out).not.toMatch(ANSI);
	});

	it("multi-minor when a major is behind: uses 'major version behind' phrasing", () => {
		const out = formatNotice({
			current: "0.99.0",
			latest: "1.0.0",
			headline: "stable API",
			tier: "multi-minor",
			surface: "mcp",
		});
		expect(out).toContain("major version behind");
		expect(out).not.toContain("minor releases behind");
	});

	it("no-headline fallback (patch): no em-dash, no dangling 'available — .'", () => {
		const out = formatNotice({
			current: "0.10.0",
			latest: "0.10.1",
			headline: "",
			tier: "patch",
			surface: "mcp",
		});
		expect(out).toContain("0.10.1 available");
		expect(out).not.toContain("—");
		expect(out).not.toContain("available — .");
		expect(out).toContain("npm install -g ai-cortex@latest");
	});

	it("no-headline fallback (minor): drops headline phrase, no em-dash", () => {
		const out = formatNotice({
			current: "0.10.0",
			latest: "0.11.0",
			headline: "",
			tier: "minor",
			surface: "mcp",
		});
		expect(out).toContain("0.11.0 available");
		expect(out).not.toContain("—");
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

	it("round-trips cache data (legacy two-field)", () => {
		fs.writeFileSync(
			tmpFile,
			JSON.stringify({
				checkedAt: "2026-05-01T00:00:00Z",
				latestVersion: "0.5.0",
			}),
		);
		expect(readCache(tmpFile)).toEqual({
			checkedAt: "2026-05-01T00:00:00Z",
			latestVersion: "0.5.0",
			releaseHeadline: "",
			lastBriefingShownAt: undefined,
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
				releaseHeadline: "",
			});
			expect(fs.existsSync(nested)).toBe(true);
		} finally {
			fs.rmSync(path.dirname(path.dirname(nested)), { recursive: true, force: true });
		}
	});
});

describe("compareSeverity", () => {
	it("returns 'none' when current === latest", () => {
		expect(compareSeverity("0.11.0", "0.11.0")).toBe("none");
	});

	it("returns 'none' when current > latest", () => {
		expect(compareSeverity("0.12.0", "0.11.5")).toBe("none");
		expect(compareSeverity("1.0.0", "0.99.0")).toBe("none");
	});

	it("returns 'patch' when same major.minor and patch behind", () => {
		expect(compareSeverity("0.10.0", "0.10.1")).toBe("patch");
		expect(compareSeverity("0.10.1", "0.10.3")).toBe("patch");
	});

	it("returns 'minor' when exactly 1 minor behind (same major)", () => {
		expect(compareSeverity("0.10.5", "0.11.0")).toBe("minor");
		expect(compareSeverity("0.10.0", "0.11.0")).toBe("minor");
		expect(compareSeverity("0.10.0", "0.11.5")).toBe("minor");
	});

	it("returns 'multi-minor' when 2+ minors behind (same major)", () => {
		expect(compareSeverity("0.9.0", "0.11.0")).toBe("multi-minor");
		expect(compareSeverity("0.9.5", "0.11.0")).toBe("multi-minor");
	});

	it("returns 'multi-minor' when a major is behind", () => {
		expect(compareSeverity("0.99.0", "1.0.0")).toBe("multi-minor");
		expect(compareSeverity("0.5.0", "2.0.0")).toBe("multi-minor");
	});

	it("ignores pre-release suffixes for the comparison", () => {
		expect(compareSeverity("0.10.0-rc.1", "0.11.0-beta.0")).toBe("minor");
		expect(compareSeverity("0.10.0-rc.1", "0.10.0")).toBe("none");
	});
});

describe("readCache / writeCache — extended cache shape", () => {
	let tmpFile: string;

	beforeEach(() => {
		tmpFile = path.join(
			os.tmpdir(),
			`update-cache-ext-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
		);
	});

	afterEach(() => {
		if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
	});

	it("round-trips the four-field shape", () => {
		writeCache(tmpFile, {
			checkedAt: "2026-05-01T00:00:00Z",
			latestVersion: "0.11.0",
			releaseHeadline: "edit-time surfacing + Phase 11",
			lastBriefingShownAt: "2026-05-20T08:00:00Z",
		});
		expect(readCache(tmpFile)).toEqual({
			checkedAt: "2026-05-01T00:00:00Z",
			latestVersion: "0.11.0",
			releaseHeadline: "edit-time surfacing + Phase 11",
			lastBriefingShownAt: "2026-05-20T08:00:00Z",
		});
	});

	it("reads the legacy two-field shape as releaseHeadline='' + lastBriefingShownAt undefined", () => {
		fs.writeFileSync(
			tmpFile,
			JSON.stringify({
				checkedAt: "2026-05-01T00:00:00Z",
				latestVersion: "0.10.0",
			}),
		);
		expect(readCache(tmpFile)).toEqual({
			checkedAt: "2026-05-01T00:00:00Z",
			latestVersion: "0.10.0",
			releaseHeadline: "",
			lastBriefingShownAt: undefined,
		});
	});

	it("omits lastBriefingShownAt from the JSON when undefined", () => {
		writeCache(tmpFile, {
			checkedAt: "2026-05-01T00:00:00Z",
			latestVersion: "0.11.0",
			releaseHeadline: "feat",
		});
		const raw = fs.readFileSync(tmpFile, "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed).toEqual({
			checkedAt: "2026-05-01T00:00:00Z",
			latestVersion: "0.11.0",
			releaseHeadline: "feat",
		});
		expect("lastBriefingShownAt" in parsed).toBe(false);
	});

	it("coerces non-string releaseHeadline to ''", () => {
		fs.writeFileSync(
			tmpFile,
			JSON.stringify({
				checkedAt: "2026-05-01T00:00:00Z",
				latestVersion: "0.11.0",
				releaseHeadline: 42,
			}),
		);
		const cache = readCache(tmpFile);
		expect(cache?.releaseHeadline).toBe("");
	});

	it("preserves an empty-string lastBriefingShownAt in the JSON (not coerced to absent)", () => {
		writeCache(tmpFile, {
			checkedAt: "2026-05-01T00:00:00Z",
			latestVersion: "0.11.0",
			releaseHeadline: "feat",
			lastBriefingShownAt: "",
		});
		const parsed = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
		expect("lastBriefingShownAt" in parsed).toBe(true);
		expect(parsed.lastBriefingShownAt).toBe("");
	});
});

describe("shownTodayUTC", () => {
	const now = Date.parse("2026-05-20T15:00:00Z");

	it("returns false when lastShownAt is undefined", () => {
		expect(shownTodayUTC(undefined, now)).toBe(false);
	});

	it("returns false when lastShownAt is an invalid string", () => {
		expect(shownTodayUTC("not-a-date", now)).toBe(false);
	});

	it("returns true when shown earlier the same UTC day", () => {
		expect(shownTodayUTC("2026-05-20T02:00:00Z", now)).toBe(true);
	});

	it("returns false when shown the previous UTC day", () => {
		expect(shownTodayUTC("2026-05-19T23:59:59Z", now)).toBe(false);
	});

	it("returns false when shown the next UTC day", () => {
		expect(shownTodayUTC("2026-05-21T00:00:01Z", now)).toBe(false);
	});
});

describe("runBackgroundFetch — extracts releaseHeadline and preserves lastBriefingShownAt", () => {
	let tmpHome: string;
	let origFetch: typeof globalThis.fetch;

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "uc-bgfetch-"));
		process.env.AI_CORTEX_CACHE_HOME = tmpHome;
		origFetch = globalThis.fetch;
	});

	afterEach(() => {
		delete process.env.AI_CORTEX_CACHE_HOME;
		fs.rmSync(tmpHome, { recursive: true, force: true });
		globalThis.fetch = origFetch;
	});

	function mockFetch(body: unknown): void {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
	}

	it("persists releaseHeadline from manifest's aiCortex.releaseHeadline", async () => {
		mockFetch({
			version: "0.11.0",
			aiCortex: { releaseHeadline: "edit-time surfacing" },
		});
		const { runBackgroundFetch } = await import(
			"../../../src/lib/update-notifier.js",
		);
		await runBackgroundFetch();
		const cache = readCache(
			path.join(tmpHome, "ai-cortex", "update-check.json"),
		);
		expect(cache?.latestVersion).toBe("0.11.0");
		expect(cache?.releaseHeadline).toBe("edit-time surfacing");
	});

	it("defaults releaseHeadline to '' when missing from manifest", async () => {
		mockFetch({ version: "0.11.0" });
		const { runBackgroundFetch } = await import(
			"../../../src/lib/update-notifier.js",
		);
		await runBackgroundFetch();
		const cache = readCache(
			path.join(tmpHome, "ai-cortex", "update-check.json"),
		);
		expect(cache?.releaseHeadline).toBe("");
	});

	it("defaults releaseHeadline to '' when present but wrong type", async () => {
		mockFetch({ version: "0.11.0", aiCortex: { releaseHeadline: 42 } });
		const { runBackgroundFetch } = await import(
			"../../../src/lib/update-notifier.js",
		);
		await runBackgroundFetch();
		const cache = readCache(
			path.join(tmpHome, "ai-cortex", "update-check.json"),
		);
		expect(cache?.releaseHeadline).toBe("");
	});

	it("preserves lastBriefingShownAt from the prior cache (does not reset throttle)", async () => {
		const p = path.join(tmpHome, "ai-cortex", "update-check.json");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(
			p,
			JSON.stringify({
				checkedAt: "2026-05-19T00:00:00Z",
				latestVersion: "0.10.0",
				releaseHeadline: "old",
				lastBriefingShownAt: "2026-05-20T08:00:00Z",
			}),
		);
		mockFetch({
			version: "0.11.0",
			aiCortex: { releaseHeadline: "new" },
		});
		const { runBackgroundFetch } = await import(
			"../../../src/lib/update-notifier.js",
		);
		await runBackgroundFetch();
		const cache = readCache(p);
		expect(cache?.latestVersion).toBe("0.11.0");
		expect(cache?.releaseHeadline).toBe("new");
		expect(cache?.lastBriefingShownAt).toBe("2026-05-20T08:00:00Z");
	});
});

describe("checkForUpdate — return shape", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "uc-checkforupdate-"));
		process.env.AI_CORTEX_CACHE_HOME = tmpHome;
	});

	afterEach(() => {
		delete process.env.AI_CORTEX_CACHE_HOME;
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});

	it("returns null when no cache yet", () => {
		expect(
			checkForUpdate({ currentVersion: "0.10.0", command: "index" }),
		).toBeNull();
	});

	it("returns { latest, headline, tier } when an upgrade is available", () => {
		const p = path.join(tmpHome, "ai-cortex", "update-check.json");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(
			p,
			JSON.stringify({
				checkedAt: new Date().toISOString(),
				latestVersion: "0.11.0",
				releaseHeadline: "feat",
			}),
		);
		// Make shouldCheck pass: simulate TTY.
		const origIsTTY = process.stdout.isTTY;
		(process.stdout as { isTTY?: boolean }).isTTY = true;
		try {
			const out = checkForUpdate({ currentVersion: "0.10.0", command: "index" });
			expect(out).not.toBeNull();
			expect(out?.latest).toBe("0.11.0");
			expect(out?.headline).toBe("feat");
			expect(out?.tier).toBe("minor");
		} finally {
			(process.stdout as { isTTY?: boolean }).isTTY = origIsTTY;
		}
	});
});

describe("getBriefingNotice", () => {
	let tmpHome: string;
	let cachePathStr: string;

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "uc-briefing-notice-"));
		process.env.AI_CORTEX_CACHE_HOME = tmpHome;
		cachePathStr = path.join(tmpHome, "ai-cortex", "update-check.json");
		delete process.env.AI_CORTEX_NO_UPDATE_CHECK;
	});

	afterEach(() => {
		delete process.env.AI_CORTEX_CACHE_HOME;
		delete process.env.AI_CORTEX_NO_UPDATE_CHECK;
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});

	function plantCache(data: Partial<{
		checkedAt: string;
		latestVersion: string;
		releaseHeadline: string;
		lastBriefingShownAt: string;
	}>): void {
		fs.mkdirSync(path.dirname(cachePathStr), { recursive: true });
		fs.writeFileSync(
			cachePathStr,
			JSON.stringify({
				checkedAt: data.checkedAt ?? new Date().toISOString(),
				latestVersion: data.latestVersion ?? "0.11.0",
				releaseHeadline: data.releaseHeadline ?? "headline",
				...(data.lastBriefingShownAt
					? { lastBriefingShownAt: data.lastBriefingShownAt }
					: {}),
			}),
		);
	}

	it("returns null when AI_CORTEX_NO_UPDATE_CHECK=1 even with a patch behind", () => {
		plantCache({ latestVersion: "0.10.1" });
		process.env.AI_CORTEX_NO_UPDATE_CHECK = "1";
		expect(getBriefingNotice({ currentVersion: "0.10.0" })).toBeNull();
	});

	it("returns null when there is no cache (first run; background fetch is scheduled)", async () => {
		const { spawn } = await import("node:child_process");
		vi.mocked(spawn).mockClear();
		expect(getBriefingNotice({ currentVersion: "0.10.0" })).toBeNull();
		expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
	});

	it("schedules a background fetch when cache is stale (>24h old)", async () => {
		const { spawn } = await import("node:child_process");
		vi.mocked(spawn).mockClear();
		const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
		plantCache({ checkedAt: longAgo, latestVersion: "0.10.0" });
		getBriefingNotice({ currentVersion: "0.10.0" });
		expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
	});

	it("does NOT schedule a background fetch when cache is fresh", async () => {
		const { spawn } = await import("node:child_process");
		vi.mocked(spawn).mockClear();
		plantCache({ checkedAt: new Date().toISOString(), latestVersion: "0.10.0" });
		getBriefingNotice({ currentVersion: "0.10.0" });
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();
	});

	it("returns null when current === latest", () => {
		plantCache({ latestVersion: "0.10.0" });
		expect(getBriefingNotice({ currentVersion: "0.10.0" })).toBeNull();
	});

	it("returns a notice on patch tier with never-shown lastBriefingShownAt + writes lastBriefingShownAt", () => {
		plantCache({ latestVersion: "0.10.1", releaseHeadline: "fix briefing render bug" });
		const notice = getBriefingNotice({ currentVersion: "0.10.0" });
		expect(notice).not.toBeNull();
		expect(notice).toContain("0.10.1");
		expect(notice).toContain("fix briefing render bug");
		const cache = readCache(cachePathStr);
		expect(cache?.lastBriefingShownAt).toBeTruthy();
	});

	it("returns null on patch tier when already shown today UTC", () => {
		const now = new Date();
		plantCache({
			latestVersion: "0.10.1",
			releaseHeadline: "fix",
			lastBriefingShownAt: now.toISOString(),
		});
		expect(getBriefingNotice({ currentVersion: "0.10.0" })).toBeNull();
	});

	it("returns a notice on minor tier and does NOT touch lastBriefingShownAt", () => {
		plantCache({ latestVersion: "0.11.0", releaseHeadline: "minor feat" });
		const notice = getBriefingNotice({ currentVersion: "0.10.5" });
		expect(notice).not.toBeNull();
		expect(notice).toContain("0.11.0");
		const cache = readCache(cachePathStr);
		expect(cache?.lastBriefingShownAt).toBeUndefined();
	});

	it("returns a notice on multi-minor tier with 'N minor releases behind'", () => {
		plantCache({ latestVersion: "0.11.0", releaseHeadline: "two minors" });
		const notice = getBriefingNotice({ currentVersion: "0.9.0" });
		expect(notice).toContain("2 minor releases behind");
	});

	it("falls back to no-headline form when cache.releaseHeadline is empty (no stray em-dash)", () => {
		plantCache({ latestVersion: "0.10.1", releaseHeadline: "" });
		const notice = getBriefingNotice({ currentVersion: "0.10.0" });
		expect(notice).toContain("0.10.1 available");
		expect(notice).not.toContain("—");
	});

	it("returns plain text (no ANSI escape sequences) for MCP surface", () => {
		plantCache({ latestVersion: "0.11.0", releaseHeadline: "feat" });
		const notice = getBriefingNotice({ currentVersion: "0.10.5" });
		// eslint-disable-next-line no-control-regex
		expect(notice).not.toMatch(/\x1b\[[0-9;]*m/);
	});

	it("returns null (does not throw) when the cache file is corrupted", () => {
		fs.mkdirSync(path.dirname(cachePathStr), { recursive: true });
		fs.writeFileSync(cachePathStr, "not json {");
		expect(() =>
			getBriefingNotice({ currentVersion: "0.10.0" }),
		).not.toThrow();
		expect(getBriefingNotice({ currentVersion: "0.10.0" })).toBeNull();
	});
});

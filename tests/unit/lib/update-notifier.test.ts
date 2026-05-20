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
	compareSeverity,
	shownTodayUTC,
	checkForUpdate,
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

describe("formatNotice — tier-aware, surface-aware", () => {
	const baseArgs = {
		current: "0.10.0",
		latest: "0.10.1",
		headline: "fix briefing render bug",
	} as const;

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

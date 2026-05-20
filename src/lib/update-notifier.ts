// src/lib/update-notifier.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const REGISTRY_URL = "https://registry.npmjs.org/ai-cortex/latest";
const INSTALL_COMMAND = "npm install -g ai-cortex@latest";

export const INTERNAL_UPDATE_CHECK_FLAG = "--__internal-update-check";

const SKIP_COMMANDS = new Set([
	"mcp",
	"--version",
	"-v",
	"version",
	"--help",
	"-h",
	"help",
	INTERNAL_UPDATE_CHECK_FLAG,
]);

export type CacheData = {
	checkedAt: string;
	latestVersion: string;
	releaseHeadline: string;
	lastBriefingShownAt?: string;
};

export function cachePath(): string {
	const home =
		process.env.AI_CORTEX_CACHE_HOME ?? path.join(os.homedir(), ".cache");
	return path.join(home, "ai-cortex", "update-check.json");
}

export function shouldCheck(opts: {
	command: string;
	env: NodeJS.ProcessEnv;
	isTTY: boolean;
}): boolean {
	if (opts.env.CI) return false;
	if (opts.env.AI_CORTEX_NO_UPDATE_CHECK) return false;
	if (!opts.isTTY) return false;
	if (SKIP_COMMANDS.has(opts.command)) return false;
	return true;
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
	const numericPrefix = (v: string): number[] =>
		v
			.split("-")[0]
			.split(".")
			.map((n) => Number.parseInt(n, 10) || 0);
	const partsA = numericPrefix(a);
	const partsB = numericPrefix(b);
	const len = Math.max(partsA.length, partsB.length);
	for (let i = 0; i < len; i++) {
		const av = partsA[i] ?? 0;
		const bv = partsB[i] ?? 0;
		if (av < bv) return -1;
		if (av > bv) return 1;
	}
	return 0;
}

export type Severity = "none" | "patch" | "minor" | "multi-minor";

export function compareSeverity(current: string, latest: string): Severity {
	const parse = (v: string): number[] =>
		v
			.split("-")[0]
			.split(".")
			.map((n) => Number.parseInt(n, 10) || 0);
	const c = parse(current);
	const l = parse(latest);
	const cMajor = c[0] ?? 0,
		cMinor = c[1] ?? 0,
		cPatch = c[2] ?? 0;
	const lMajor = l[0] ?? 0,
		lMinor = l[1] ?? 0,
		lPatch = l[2] ?? 0;

	if (cMajor > lMajor) return "none";
	if (cMajor === lMajor && cMinor > lMinor) return "none";
	if (cMajor === lMajor && cMinor === lMinor && cPatch >= lPatch) return "none";

	if (cMajor < lMajor) return "multi-minor";
	if (lMinor - cMinor >= 2) return "multi-minor";
	if (lMinor - cMinor === 1) return "minor";
	return "patch";
}

export function isCacheStale(
	checkedAt: string,
	now: number = Date.now(),
): boolean {
	const t = new Date(checkedAt).getTime();
	if (!Number.isFinite(t)) return true;
	return now - t > CACHE_TTL_MS;
}

export function shownTodayUTC(
	lastShownAt: string | undefined,
	now: number = Date.now(),
): boolean {
	if (!lastShownAt) return false;
	const t = new Date(lastShownAt).getTime();
	if (!Number.isFinite(t)) return false;
	return Math.floor(t / 86_400_000) === Math.floor(now / 86_400_000);
}

export function readCache(filePath: string): CacheData | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<CacheData> & Record<string, unknown>;
		if (
			typeof parsed?.checkedAt !== "string" ||
			typeof parsed?.latestVersion !== "string"
		) {
			return null;
		}
		return {
			checkedAt: parsed.checkedAt,
			latestVersion: parsed.latestVersion,
			releaseHeadline:
				typeof parsed.releaseHeadline === "string"
					? parsed.releaseHeadline
					: "",
			lastBriefingShownAt:
				typeof parsed.lastBriefingShownAt === "string"
					? parsed.lastBriefingShownAt
					: undefined,
		};
	} catch {
		return null;
	}
}

export function writeCache(filePath: string, data: CacheData): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const out: Record<string, string> = {
		checkedAt: data.checkedAt,
		latestVersion: data.latestVersion,
		releaseHeadline: data.releaseHeadline,
	};
	if (data.lastBriefingShownAt !== undefined) {
		out.lastBriefingShownAt = data.lastBriefingShownAt;
	}
	fs.writeFileSync(filePath, JSON.stringify(out));
}

function minorsOrMajorBehind(current: string, latest: string): {
	mode: "major" | "minor";
	count: number;
} {
	const parse = (v: string): number[] =>
		v
			.split("-")[0]
			.split(".")
			.map((n) => Number.parseInt(n, 10) || 0);
	const c = parse(current);
	const l = parse(latest);
	if ((c[0] ?? 0) < (l[0] ?? 0)) {
		return { mode: "major", count: (l[0] ?? 0) - (c[0] ?? 0) };
	}
	return { mode: "minor", count: (l[1] ?? 0) - (c[1] ?? 0) };
}

export function formatNotice(opts: {
	current: string;
	latest: string;
	headline: string;
	tier: Exclude<Severity, "none">;
	surface: "cli" | "mcp";
}): string {
	const { current, latest, headline, tier, surface } = opts;
	const useAnsi = surface === "cli";
	const bold = (s: string): string => (useAnsi ? `\x1b[1m${s}\x1b[0m` : s);
	const headlinePart = headline ? ` — ${headline}` : "";
	const installLine = `Run: ${INSTALL_COMMAND}`;

	if (tier === "patch") {
		return `\nai-cortex ${latest} available${headlinePart}. ${installLine}\n`;
	}

	if (tier === "minor") {
		const title = bold(`ai-cortex ${latest} available${headlinePart}`);
		return `\n---\n${title}\n${installLine}\n---\n`;
	}

	// multi-minor
	const { mode, count } = minorsOrMajorBehind(current, latest);
	const behindLine =
		mode === "major"
			? `you are a major version behind`
			: `you are ${count} minor releases behind`;
	const title = bold(`ai-cortex ${latest} available${headlinePart}`);
	return `\n---\n${title}\n${behindLine}\n${installLine}\n---\n`;
}

export function checkForUpdate(opts: {
	currentVersion: string;
	command: string;
}): { latest: string; headline: string; tier: Exclude<Severity, "none"> } | null {
	if (
		!shouldCheck({
			command: opts.command,
			env: process.env,
			isTTY: process.stdout.isTTY ?? false,
		})
	) {
		return null;
	}

	const cache = readCache(cachePath());

	if (!cache || isCacheStale(cache.checkedAt)) {
		spawnBackgroundFetch();
	}

	if (!cache) return null;

	const tier = compareSeverity(opts.currentVersion, cache.latestVersion);
	if (tier === "none") return null;

	return {
		latest: cache.latestVersion,
		headline: cache.releaseHeadline,
		tier,
	};
}

function spawnBackgroundFetch(): void {
	try {
		const cliPath = process.argv[1];
		if (!cliPath) return;
		const child = spawn(
			process.execPath,
			[cliPath, INTERNAL_UPDATE_CHECK_FLAG],
			{
				detached: true,
				stdio: "ignore",
				env: { ...process.env, AI_CORTEX_NO_UPDATE_CHECK: "1" },
			},
		);
		child.unref();
	} catch {
		// best-effort: never fail the main command on update-check setup
	}
}

export async function runBackgroundFetch(): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(REGISTRY_URL, { signal: controller.signal });
		if (!res.ok) return;
		const data = (await res.json()) as {
			version?: unknown;
			aiCortex?: { releaseHeadline?: unknown } | unknown;
		};
		if (typeof data.version !== "string") return;
		const releaseHeadline =
			typeof data.aiCortex === "object" &&
			data.aiCortex !== null &&
			typeof (data.aiCortex as { releaseHeadline?: unknown })
				.releaseHeadline === "string"
				? (data.aiCortex as { releaseHeadline: string }).releaseHeadline
				: "";
		const prior = readCache(cachePath());
		writeCache(cachePath(), {
			checkedAt: new Date().toISOString(),
			latestVersion: data.version,
			releaseHeadline,
			lastBriefingShownAt: prior?.lastBriefingShownAt,
		});
	} catch {
		// network errors, timeouts, parse errors — silent
	} finally {
		clearTimeout(timer);
	}
}

export function getBriefingNotice(opts: {
	currentVersion: string;
}): string | null {
	try {
		if (process.env.AI_CORTEX_NO_UPDATE_CHECK) return null;
		const cp = cachePath();
		const cache = readCache(cp);
		if (!cache || isCacheStale(cache.checkedAt)) {
			spawnBackgroundFetch();
		}
		if (!cache) return null;
		const tier = compareSeverity(opts.currentVersion, cache.latestVersion);
		if (tier === "none") return null;
		if (tier === "patch" && shownTodayUTC(cache.lastBriefingShownAt)) {
			return null;
		}
		if (tier === "patch") {
			writeCache(cp, {
				...cache,
				lastBriefingShownAt: new Date().toISOString(),
			});
		}
		return formatNotice({
			current: opts.currentVersion,
			latest: cache.latestVersion,
			headline: cache.releaseHeadline,
			tier,
			surface: "mcp",
		});
	} catch {
		return null;
	}
}

export function printUpdateNotice(
	current: string,
	info: { latest: string; headline: string; tier: Exclude<Severity, "none"> },
): void {
	process.stderr.write(
		formatNotice({
			current,
			latest: info.latest,
			headline: info.headline,
			tier: info.tier,
			surface: "cli",
		}),
	);
}

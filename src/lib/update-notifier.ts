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

export function isCacheStale(
	checkedAt: string,
	now: number = Date.now(),
): boolean {
	const t = new Date(checkedAt).getTime();
	if (!Number.isFinite(t)) return true;
	return now - t > CACHE_TTL_MS;
}

export function readCache(filePath: string): CacheData | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (
			typeof parsed?.checkedAt !== "string" ||
			typeof parsed?.latestVersion !== "string"
		) {
			return null;
		}
		return parsed as CacheData;
	} catch {
		return null;
	}
}

export function writeCache(filePath: string, data: CacheData): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(data));
}

export function formatNotice(current: string, latest: string): string {
	return `\nai-cortex update available: ${current} → ${latest}\n  run: ${INSTALL_COMMAND}\n`;
}

export function checkForUpdate(opts: {
	currentVersion: string;
	command: string;
}): string | null {
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
	let availableVersion: string | null = null;

	if (cache && compareVersions(opts.currentVersion, cache.latestVersion) < 0) {
		availableVersion = cache.latestVersion;
	}

	if (!cache || isCacheStale(cache.checkedAt)) {
		spawnBackgroundFetch();
	}

	return availableVersion;
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
		const data = (await res.json()) as { version?: unknown };
		if (typeof data.version !== "string") return;
		writeCache(cachePath(), {
			checkedAt: new Date().toISOString(),
			latestVersion: data.version,
		});
	} catch {
		// network errors, timeouts, parse errors — silent
	} finally {
		clearTimeout(timer);
	}
}

export function printUpdateNotice(current: string, latest: string): void {
	process.stderr.write(formatNotice(current, latest));
}

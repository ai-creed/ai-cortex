// src/lib/memory/auto-sweep.ts
// Spec §4.4: opportunistic aging sweep at rehydrate — default-on, opt-out,
// at most one attempt per 24h per repo, and NEVER able to break rehydrate.
import fs from "node:fs/promises";
import path from "node:path";
import { memoryRootDir } from "./paths.js";
import { loadMemoryConfig } from "./config.js";
import { sweepAging } from "./aging.js";
import type { AgingSweepReport } from "./aging.js";

const SENTINEL = ".last-auto-sweep";
const DAY_MS = 86_400_000;

export async function runAutoSweepIfDue(
	repoKey: string,
	deps: { sweep: (rk: string) => Promise<AgingSweepReport> } = {
		sweep: (rk) => sweepAging(rk),
	},
): Promise<"ran" | "skipped-recent" | "disabled"> {
	const cfg = await loadMemoryConfig(repoKey);
	if (!cfg.aging.autoSweep) return "disabled";

	const root = memoryRootDir(repoKey);
	const sentinel = path.join(root, SENTINEL);
	try {
		const stamp = Date.parse((await fs.readFile(sentinel, "utf8")).trim());
		if (Number.isFinite(stamp) && Date.now() - stamp < DAY_MS) {
			return "skipped-recent";
		}
	} catch {
		// missing/unreadable sentinel → due now
	}

	// Stamp BEFORE sweeping: a failing sweep must not retry on every
	// rehydrate (one attempt per day, spec §4.4).
	await fs.mkdir(root, { recursive: true });
	await fs.writeFile(sentinel, new Date().toISOString() + "\n");
	try {
		await deps.sweep(repoKey);
	} catch (err) {
		console.error(`[ai-cortex] auto-sweep failed: ${String(err)}`);
	}
	return "ran";
}

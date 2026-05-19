import fs from "node:fs";
import path from "node:path";
import { memoryRootDir } from "./paths.js";
import {
	openLifecycle,
	deprecateMemory,
	retypeCandidate,
} from "./lifecycle.js";
import { structuralReject } from "./gate.js";
import { readMemoryFile } from "./store.js";

const SENTINEL = ".capture-triage-v1.done";

/**
 * One-shot, sentinel-guarded legacy triage. Selects extracted candidates,
 * deprecates structural noise, and retypes survivors to `capture`.
 *
 * Ordering guarantee: `openLifecycle` funnels through `ensureRegistry`
 * (lifecycle.ts:48), so the `capture` seed-merge has applied before any
 * `retypeCandidate(..., "capture")`. No explicit `ensureRegistry` needed.
 *
 * Fault isolation: an index-open failure aborts WITHOUT writing the sentinel
 * (logged, retried next rehydrate). Per-row read/deprecate/retype failures are
 * caught, logged to stderr, and skipped — they never abort the batch or block
 * the sentinel.
 */
export async function runCaptureTriageIfNeeded(repoKey: string): Promise<void> {
	const root = memoryRootDir(repoKey);
	const sentinel = path.join(root, SENTINEL);
	if (!fs.existsSync(root)) return; // no memory store — nothing to triage
	if (fs.existsSync(sentinel)) return; // already done

	// Whole-run guard: an index-open failure aborts WITHOUT writing the
	// sentinel (retried next rehydrate). Per-row failures are isolated below
	// and must NOT abort the batch or block the sentinel.
	let lc;
	try {
		lc = await openLifecycle(repoKey); // ensureRegistry runs here → capture type present (ordering guarantee)
	} catch (e) {
		process.stderr.write(
			`[ai-cortex] capture-triage: index open failed, will retry next rehydrate: ${
				e instanceof Error ? e.message : String(e)
			}\n`,
		);
		return; // no sentinel — retry next time
	}
	try {
		const rows = lc.index
			.rawDb()
			.prepare(
				"SELECT id FROM memories WHERE source='extracted' AND status='candidate'",
			)
			.all() as { id: string }[];
		for (const { id } of rows) {
			// Per-row fault isolation: a bad/locked single row must not abort
			// the whole one-shot (which would also block the sentinel forever).
			try {
				const body = (await readMemoryFile(repoKey, id, "memories")).body;
				if (structuralReject(body) !== null) {
					await deprecateMemory(lc, id, "legacy triage: structural noise");
				} else {
					await retypeCandidate(lc, id, "capture");
				}
			} catch (e) {
				process.stderr.write(
					`[ai-cortex] capture-triage: skipping ${id}: ${
						e instanceof Error ? e.message : String(e)
					}\n`,
				);
				continue;
			}
		}
	} finally {
		lc.close();
	}
	fs.writeFileSync(sentinel, new Date().toISOString() + "\n");
}

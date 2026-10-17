// scripts/consumer-ingest-probe.mts
// Usage (cwd = ai-14all worktree): tsx <this file> <store.db> [<store.db> ...]
// Prints a JSON array: one entry per store with the consumer's IngestResult plus
// schemaVersion and whether the mirror received CortexIndexService.findDefinitions.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const { ingestCortexStore } = await import(pathToFileURL(resolve(cwd, "electron/code-nav/ingest/cortex-store-to-mirror.ts")).href);
const { default: Database } = await import(pathToFileURL(resolve(cwd, "node_modules/better-sqlite3/lib/index.js")).href);

const out: unknown[] = [];
for (const store of process.argv.slice(2)) {
	const dir = mkdtempSync(join(tmpdir(), "consumer-ingest-probe-"));
	try {
		const mirror = join(dir, "mirror.sqlite");
		const result = ingestCortexStore(store, mirror) as { unavailable?: true; skipped?: boolean; functionsCount?: number; schemaVersion?: string };
		const src = new Database(store, { readonly: true });
		const schemaVersion = (src.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get() as { value: string } | undefined)?.value;
		src.close();
		let hasFindDefinitions = false;
		if (!result.unavailable) {
			const m = new Database(mirror, { readonly: true });
			hasFindDefinitions = (m.prepare("SELECT count(*) c FROM functions WHERE qualified_name = 'CortexIndexService.findDefinitions' AND bare_name = 'findDefinitions'").get() as { c: number }).c === 1;
			m.close();
		}
		out.push({ ...result, schemaVersion, hasFindDefinitions });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
process.stdout.write(JSON.stringify(out));

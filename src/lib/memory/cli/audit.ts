// src/lib/memory/cli/audit.ts
import { openRetrieve, auditMemory } from "../retrieve.js";

type AuditArgs = { id: string; json: boolean };

function parseAuditArgs(args: string[]): AuditArgs {
	let id: string | undefined;
	let json = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--json") { json = true; continue; }
		if (!a.startsWith("--") && !id) { id = a; continue; }
	}
	if (!id) throw new Error("required: <id>");
	return { id, json };
}

export async function runMemoryAudit(args: string[], opts: {
	repoKey: string;
	stdout?: NodeJS.WriteStream;
} = { repoKey: "" }): Promise<number> {
	try {
		const parsed = parseAuditArgs(args);
		const rh = openRetrieve(opts.repoKey);
		try {
			const rows = auditMemory(rh, parsed.id);
			const out = opts.stdout ?? process.stdout;
			if (parsed.json) {
				out.write(JSON.stringify(rows, null, 2) + "\n");
			} else {
				for (const row of rows) {
					out.write(`${row.ts}  ${row.changeType}  ${row.reason ?? ""}\n`);
				}
			}
			return 0;
		} finally {
			rh.close();
		}
	} catch (err) {
		process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
		return 1;
	}
}

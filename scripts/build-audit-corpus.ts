// scripts/build-audit-corpus.ts
// One-off extractor for the 2026-06-08 capture-audit corpus.
// Reads the four workspace memory stores under ~/.cache/ai-cortex/v1 and
// prints JSON to stdout: { keepers: string[], noise: {workspace, body}[] }.
// Keeper bodies come from memory_audit.prev_body (the pre-rewrite raw
// capture); noise bodies come from the deprecated rows' markdown files.
// Run: pnpm tsx scripts/build-audit-corpus.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import yaml from "js-yaml";

// The audit doc is dated 2026-06-08, but the deprecate/retype operations
// landed on 2026-06-07 (verified against memory_audit ts and updated_at).
const AUDIT_DAY = "2026-06-07";
const WORKSPACES: Record<string, string> = {
	"ai-14all": "17b0417aad28af9d",
	"ai-cortex": "23e43a8a0e67b163",
	"ai-whisper": "49f95c828e9afa41",
	"ai-ezio": "905d135ae930c5ee",
};

function memoryDir(repoKey: string): string {
	return path.join(os.homedir(), ".cache", "ai-cortex", "v1", repoKey, "memory");
}

function stripFrontmatter(md: string): string {
	const m = /^---\n[\s\S]*?\n---\n/.exec(md);
	return (m ? md.slice(m[0].length) : md).trim();
}

const keepers: { workspace: string; body: string }[] = [];
const noise: { workspace: string; body: string }[] = [];

for (const [ws, repoKey] of Object.entries(WORKSPACES)) {
	const db = new Database(path.join(memoryDir(repoKey), "index.sqlite"), {
		readonly: true,
	});
	try {
		const noiseRows = db
			.prepare(
				`SELECT id FROM memories
				 WHERE type='capture' AND status='deprecated' AND date(updated_at)=?`,
			)
			.all(AUDIT_DAY) as { id: string }[];
		for (const r of noiseRows) {
			const p = path.join(memoryDir(repoKey), "memories", `${r.id}.md`);
			if (!fs.existsSync(p)) continue;
			noise.push({ workspace: ws, body: stripFrontmatter(fs.readFileSync(p, "utf8")) });
		}
		// Keepers = rewritten during the audit, ANY current status (one keeper
		// was deprecated later). type=capture rows have no auditPreserveBody,
		// so the pre-rewrite raw text is not in memory_audit.prev_body; the
		// closest recoverable artifact is provenance[0].excerpt (the original
		// user-prompt excerpt, occasionally truncated) in the markdown
		// frontmatter.
		const keeperRows = db
			.prepare(
				`SELECT id FROM memories
				 WHERE source='extracted' AND date(rewritten_at)=?`,
			)
			.all(AUDIT_DAY) as { id: string }[];
		for (const r of keeperRows) {
			const p = path.join(memoryDir(repoKey), "memories", `${r.id}.md`);
			if (!fs.existsSync(p)) continue;
			const md = fs.readFileSync(p, "utf8");
			const fmMatch = /^---\n([\s\S]*?)\n---\n/.exec(md);
			if (!fmMatch) continue;
			const fm = yaml.load(fmMatch[1]!) as {
				provenance?: { excerpt?: string }[];
			};
			const excerpt = fm.provenance?.[0]?.excerpt;
			if (excerpt) keepers.push({ workspace: ws, body: excerpt });
		}
	} finally {
		db.close();
	}
}

process.stderr.write(
	`keepers=${keepers.length} (expect 11) noise=${noise.length} (expect 128)\n`,
);
if (keepers.length !== 11 || noise.length !== 128) {
	process.stderr.write(
		"COUNTS DIFFER FROM AUDIT — inspect per-workspace counts and adjust the date filter or selectors before using this output.\n",
	);
}
process.stdout.write(JSON.stringify({ keepers, noise }, null, 2) + "\n");

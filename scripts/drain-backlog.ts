// scripts/drain-backlog.ts
// P2 one-time backlog drain: retroactively applies the intake gate to every
// stored candidate capture across all buckets. Dry-run by default; --apply
// trashes matches via lifecycle (audited, 90-day restorable) with reason
// DRAIN_REASON. Keeper-labeled corpus bodies are exempt from auto-action.
// Run:
//   pnpm exec tsx scripts/drain-backlog.ts [--apply] [--report <file.md>]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { decideDrain, DRAIN_REASON } from "../src/lib/memory/drain.js";
import { openLifecycle, trashMemory } from "../src/lib/memory/lifecycle.js";
import { listMemoryFiles, readMemoryFile } from "../src/lib/memory/store.js";
import { routedPromptFromBody } from "../src/lib/memory/extract.js";
import {
	KEEPERS,
	AUDIT_KEEPERS,
	HARVEST_KEEPERS,
} from "../tests/fixtures/memory-capture-corpus.js";

const V1 = path.join(os.homedir(), ".cache", "ai-cortex", "v1");
const apply = process.argv.includes("--apply");
const reportFlag = process.argv.indexOf("--report");
const reportPath = reportFlag !== -1 ? process.argv[reportFlag + 1] : null;

const keeperBodies = new Set(
	[...KEEPERS, ...AUDIT_KEEPERS, ...HARVEST_KEEPERS].map((b) => b.trim()),
);

type Survivor = {
	bucket: string;
	id: string;
	title: string;
	type: string;
	confidence: number | null;
	prompt: string;
	why: string;
};

type TrashRow = { bucket: string; id: string; title: string; rule: string };

async function main(): Promise<void> {
	const trashRows: TrashRow[] = [];
	const survivors: Survivor[] = [];
	const typedCandidates: Survivor[] = [];
	const ruleCounts: Record<string, number> = {};
	let buckets = 0;
	let candidateCaptures = 0;

	for (const entry of fs.readdirSync(V1)) {
		const memDir = path.join(V1, entry, "memory", "memories");
		if (!fs.existsSync(memDir)) continue;
		buckets++;
		const bucketTrash: string[] = [];
		for (const file of await listMemoryFiles(entry)) {
			if (file.location !== "memories") continue;
			const rec = await readMemoryFile(entry, file.id, "memories");
			const { status, type, title, confidence } = rec.frontmatter;
			if (status !== "candidate") continue;
			if (type !== "capture") {
				typedCandidates.push({
					bucket: entry,
					id: file.id,
					title,
					type,
					confidence: confidence ?? null,
					prompt: routedPromptFromBody(rec.body).slice(0, 200),
					why: "typed-candidate",
				});
				continue;
			}
			candidateCaptures++;
			const decision = decideDrain(
				{ status, type, body: rec.body },
				keeperBodies,
			);
			if (decision.action === "trash") {
				ruleCounts[decision.rule] = (ruleCounts[decision.rule] ?? 0) + 1;
				trashRows.push({ bucket: entry, id: file.id, title, rule: decision.rule });
				bucketTrash.push(file.id);
			} else {
				survivors.push({
					bucket: entry,
					id: file.id,
					title,
					type,
					confidence: confidence ?? null,
					prompt: routedPromptFromBody(rec.body).slice(0, 200),
					why: decision.why,
				});
			}
		}
		if (apply && bucketTrash.length > 0) {
			const lc = await openLifecycle(entry, { agentId: "drain-backlog-script" });
			try {
				for (const id of bucketTrash) {
					await trashMemory(lc, id, DRAIN_REASON);
				}
			} finally {
				lc.close();
			}
		}
	}

	const keeperExempt = survivors.filter((s) => s.why === "keeper-exempt").length;
	console.log(`mode: ${apply ? "APPLY" : "dry-run"}`);
	console.log(`buckets: ${buckets}`);
	console.log(`candidate captures: ${candidateCaptures}`);
	console.log(
		`trash: ${trashRows.length}  (${Object.entries(ruleCounts)
			.sort((a, b) => b[1] - a[1])
			.map(([r, n]) => `${r}=${n}`)
			.join(", ")})`,
	);
	console.log(
		`survivors: ${survivors.length} captures (${keeperExempt} keeper-exempt) + ${typedCandidates.length} typed candidates`,
	);
	const promoteReady = typedCandidates.filter(
		(t) => (t.confidence ?? 0) >= 0.9,
	);
	console.log(`promotion shortlist (typed, conf>=0.9): ${promoteReady.length}`);

	if (reportPath) {
		// Human-pass order per plan: typed candidates first (confidence desc),
		// then surviving captures grouped by bucket.
		typedCandidates.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
		survivors.sort((a, b) =>
			a.bucket === b.bucket ? a.id.localeCompare(b.id) : a.bucket.localeCompare(b.bucket),
		);
		const lines: string[] = [
			`# Backlog drain survivor review — ${new Date().toISOString().slice(0, 10)}`,
			"",
			`Mode: ${apply ? "APPLY" : "dry-run"}. Trashed ${trashRows.length} of ${candidateCaptures} candidate captures (reason \`${DRAIN_REASON}\`, 90-day restorable). Below is the human review pass: typed candidates sorted by confidence, then surviving captures.`,
			"",
			`## Typed candidates (${typedCandidates.length}; promote conf>=0.9, retype or deprecate the rest)`,
			"",
		];
		for (const t of typedCandidates) {
			lines.push(
				`- [ ] \`${t.id}\` (${t.bucket}, ${t.type}, conf ${t.confidence ?? "—"}) — ${t.title}`,
			);
		}
		lines.push("", `## Surviving captures (${survivors.length})`, "");
		for (const s of survivors) {
			lines.push(
				`- [ ] \`${s.id}\` (${s.bucket}${s.why === "keeper-exempt" ? ", keeper-exempt" : ""}) — ${s.title}`,
				`  > ${s.prompt.replace(/\s+/g, " ")}`,
			);
		}
		fs.writeFileSync(reportPath, `${lines.join("\n")}\n`);
		console.log(`report written: ${reportPath}`);
	}
}

void main();

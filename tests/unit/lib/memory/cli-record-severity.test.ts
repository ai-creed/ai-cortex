import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runMemoryRecord } from "../../../../src/lib/memory/cli/record.js";
import { readMemoryFile } from "../../../../src/lib/memory/store.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";

describe("CLI memory record — gotcha severity default", () => {
	let repoKey: string;
	beforeEach(async () => {
		repoKey = await mkRepoKey("cli-record-sev");
	});
	afterEach(async () => {
		await cleanupRepo(repoKey);
	});

	it("records a gotcha without typeFields and defaults severity=warning", async () => {
		const bodyFile = path.join(os.tmpdir(), `gotcha-body-${process.pid}.md`);
		await fs.writeFile(bodyFile, "Symptom: tests hang.\nCause: stale daemon.");
		const chunks: string[] = [];
		const code = await runMemoryRecord(
			["--type", "gotcha", "--title", "stale daemon hang", "--body-file", bodyFile],
			{
				repoKey,
				stdout: {
					write: (s: string) => (chunks.push(s), true),
				} as unknown as NodeJS.WriteStream,
			},
		);
		expect(code).toBe(0);
		const id = chunks.join("").trim();
		const rec = await readMemoryFile(repoKey, id, "memories");
		expect(rec.frontmatter.typeFields).toEqual({ severity: "warning" });
		await fs.rm(bodyFile, { force: true });
	});
});

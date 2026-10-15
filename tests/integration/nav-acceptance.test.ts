// tests/integration/nav-acceptance.test.ts
// Mirrors section 11 of the ai-14all upstream request against a fixture so the
// consumer's acceptance checks run in CI. The real-repository run is
// scripts/acceptance-v3.2.sh (release gate).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexRepo } from "../../src/lib/indexer.js";
import { getCacheDbFilePath } from "../../src/lib/cache-store.js";
import { resolveRepoIdentity } from "../../src/lib/repo-identity.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/nav-acceptance");
const OLD_STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/stores/v3.1-nav-acceptance.db");
const SVC = "electron/code-nav/cortex-index-service.ts";
let dir: string;
let db: InstanceType<typeof Database>;

/** Runs scripts/consumer-ingest-probe.mts inside the ai-14all worktree with its
 *  own tsx and better-sqlite3, so the consumer's real ingestCortexStore runs. */
function runConsumerIngest(worktree: string, stores: string[]): Array<{ schemaVersion?: string; unavailable?: true; functionsCount?: number; hasFindDefinitions?: boolean }> {
	const probe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/consumer-ingest-probe.mts");
	const stdout = execFileSync(path.join(worktree, "node_modules/.bin/tsx"), [probe, ...stores], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	return JSON.parse(stdout);
}

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-nav-acc-"));
	fs.cpSync(FIXTURE, dir, { recursive: true });
	for (const a of [["init"], ["config", "user.email", "t@t"], ["config", "user.name", "T"], ["config", "commit.gpgsign", "false"], ["add", "."], ["commit", "-m", "init"]]) execFileSync("git", ["-C", dir, ...a]);
	await indexRepo(dir);
	const id = resolveRepoIdentity(dir);
	db = new Database(getCacheDbFilePath(id.repoKey, id.worktreeKey), { readonly: true });
});
afterAll(() => { db?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T;

describe("consumer acceptance (upstream request section 11)", () => {
	it("symbols has interface rows; WorktreeStatus name range starts on the declaration line after its start", () => {
		expect(one<{ c: number }>("SELECT count(*) c FROM symbols WHERE kind='interface'").c).toBeGreaterThan(0);
		const r = one<{ line: number; col: number; name_line: number; name_col: number }>("SELECT line, col, name_line, name_col FROM symbols WHERE file=? AND name='WorktreeStatus'", SVC);
		expect(r.name_line).toBe(r.line);
		expect(r.name_col).toBeGreaterThan(r.col);
	});

	it("CortexIndexService.findDefinitions row has kind, name, container_key, qualified_name", () => {
		const cls = one<{ key: string }>("SELECT key FROM symbols WHERE file=? AND qualified_name='CortexIndexService'", SVC);
		const m = one<{ kind: string; name: string; container_key: string; qualified_name: string }>("SELECT kind, name, container_key, qualified_name FROM symbols WHERE file=? AND qualified_name='CortexIndexService.findDefinitions'", SVC);
		expect(m).toEqual({ kind: "method", name: "findDefinitions", container_key: cls.key, qualified_name: "CortexIndexService.findDefinitions" });
	});

	it("every functions row has a symbols row with the same key and declaration range", () => {
		const missing = db.prepare(`SELECT f.file, f.qualified_name FROM functions f LEFT JOIN symbols s
			ON s.key = f.file || '::' || f.qualified_name AND s.line = f.line AND s.col = f.col AND s.end_line = f.end_line AND s.end_col = f.end_col
			WHERE s.key IS NULL`).all();
		expect(missing).toEqual([]);
	});

	// Same metric as the release gate: externals (globals, package types) stay
	// NULL by contract, so the ratio counts only refs naming a repo-defined symbol.
	it("refs has type rows and resolves at least 50 percent of call/new/type/import refs naming repo symbols", () => {
		expect(one<{ c: number }>("SELECT count(*) c FROM refs WHERE kind='type'").c).toBeGreaterThan(0);
		const named = "kind IN ('call','new','type','import') AND name IN (SELECT DISTINCT name FROM symbols)";
		const t = one<{ c: number }>(`SELECT count(*) c FROM refs WHERE ${named}`).c;
		const r = one<{ c: number }>(`SELECT count(*) c FROM refs WHERE ${named} AND to_key IS NOT NULL`).c;
		expect(t).toBeGreaterThan(0);
		expect(r / t).toBeGreaterThanOrEqual(0.5);
	});

	it("this.open(keys) inside findDefinitions resolves to CortexIndexService.open in refs and calls", () => {
		const target = `${SVC}::CortexIndexService.open`;
		const from = `${SVC}::CortexIndexService.findDefinitions`;
		expect(one<{ to_key: string }>("SELECT to_key FROM refs WHERE kind='call' AND name='open' AND from_key=?", from).to_key).toBe(target);
		expect(one<{ to_key: string }>("SELECT to_key FROM calls WHERE from_key=? AND kind='method'", from).to_key).toBe(target);
	});

	it("navCapabilities parses and lists the emitted kinds", () => {
		const caps = JSON.parse(one<{ value: string }>("SELECT value FROM meta WHERE key='navCapabilities'").value);
		expect(caps.referencesTable).toBe("refs");
		const kinds = db.prepare("SELECT DISTINCT kind FROM symbols").all() as Array<{ kind: string }>;
		for (const k of kinds) expect(caps.symbolKinds).toContain(k.kind);
		const rkinds = db.prepare("SELECT DISTINCT kind FROM refs").all() as Array<{ kind: string }>;
		for (const k of rkinds) expect(caps.referenceKinds).toContain(k.kind);
	});

	it("the committed 3.1 store has the shape the consumer's fallback ingests (no navCapabilities, 3.1, functions + calls)", () => {
		// Shape check only; the ingestion path itself runs in the next case and in
		// the release gate, both of which execute the consumer's own code.
		const old = new Database(OLD_STORE, { readonly: true });
		try {
			expect((old.prepare("SELECT count(*) c FROM meta WHERE key='navCapabilities'").get() as { c: number }).c).toBe(0);
			expect((old.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get() as { value: string }).value).toBe("3.1");
			expect(old.pragma("user_version", { simple: true })).toBe(1);
			expect((old.prepare("SELECT count(*) c FROM functions WHERE qualified_name = 'CortexIndexService.findDefinitions'").get() as { c: number }).c).toBe(1);
		} finally {
			old.close();
		}
	});

	// Runs the CONSUMER's ingestion code (ai-14all ingestCortexStore) against both
	// stores. Needs the ai-14all checkout, so it is skipped in CI and mandatory in
	// the release gate (scripts/acceptance-v3.2.sh runs the same script).
	it.skipIf(!process.env.AI_14ALL_WORKTREE)("ai-14all ingestCortexStore accepts the 3.1 fixture through its fallback path and the fresh 3.2 store", () => {
		const id = resolveRepoIdentity(dir);
		const fresh = getCacheDbFilePath(id.repoKey, id.worktreeKey);
		const out = runConsumerIngest(process.env.AI_14ALL_WORKTREE!, [OLD_STORE, fresh]);
		expect(out).toHaveLength(2);
		for (const r of out) {
			expect(r.unavailable).toBeUndefined();
			expect(r.functionsCount).toBeGreaterThan(0);
			expect(r.hasFindDefinitions).toBe(true);
		}
		expect(out[0].schemaVersion).toBe("3.1");
		expect(out[1].schemaVersion).toBe("3.2");
	});
});

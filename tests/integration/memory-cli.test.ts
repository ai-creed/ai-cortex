// tests/integration/memory-cli.test.ts
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const CLI = path.join(ROOT, "dist", "src", "cli.js");

// Valid 16-hex repo keys required by assertHashedRepoKey (one per test scope).
const RK = {
	recall: "aa01bb02cc03dd04",
	search: "aa02bb03cc04dd05",
	record: "aa03bb04cc05dd06",
	globalScope: "aa04bb05cc06dd07",
	get: "aa05bb06cc07dd08",
	getMissing: "aa06bb07cc08dd09",
	listEmpty: "aa07bb08cc09dd10",
	listItem: "aa08bb09cc0add11",
	update: "aa09bb0acc0bdd12",
	deprecate: "aa0abb0bcc0cdd13",
	restore: "aa0bbb0ccc0ddd14",
	merge: "aa0cbb0dcc0edd15",
	trash: "aa0dbb0ecc0fdd16",
	untrash: "aa0ebb0fcc10dd17",
	purge: "aa0fbb10cc11dd18",
	purgeYes: "aa10bb11cc12dd19",
	link: "aa11bb12cc13dd1a",
	linkNotype: "aa12bb13cc14dd1b",
	unlink: "aa13bb14cc15dd1c",
	pin: "aa14bb15cc16dd1d",
	unpin: "aa15bb16cc17dd1e",
	confirm: "aa16bb17cc18dd1f",
	audit: "aa17bb18cc19dd20",
	rebuild: "aa18bb19cc1add21",
	reconcile: "aa19bb1acc1bdd22",
	reconcileReport: "aa1abb1bcc1cdd23",
};

let cacheHome: string;

beforeEach(() => {
	cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-memory-cli-"));
});

afterEach(() => {
	fs.rmSync(cacheHome, { recursive: true, force: true });
});

function run(
	args: string[],
	extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
	const result = spawnSync("node", [CLI, ...args], {
		env: { ...process.env, AI_CORTEX_CACHE_HOME: cacheHome, ...extraEnv },
		encoding: "utf8",
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status ?? 1,
	};
}

describe("ai-cortex memory CLI", () => {
	it("memory recall --json returns empty array for fresh repo", () => {
		const out = run([
			"memory",
			"recall",
			"any query",
			"--json",
			"--repo-key",
			RK.recall,
		]);
		expect(out.status).toBe(0);
		const parsed = JSON.parse(out.stdout);
		expect(Array.isArray(parsed)).toBe(true);
	});

	it("memory search --json returns empty array for fresh repo", () => {
		const out = run([
			"memory",
			"search",
			"any query",
			"--json",
			"--repo-key",
			RK.search,
		]);
		expect(out.status).toBe(0);
		const parsed = JSON.parse(out.stdout);
		expect(Array.isArray(parsed)).toBe(true);
	});

	it("unknown memory subcommand exits with code 1", () => {
		const out = run(["memory", "notacommand"]);
		expect(out.status).toBe(1);
	});

	it("memory record creates a memory and prints its ID", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "This is a test decision body.");

		const out = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"My decision",
			"--body-file",
			bodyFile,
			"--repo-key",
			RK.record,
		]);

		expect(out.status).toBe(0);
		expect(out.stdout).toMatch(
			/^mem-\d{4}-\d{2}-\d{2}-my-decision-[0-9a-f]{6}\n$/,
		);
	});

	it("memory record --global-scope writes to global store, not project", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "Global gotcha body.");

		const rec = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Global decision",
			"--body-file",
			bodyFile,
			"--global-scope",
			"--repo-key",
			RK.globalScope,
		]);

		expect(rec.status).toBe(0);
		const id = rec.stdout.trim();
		expect(id).toMatch(/^mem-/);

		// Verify it landed in the global store
		const globalGet = run([
			"memory",
			"get",
			id,
			"--repo-key",
			"global",
			"--json",
		]);
		expect(globalGet.status).toBe(0);
		const globalRecord = JSON.parse(globalGet.stdout);
		expect(globalRecord.frontmatter.id).toBe(id);
		expect(globalRecord.frontmatter.title).toBe("Global decision");

		// Verify it did NOT land in the project store
		const projectGet = run([
			"memory",
			"get",
			id,
			"--repo-key",
			RK.globalScope,
		]);
		expect(projectGet.status).not.toBe(0);
	});

	it("memory record with missing --title exits with code 1", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "body text");

		const out = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--body-file",
			bodyFile,
			"--repo-key",
			RK.record,
		]);

		expect(out.status).toBe(1);
	});

	// ─── Task 8.3 — memory get ───────────────────────────────────────────────
	it("memory get returns JSON with correct id", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "decision body");
		const rec = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Get test",
			"--body-file",
			bodyFile,
			"--repo-key",
			RK.get,
		]);
		expect(rec.status).toBe(0);
		const id = rec.stdout.trim();

		const out = run(["memory", "get", id, "--json", "--repo-key", RK.get]);
		expect(out.status).toBe(0);
		const parsed = JSON.parse(out.stdout);
		expect(parsed.frontmatter.id).toBe(id);
	});

	it("memory get nonexistent id exits with code 1", () => {
		const out = run([
			"memory",
			"get",
			"nonexistent-id",
			"--repo-key",
			RK.getMissing,
		]);
		expect(out.status).toBe(1);
	});

	// ─── Task 8.4 — memory list ──────────────────────────────────────────────
	it("memory list --json returns empty array for fresh repo", () => {
		const out = run([
			"memory",
			"list",
			"--json",
			"--repo-key",
			RK.listEmpty,
		]);
		expect(out.status).toBe(0);
		const parsed = JSON.parse(out.stdout);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed.length).toBe(0);
	});

	it("memory list --json returns item after recording", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "list test body");
		run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"List item",
			"--body-file",
			bodyFile,
			"--repo-key",
			RK.listItem,
		]);

		const out = run([
			"memory",
			"list",
			"--json",
			"--repo-key",
			RK.listItem,
		]);
		expect(out.status).toBe(0);
		const parsed = JSON.parse(out.stdout);
		expect(parsed.length).toBe(1);
	});

	// ─── Task 8.5 — memory update ────────────────────────────────────────────
	it("memory update changes title and get reflects new title", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "original body");
		const rec = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Original title",
			"--body-file",
			bodyFile,
			"--repo-key",
			RK.update,
		]);
		const id = rec.stdout.trim();

		const upd = run([
			"memory",
			"update",
			id,
			"--title",
			"New title",
			"--reason",
			"test",
			"--repo-key",
			RK.update,
		]);
		expect(upd.status).toBe(0);
		expect(upd.stdout.trim()).toBe("ok");

		const got = run([
			"memory",
			"get",
			id,
			"--json",
			"--repo-key",
			RK.update,
		]);
		const parsed = JSON.parse(got.stdout);
		expect(parsed.frontmatter.title).toBe("New title");
	});

	// ─── Task 8.6 — memory deprecate ─────────────────────────────────────────
	it("memory deprecate marks memory as deprecated", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "dep body");
		const rec = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Dep test",
			"--body-file",
			bodyFile,
			"--repo-key",
			RK.deprecate,
		]);
		const id = rec.stdout.trim();

		const dep = run([
			"memory",
			"deprecate",
			id,
			"--reason",
			"replaced",
			"--repo-key",
			RK.deprecate,
		]);
		expect(dep.status).toBe(0);

		const list = run([
			"memory",
			"list",
			"--status",
			"deprecated",
			"--json",
			"--repo-key",
			RK.deprecate,
		]);
		const items = JSON.parse(list.stdout);
		expect(items.some((i: { id: string }) => i.id === id)).toBe(true);
	});

	// ─── Task 8.7 — memory restore ───────────────────────────────────────────
	it("memory restore brings deprecated memory back to active", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "restore body");
		const rec = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Restore test",
			"--body-file",
			bodyFile,
			"--repo-key",
			RK.restore,
		]);
		const id = rec.stdout.trim();

		run([
			"memory",
			"deprecate",
			id,
			"--reason",
			"temp",
			"--repo-key",
			RK.restore,
		]);
		const res = run(["memory", "restore", id, "--repo-key", RK.restore]);
		expect(res.status).toBe(0);

		const list = run([
			"memory",
			"list",
			"--status",
			"active",
			"--json",
			"--repo-key",
			RK.restore,
		]);
		const items = JSON.parse(list.stdout);
		expect(items.some((i: { id: string }) => i.id === id)).toBe(true);
	});

	// ─── Task 8.8 — memory merge ─────────────────────────────────────────────
	it("memory merge marks src as merged_into", () => {
		const b1 = path.join(cacheHome, "b1.md");
		const b2 = path.join(cacheHome, "b2.md");
		const bm = path.join(cacheHome, "merged.md");
		fs.writeFileSync(b1, "src body");
		fs.writeFileSync(b2, "dst body");
		fs.writeFileSync(bm, "merged body");

		const src = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Merge src",
			"--body-file",
			b1,
			"--repo-key",
			RK.merge,
		]).stdout.trim();
		const dst = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Merge dst",
			"--body-file",
			b2,
			"--repo-key",
			RK.merge,
		]).stdout.trim();

		const mg = run([
			"memory",
			"merge",
			src,
			dst,
			"--body-file",
			bm,
			"--repo-key",
			RK.merge,
		]);
		expect(mg.status).toBe(0);

		const got = run([
			"memory",
			"get",
			src,
			"--json",
			"--repo-key",
			RK.merge,
		]);
		const parsed = JSON.parse(got.stdout);
		expect(parsed.frontmatter.status).toBe("merged_into");
	});

	// ─── Task 8.9 — memory trash ─────────────────────────────────────────────
	it("memory trash marks memory as trashed", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "trash body");
		const rec = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Trash test",
			"--body-file",
			bodyFile,
			"--repo-key",
			RK.trash,
		]);
		const id = rec.stdout.trim();

		const tr = run([
			"memory",
			"trash",
			id,
			"--reason",
			"no longer needed",
			"--repo-key",
			RK.trash,
		]);
		expect(tr.status).toBe(0);

		const list = run([
			"memory",
			"list",
			"--status",
			"trashed",
			"--json",
			"--repo-key",
			RK.trash,
		]);
		const items = JSON.parse(list.stdout);
		expect(items.some((i: { id: string }) => i.id === id)).toBe(true);
	});

	// ─── Task 8.10 — memory untrash ──────────────────────────────────────────
	it("memory untrash restores trashed memory to active", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "untrash body");
		const rec = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Untrash test",
			"--body-file",
			bodyFile,
			"--repo-key",
			RK.untrash,
		]);
		const id = rec.stdout.trim();

		run([
			"memory",
			"trash",
			id,
			"--reason",
			"temp",
			"--repo-key",
			RK.untrash,
		]);
		const ut = run(["memory", "untrash", id, "--repo-key", RK.untrash]);
		expect(ut.status).toBe(0);

		const list = run([
			"memory",
			"list",
			"--status",
			"active",
			"--json",
			"--repo-key",
			RK.untrash,
		]);
		const items = JSON.parse(list.stdout);
		expect(items.some((i: { id: string }) => i.id === id)).toBe(true);
	});

	// ─── Task 8.11 — memory purge ────────────────────────────────────────────
	it("memory purge without --yes exits with code 1", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "purge body");
		const rec = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Purge test",
			"--body-file",
			bodyFile,
			"--repo-key",
			RK.purge,
		]);
		const id = rec.stdout.trim();
		run([
			"memory",
			"trash",
			id,
			"--reason",
			"prep",
			"--repo-key",
			RK.purge,
		]);

		const pr = run([
			"memory",
			"purge",
			id,
			"--reason",
			"test",
			"--repo-key",
			RK.purge,
		]);
		expect(pr.status).toBe(1);
	});

	it("memory purge with --yes succeeds", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "purge body");
		const rec = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Purge yes test",
			"--body-file",
			bodyFile,
			"--repo-key",
			RK.purgeYes,
		]);
		const id = rec.stdout.trim();
		run([
			"memory",
			"trash",
			id,
			"--reason",
			"prep",
			"--repo-key",
			RK.purgeYes,
		]);

		const pr = run([
			"memory",
			"purge",
			id,
			"--reason",
			"test purge",
			"--yes",
			"--repo-key",
			RK.purgeYes,
		]);
		expect(pr.status).toBe(0);
	});

	// ─── Task 8.12 — memory link ─────────────────────────────────────────────
	it("memory link creates a link between two memories", () => {
		const b1 = path.join(cacheHome, "b1.md");
		const b2 = path.join(cacheHome, "b2.md");
		fs.writeFileSync(b1, "link src body");
		fs.writeFileSync(b2, "link dst body");
		const src = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Link src",
			"--body-file",
			b1,
			"--repo-key",
			RK.link,
		]).stdout.trim();
		const dst = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Link dst",
			"--body-file",
			b2,
			"--repo-key",
			RK.link,
		]).stdout.trim();

		const lk = run([
			"memory",
			"link",
			src,
			dst,
			"--type",
			"supports",
			"--repo-key",
			RK.link,
		]);
		expect(lk.status).toBe(0);
	});

	it("memory link without --type exits with code 1", () => {
		const b1 = path.join(cacheHome, "b1.md");
		const b2 = path.join(cacheHome, "b2.md");
		fs.writeFileSync(b1, "body1");
		fs.writeFileSync(b2, "body2");
		const src = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"No type src",
			"--body-file",
			b1,
			"--repo-key",
			RK.linkNotype,
		]).stdout.trim();
		const dst = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"No type dst",
			"--body-file",
			b2,
			"--repo-key",
			RK.linkNotype,
		]).stdout.trim();

		const lk = run([
			"memory",
			"link",
			src,
			dst,
			"--repo-key",
			RK.linkNotype,
		]);
		expect(lk.status).toBe(1);
	});

	// ─── Task 8.13 — memory unlink ───────────────────────────────────────────
	it("memory unlink removes link between memories", () => {
		const b1 = path.join(cacheHome, "b1.md");
		const b2 = path.join(cacheHome, "b2.md");
		fs.writeFileSync(b1, "unlink src body");
		fs.writeFileSync(b2, "unlink dst body");
		const src = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Unlink src",
			"--body-file",
			b1,
			"--repo-key",
			RK.unlink,
		]).stdout.trim();
		const dst = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Unlink dst",
			"--body-file",
			b2,
			"--repo-key",
			RK.unlink,
		]).stdout.trim();

		run([
			"memory",
			"link",
			src,
			dst,
			"--type",
			"supports",
			"--repo-key",
			RK.unlink,
		]);
		const ul = run([
			"memory",
			"unlink",
			src,
			dst,
			"--type",
			"supports",
			"--repo-key",
			RK.unlink,
		]);
		expect(ul.status).toBe(0);
	});

	// ─── Task 8.14 — memory pin / unpin ──────────────────────────────────────
	it("memory pin succeeds", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "pin body");
		const rec = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Pin test",
			"--body-file",
			bodyFile,
			"--repo-key",
			RK.pin,
		]);
		const id = rec.stdout.trim();

		const pn = run(["memory", "pin", id, "--repo-key", RK.pin]);
		expect(pn.status).toBe(0);
	});

	it("memory pin then unpin succeeds", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "unpin body");
		const rec = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Unpin test",
			"--body-file",
			bodyFile,
			"--repo-key",
			RK.unpin,
		]);
		const id = rec.stdout.trim();

		run(["memory", "pin", id, "--repo-key", RK.unpin]);
		const up = run(["memory", "unpin", id, "--repo-key", RK.unpin]);
		expect(up.status).toBe(0);
	});

	// ─── Task 8.15 — memory confirm ──────────────────────────────────────────
	it("memory confirm promotes candidate to active", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "confirm body");
		// source=extracted creates a candidate
		const rec = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Confirm test",
			"--body-file",
			bodyFile,
			"--source",
			"extracted",
			"--repo-key",
			RK.confirm,
		]);
		const id = rec.stdout.trim();

		const cf = run(["memory", "confirm", id, "--repo-key", RK.confirm]);
		expect(cf.status).toBe(0);
	});

	// ─── Task 8.16 — memory audit ────────────────────────────────────────────
	it("memory audit --json returns rows with created changeType", () => {
		const bodyFile = path.join(cacheHome, "body.md");
		fs.writeFileSync(bodyFile, "audit body");
		const rec = run([
			"memory",
			"record",
			"--type",
			"decision",
			"--title",
			"Audit test",
			"--body-file",
			bodyFile,
			"--repo-key",
			RK.audit,
		]);
		const id = rec.stdout.trim();

		const au = run([
			"memory",
			"audit",
			id,
			"--json",
			"--repo-key",
			RK.audit,
		]);
		expect(au.status).toBe(0);
		const rows = JSON.parse(au.stdout);
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.length).toBeGreaterThanOrEqual(1);
		expect(
			rows.some((r: { changeType: string }) => r.changeType === "create"),
		).toBe(true);
	});

	// ─── Task 8.19 — memory rebuild-index ────────────────────────────────────
	it("memory rebuild-index exits 0 for fresh repo", () => {
		const out = run(["memory", "rebuild-index", "--repo-key", RK.rebuild]);
		expect(out.status).toBe(0);
	});

	// ─── Task 8.20 — memory reconcile ────────────────────────────────────────
	it("memory reconcile exits 0 and prints ok", () => {
		const out = run(["memory", "reconcile", "--repo-key", RK.reconcile]);
		expect(out.status).toBe(0);
		expect(out.stdout).toContain("ok");
	});

	it("memory reconcile --report outputs JSON with expected keys", () => {
		const out = run([
			"memory",
			"reconcile",
			"--report",
			"--repo-key",
			RK.reconcileReport,
		]);
		expect(out.status).toBe(0);
		const parsed = JSON.parse(out.stdout);
		expect(Array.isArray(parsed.reindexed)).toBe(true);
		expect(Array.isArray(parsed.adopted)).toBe(true);
		expect(Array.isArray(parsed.phantomsRemoved)).toBe(true);
	});

	// ─── Task 3.1 — --repo-key validation ───────────────────────────────────
	it("rejects a non-hashed repo-key with a clear error (memory list)", () => {
		const out = run(["memory", "list", "--repo-key", "Favro"]);
		expect(out.status).not.toBe(0);
		expect(out.stderr).toMatch(/Invalid repoKey|expected 16-hex/i);
	});

	it("rejects a non-hashed repo-key with a clear error (memory recall)", () => {
		const out = run(["memory", "recall", "any query", "--repo-key", "Favro"]);
		expect(out.status).not.toBe(0);
		expect(out.stderr).toMatch(/Invalid repoKey|expected 16-hex/i);
	});

	it("rejects a non-hashed repo-key with a clear error (memory search)", () => {
		const out = run(["memory", "search", "any query", "--repo-key", "Favro"]);
		expect(out.status).not.toBe(0);
		expect(out.stderr).toMatch(/Invalid repoKey|expected 16-hex/i);
	});

	it("accepts the reserved 'global' key without validation error", () => {
		const out = run(["memory", "list", "--json", "--repo-key", "global"]);
		expect(out.status).toBe(0);
		const parsed = JSON.parse(out.stdout);
		expect(Array.isArray(parsed)).toBe(true);
	});
});

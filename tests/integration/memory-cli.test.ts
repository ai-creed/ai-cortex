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
			"test-recall",
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
			"test-search",
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
			"test-cli-record",
		]);

		expect(out.status).toBe(0);
		expect(out.stdout).toMatch(
			/^mem-\d{4}-\d{2}-\d{2}-my-decision-[0-9a-f]{6}\n$/,
		);
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
			"test-cli-record",
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
			"test-get",
		]);
		expect(rec.status).toBe(0);
		const id = rec.stdout.trim();

		const out = run(["memory", "get", id, "--json", "--repo-key", "test-get"]);
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
			"test-get-missing",
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
			"test-list-empty",
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
			"test-list-item",
		]);

		const out = run([
			"memory",
			"list",
			"--json",
			"--repo-key",
			"test-list-item",
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
			"test-update",
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
			"test-update",
		]);
		expect(upd.status).toBe(0);
		expect(upd.stdout.trim()).toBe("ok");

		const got = run([
			"memory",
			"get",
			id,
			"--json",
			"--repo-key",
			"test-update",
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
			"test-deprecate",
		]);
		const id = rec.stdout.trim();

		const dep = run([
			"memory",
			"deprecate",
			id,
			"--reason",
			"replaced",
			"--repo-key",
			"test-deprecate",
		]);
		expect(dep.status).toBe(0);

		const list = run([
			"memory",
			"list",
			"--status",
			"deprecated",
			"--json",
			"--repo-key",
			"test-deprecate",
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
			"test-restore",
		]);
		const id = rec.stdout.trim();

		run([
			"memory",
			"deprecate",
			id,
			"--reason",
			"temp",
			"--repo-key",
			"test-restore",
		]);
		const res = run(["memory", "restore", id, "--repo-key", "test-restore"]);
		expect(res.status).toBe(0);

		const list = run([
			"memory",
			"list",
			"--status",
			"active",
			"--json",
			"--repo-key",
			"test-restore",
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
			"test-merge",
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
			"test-merge",
		]).stdout.trim();

		const mg = run([
			"memory",
			"merge",
			src,
			dst,
			"--body-file",
			bm,
			"--repo-key",
			"test-merge",
		]);
		expect(mg.status).toBe(0);

		const got = run([
			"memory",
			"get",
			src,
			"--json",
			"--repo-key",
			"test-merge",
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
			"test-trash",
		]);
		const id = rec.stdout.trim();

		const tr = run([
			"memory",
			"trash",
			id,
			"--reason",
			"no longer needed",
			"--repo-key",
			"test-trash",
		]);
		expect(tr.status).toBe(0);

		const list = run([
			"memory",
			"list",
			"--status",
			"trashed",
			"--json",
			"--repo-key",
			"test-trash",
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
			"test-untrash",
		]);
		const id = rec.stdout.trim();

		run([
			"memory",
			"trash",
			id,
			"--reason",
			"temp",
			"--repo-key",
			"test-untrash",
		]);
		const ut = run(["memory", "untrash", id, "--repo-key", "test-untrash"]);
		expect(ut.status).toBe(0);

		const list = run([
			"memory",
			"list",
			"--status",
			"active",
			"--json",
			"--repo-key",
			"test-untrash",
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
			"test-purge",
		]);
		const id = rec.stdout.trim();
		run([
			"memory",
			"trash",
			id,
			"--reason",
			"prep",
			"--repo-key",
			"test-purge",
		]);

		const pr = run([
			"memory",
			"purge",
			id,
			"--reason",
			"test",
			"--repo-key",
			"test-purge",
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
			"test-purge-yes",
		]);
		const id = rec.stdout.trim();
		run([
			"memory",
			"trash",
			id,
			"--reason",
			"prep",
			"--repo-key",
			"test-purge-yes",
		]);

		const pr = run([
			"memory",
			"purge",
			id,
			"--reason",
			"test purge",
			"--yes",
			"--repo-key",
			"test-purge-yes",
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
			"test-link",
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
			"test-link",
		]).stdout.trim();

		const lk = run([
			"memory",
			"link",
			src,
			dst,
			"--type",
			"supports",
			"--repo-key",
			"test-link",
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
			"test-link-notype",
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
			"test-link-notype",
		]).stdout.trim();

		const lk = run([
			"memory",
			"link",
			src,
			dst,
			"--repo-key",
			"test-link-notype",
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
			"test-unlink",
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
			"test-unlink",
		]).stdout.trim();

		run([
			"memory",
			"link",
			src,
			dst,
			"--type",
			"supports",
			"--repo-key",
			"test-unlink",
		]);
		const ul = run([
			"memory",
			"unlink",
			src,
			dst,
			"--type",
			"supports",
			"--repo-key",
			"test-unlink",
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
			"test-pin",
		]);
		const id = rec.stdout.trim();

		const pn = run(["memory", "pin", id, "--repo-key", "test-pin"]);
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
			"test-unpin",
		]);
		const id = rec.stdout.trim();

		run(["memory", "pin", id, "--repo-key", "test-unpin"]);
		const up = run(["memory", "unpin", id, "--repo-key", "test-unpin"]);
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
			"test-confirm",
		]);
		const id = rec.stdout.trim();

		const cf = run(["memory", "confirm", id, "--repo-key", "test-confirm"]);
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
			"test-audit",
		]);
		const id = rec.stdout.trim();

		const au = run([
			"memory",
			"audit",
			id,
			"--json",
			"--repo-key",
			"test-audit",
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
		const out = run(["memory", "rebuild-index", "--repo-key", "test-rebuild"]);
		expect(out.status).toBe(0);
	});

	// ─── Task 8.20 — memory reconcile ────────────────────────────────────────
	it("memory reconcile exits 0 and prints ok", () => {
		const out = run(["memory", "reconcile", "--repo-key", "test-reconcile"]);
		expect(out.status).toBe(0);
		expect(out.stdout).toContain("ok");
	});

	it("memory reconcile --report outputs JSON with expected keys", () => {
		const out = run([
			"memory",
			"reconcile",
			"--report",
			"--repo-key",
			"test-reconcile-report",
		]);
		expect(out.status).toBe(0);
		const parsed = JSON.parse(out.stdout);
		expect(Array.isArray(parsed.reindexed)).toBe(true);
		expect(Array.isArray(parsed.adopted)).toBe(true);
		expect(Array.isArray(parsed.phantomsRemoved)).toBe(true);
	});
});

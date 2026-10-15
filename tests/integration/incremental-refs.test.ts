// tests/integration/incremental-refs.test.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIncrementalIndex, buildIndex } from "../../src/lib/indexer.js";
import { diffChangedFiles } from "../../src/lib/diff-files.js";
import { resolveRepoIdentity } from "../../src/lib/repo-identity.js";
import type { RepoCache } from "../../src/lib/models.js";

let dir: string;
function git(...args: string[]) {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}
function write(rel: string, body: string) {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), body);
}
const A = "src/a.ts";
const B = "src/b.ts";
const C = "src/c.ts";

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-incr-refs-"));
	git("init");
	git("config", "user.email", "t@t");
	git("config", "user.name", "T");
	git("config", "commit.gpgsign", "false");
	write("package.json", JSON.stringify({ name: "incr", version: "0.0.0" }));
	write(C, "export function foo() { return 1; }\nexport function gone() { return 2; }\n");
	write(B, 'export { foo as bar } from "./c";\nexport { gone } from "./c";\n');
	write(A, 'import { bar, gone } from "./b";\nexport function main() { return bar() + gone(); }\n');
	git("add", ".");
	git("commit", "-m", "init");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function incremental(prev: RepoCache): Promise<RepoCache> {
	const identity = resolveRepoIdentity(dir);
	const diff = await diffChangedFiles(identity, prev, { forceHashCompare: true });
	return buildIncrementalIndex(identity, prev, diff, true);
}
const refTo = (c: RepoCache, file: string, name: string, kind: string) => c.refs.find((r) => r.file === file && r.name === name && r.kind === kind)?.to;
function noDangling(c: RepoCache) {
	const keys = new Set(c.symbols.map((s) => `${s.file}::${s.qualifiedName}`));
	for (const r of c.refs) if (r.to) expect(keys.has(r.to)).toBe(true);
	for (const r of c.refs) if (r.from) expect(keys.has(r.from)).toBe(true);
	for (const e of c.calls) if (!e.to.startsWith("::")) expect(keys.has(e.to)).toBe(true);
}

describe("incremental index: symbols, refs, reexports (B4)", () => {
	it("full index resolves A's bar() through B's aliased re-export to C.foo and fills contentFingerprint", async () => {
		const full = await buildIndex(resolveRepoIdentity(dir));
		expect(refTo(full, A, "bar", "call")).toBe(`${C}::foo`);
		expect(refTo(full, A, "gone", "call")).toBe(`${C}::gone`);
		expect(full.calls.find((e) => e.from === `${A}::main` && e.to === `${C}::foo`)).toBeDefined();
		expect(full.reexports).toEqual([
			{ file: B, exportedName: "bar", sourceName: "foo", specifier: "./c" },
			{ file: B, exportedName: "gone", sourceName: "gone", specifier: "./c" },
		]);
		expect(full.contentFingerprint).toMatch(/^[0-9a-f]{40}$/);
		expect(full.indexSeq).toBe(0);
		noDangling(full);
	});

	it("(1a) renaming the target in C and B's re-export, with A untouched, re-points A's to_key", async () => {
		// A is not in the diff; it must be reparsed as an importer of touched B.
		const full = await buildIndex(resolveRepoIdentity(dir));
		expect(refTo(full, A, "bar", "call")).toBe(`${C}::foo`);
		write(C, "export function fooRenamed() { return 1; }\nexport function gone() { return 2; }\n");
		write(B, 'export { fooRenamed as bar } from "./c";\nexport { gone } from "./c";\n');
		const next = await incremental(full);
		expect(next.symbols.some((s) => s.file === C && s.qualifiedName === "foo")).toBe(false);
		expect(refTo(next, A, "bar", "call")).toBe(`${C}::fooRenamed`); // would be the stale ::foo without re-resolution
		expect(next.calls.find((e) => e.from === `${A}::main` && e.to === `${C}::fooRenamed`)).toBeDefined();
		expect(next.contentFingerprint).not.toBe(full.contentFingerprint);
		noDangling(next);
		// restore for later cases
		write(C, "export function foo() { return 1; }\nexport function gone() { return 2; }\n");
		write(B, 'export { foo as bar } from "./c";\nexport { gone } from "./c";\n');
	});

	it("(1b) deleting the target from C only, with A and B untouched, turns A's to_key NULL via the one-hop rule", async () => {
		// Only C changes. B imports C (affected caller). B has reexports rows, so A,
		// which imports B, is in the one-hop affected set and is re-resolved.
		const full = await buildIndex(resolveRepoIdentity(dir));
		write(C, "export function gone() { return 2; }\n");
		const next = await incremental(full);
		expect(refTo(next, A, "bar", "call")).toBeUndefined();
		expect(refTo(next, A, "gone", "call")).toBe(`${C}::gone`);
		expect(next.calls.find((e) => e.from === `${A}::main` && e.to === "::bar")).toBeDefined();
		noDangling(next);
		write(C, "export function foo() { return 1; }\nexport function gone() { return 2; }\n");
	});

	it("(2) editing only A still follows B's untouched re-export", async () => {
		const full = await buildIndex(resolveRepoIdentity(dir));
		write(A, 'import { bar, gone } from "./b";\nexport function main() { return bar() + gone(); }\nexport function again() { return bar(); }\n');
		const next = await incremental(full);
		const againRef = next.refs.find((r) => r.file === A && r.from === `${A}::again` && r.kind === "call");
		expect(againRef?.to).toBe(`${C}::foo`);
		expect(next.reexports.filter((r) => r.file === B)).toEqual(full.reexports.filter((r) => r.file === B));
		noDangling(next);
	});

	it("(3) removing the re-export from B turns A's ref NULL; removing C drops its rows and dangling targets", async () => {
		const full = await buildIndex(resolveRepoIdentity(dir));
		write(B, 'export { gone } from "./c";\n');
		const next = await incremental(full);
		expect(refTo(next, A, "bar", "call")).toBeUndefined();
		expect(refTo(next, A, "gone", "call")).toBe(`${C}::gone`);
		noDangling(next);

		fs.rmSync(path.join(dir, C));
		const afterRm = await incremental(next);
		expect(afterRm.symbols.some((s) => s.file === C)).toBe(false);
		expect(afterRm.refs.some((r) => r.file === C)).toBe(false);
		expect(refTo(afterRm, A, "gone", "call")).toBeUndefined();
		noDangling(afterRm);
	});

	it("empty diff keeps rows, recomputes contentFingerprint, and leaves indexSeq for the writer", async () => {
		const full = await buildIndex(resolveRepoIdentity(dir));
		const same = await buildIncrementalIndex(resolveRepoIdentity(dir), full, { changed: [], removed: [], method: "hash-compare" }, false);
		expect(same.symbols).toEqual(full.symbols);
		expect(same.refs).toEqual(full.refs);
		expect(same.contentFingerprint).toBe(full.contentFingerprint);
		expect(same.indexSeq).toBe(0);
	});

	it("(4) a kept call into a companion source outside the affected set is swept to unresolved, never dangling", async () => {
		// main.c includes util.h, and its call resolves to the companion util.c. Only
		// util.c changes; main.c does not import it, so main.c is kept and only the
		// sweep can clear the stale key. (TS re-export chains cannot reach here: the
		// resolver follows one hop, which the affected set already covers.)
		const H = "src/cdep/util.h";
		const CSRC = "src/cdep/util.c";
		const MAIN = "src/cdep/main.c";
		write(H, "int helper(void);\n");
		write(CSRC, '#include "util.h"\nint helper(void) { return 1; }\nint keep(void) { return 2; }\n');
		write(MAIN, '#include "util.h"\nint main(void) { return helper(); }\n');
		try {
			const full = await buildIndex(resolveRepoIdentity(dir));
			expect(full.calls.find((e) => e.from === `${MAIN}::main` && e.to === `${CSRC}::helper`)).toBeDefined();

			write(CSRC, '#include "util.h"\nint keep(void) { return 2; }\n');
			const next = await incremental(full);
			expect(next.symbols.some((s) => s.file === CSRC && s.qualifiedName === "helper")).toBe(false);
			expect(next.calls.find((e) => e.from === `${MAIN}::main` && e.to === "::helper")).toBeDefined();
			expect(next.calls.some((e) => e.to === `${CSRC}::helper`)).toBe(false);
			noDangling(next);
		} finally {
			fs.rmSync(path.join(dir, "src/cdep"), { recursive: true, force: true });
		}
	});
});

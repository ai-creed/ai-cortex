// tests/integration/call-graph.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { indexRepo } from "../../src/lib/indexer.js";
import { queryBlastRadius } from "../../src/lib/blast-radius.js";
import type { RepoCache } from "../../src/lib/models.js";

let tmpDir: string;
let cache: RepoCache;

function git(...args: string[]): string {
	return execFileSync("git", ["-C", tmpDir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}

beforeAll(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-callgraph-"));
	git("init");
	git("config", "user.email", "test@test.com");
	git("config", "user.name", "Test");

	// Create a mini project with cross-file calls
	fs.writeFileSync(
		path.join(tmpDir, "package.json"),
		JSON.stringify({ name: "test-proj", version: "1.0.0" }),
	);

	fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });

	fs.writeFileSync(
		path.join(tmpDir, "src/utils.ts"),
		[
			"export function helper() { return 1; }",
			"export function unused() { return 2; }",
		].join("\n"),
	);

	fs.writeFileSync(
		path.join(tmpDir, "src/main.ts"),
		[
			'import { helper } from "./utils";',
			"export function main() { return helper(); }",
		].join("\n"),
	);

	fs.writeFileSync(
		path.join(tmpDir, "src/cli.ts"),
		['import { main } from "./main";', "function run() { main(); }"].join("\n"),
	);

	git("add", ".");
	git("commit", "-m", "init");
	cache = await indexRepo(tmpDir);
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("call graph integration", () => {
	it("emits FunctionNode ranges and CallEdge.site for TS", () => {
		const main = cache.functions.find((f) => f.qualifiedName === "main");
		expect(main).toBeDefined();
		expect(main?.column).toBeGreaterThanOrEqual(1);
		expect(main?.endLine).toBeGreaterThanOrEqual(main!.line);
		expect(main?.endColumn).toBeGreaterThanOrEqual(1);

		const edge = cache.calls.find(
			(c) => c.from.includes("main") && c.to.includes("helper"),
		);
		expect(edge?.site).toBeDefined();
		expect(edge?.site?.line).toBeGreaterThanOrEqual(1);
		expect(edge?.site?.column).toBeGreaterThanOrEqual(1);
	});

	it("never emits the reserved FunctionNode.id key at v3.1", () => {
		for (const fn of cache.functions) {
			expect(Object.prototype.hasOwnProperty.call(fn, "id")).toBe(false);
		}
	});

	it("extracts call edges and functions from real files", async () => {
		expect(cache.functions.length).toBeGreaterThan(0);
		expect(cache.calls.length).toBeGreaterThan(0);

		// main calls helper (cross-file, resolved via import binding)
		expect(cache.calls).toContainEqual(
			expect.objectContaining({
				from: expect.stringContaining("main"),
				to: expect.stringContaining("helper"),
				kind: "call",
			}),
		);
	});

	it("blast radius returns tiered callers", async () => {
		const result = queryBlastRadius(
			{ qualifiedName: "helper", file: "src/utils.ts" },
			cache.calls,
			cache.functions,
		);

		expect(result.target.qualifiedName).toBe("helper");
		expect(result.totalAffected).toBeGreaterThanOrEqual(2);
		expect(result.confidence).toBe("full");

		// main is a direct caller
		const directCallers = result.tiers.find((t) => t.hop === 1);
		expect(directCallers?.hits).toContainEqual(
			expect.objectContaining({ qualifiedName: "main" }),
		);

		// run calls main which calls helper — two-hop transitive caller
		const transitiveCallers = result.tiers.find((t) => t.hop === 2);
		expect(transitiveCallers?.hits).toContainEqual(
			expect.objectContaining({ qualifiedName: "run" }),
		);
	});
});

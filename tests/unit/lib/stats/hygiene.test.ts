import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	assertRepoKey,
	readExcluded,
	excludeWorkspace,
	archiveWorkspace,
	cleanWorkspace,
} from "../../../../src/lib/stats/hygiene.js";
import { statsConfigPath, archiveDir, cacheRoot } from "../../../../src/lib/stats/paths.js";

const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";

describe("assertRepoKey", () => {
	it("accepts canonical 16-hex", () => {
		expect(() => assertRepoKey(A)).not.toThrow();
	});

	it.each([
		["14-hex display", "29751ede0f594c"],
		["17-hex", "aaaaaaaaaaaaaaaaa"],
		["uppercase", "AAAAAAAAAAAAAAAA"],
		["empty", ""],
		["traversal", "../foo"],
		["absolute", "/etc/passwd"],
		["whitespace", "a b"],
	])("rejects %s", (_label, bad) => {
		expect(() => assertRepoKey(bad)).toThrow(/repoKey/);
	});
});

describe("config IO + excludeWorkspace", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-hyg-"));
		process.env.AI_CORTEX_CACHE_HOME = tmp;
		fs.mkdirSync(cacheRoot(), { recursive: true });
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		delete process.env.AI_CORTEX_CACHE_HOME;
	});

	it("readExcluded returns [] when config missing", () => {
		expect(readExcluded()).toEqual([]);
	});

	it("readExcluded recovers from malformed JSON without throwing", () => {
		fs.writeFileSync(statsConfigPath(), "{not json");
		expect(readExcluded()).toEqual([]);
	});

	it("readExcluded ignores entries that fail the 16-hex regex AND warns once per invalid entry to stderr", () => {
		fs.writeFileSync(
			statsConfigPath(),
			JSON.stringify({ version: 1, excluded: [A, "29751ede0f594c", "../x"] }),
		);
		const writes: string[] = [];
		const spy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(((chunk: string | Uint8Array) => {
				writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
				return true;
			}) as typeof process.stderr.write);

		expect(readExcluded()).toEqual([A]);

		const warnings = writes.filter((s) => s.includes("stats-config.json"));
		expect(warnings.length).toBeGreaterThanOrEqual(2);
		expect(warnings.some((s) => s.includes("29751ede0f594c"))).toBe(true);
		expect(warnings.some((s) => s.includes("../x"))).toBe(true);
		for (const w of warnings) {
			const inner = w.endsWith("\n") ? w.slice(0, -1) : w;
			expect(inner.split("\n").length).toBe(1);
		}
		spy.mockRestore();
	});

	it("readExcluded warns once when the file is malformed JSON", () => {
		fs.writeFileSync(statsConfigPath(), "{not json");
		const writes: string[] = [];
		const spy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(((chunk: string | Uint8Array) => {
				writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
				return true;
			}) as typeof process.stderr.write);

		expect(readExcluded()).toEqual([]);
		expect(writes.some((s) => s.includes("stats-config.json") && s.includes("malformed"))).toBe(true);
		spy.mockRestore();
	});

	it("excludeWorkspace writes atomically and is idempotent", () => {
		excludeWorkspace(A);
		excludeWorkspace(A);
		excludeWorkspace(B);
		const cfg = JSON.parse(fs.readFileSync(statsConfigPath(), "utf8"));
		expect(cfg.version).toBe(1);
		expect(cfg.excluded.sort()).toEqual([A, B].sort());
	});

	it("excludeWorkspace refuses non-16-hex keys", () => {
		expect(() => excludeWorkspace("29751ede0f594c")).toThrow(/repoKey/);
	});
});

describe("archiveWorkspace", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-arc-"));
		process.env.AI_CORTEX_CACHE_HOME = tmp;
		fs.mkdirSync(path.join(cacheRoot(), A), { recursive: true });
		fs.writeFileSync(path.join(cacheRoot(), A, "marker"), "x");
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		delete process.env.AI_CORTEX_CACHE_HOME;
	});

	it("moves <root>/<key>/ to <root>/_archived/<key>/", () => {
		archiveWorkspace(A);
		expect(fs.existsSync(path.join(cacheRoot(), A))).toBe(false);
		expect(fs.existsSync(path.join(archiveDir(A), "marker"))).toBe(true);
	});

	it("fails loudly if the archive destination already exists", () => {
		fs.mkdirSync(archiveDir(A), { recursive: true });
		expect(() => archiveWorkspace(A)).toThrow(/already archived|exists/i);
	});

	it("refuses non-16-hex keys", () => {
		expect(() => archiveWorkspace("../etc")).toThrow(/repoKey/);
	});
});

describe("cleanWorkspace", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-clean-"));
		process.env.AI_CORTEX_CACHE_HOME = tmp;
		fs.mkdirSync(path.join(cacheRoot(), A), { recursive: true });
		fs.writeFileSync(path.join(cacheRoot(), A, "marker"), "x");
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		delete process.env.AI_CORTEX_CACHE_HOME;
	});

	it("removes the dir", () => {
		cleanWorkspace(A);
		expect(fs.existsSync(path.join(cacheRoot(), A))).toBe(false);
	});

	it("is idempotent on missing dir", () => {
		cleanWorkspace(A);
		expect(() => cleanWorkspace(A)).not.toThrow();
	});

	it.each(["29751ede0f594c", "../escape", "/etc/passwd", "", "aaaaaaaaaaaaaaaaa"])(
		"refuses malicious key %s",
		(bad) => {
			expect(() => cleanWorkspace(bad)).toThrow(/repoKey/);
		},
	);

	it("fuzz: no fs.rmSync call escapes the cache root for ANY malicious input", () => {
		const rmSpy = vi.spyOn(fs, "rmSync");
		const root = cacheRoot();
		const bads = [
			"29751ede0f594c",
			"aaaaaaaaaaaaaaaaa",
			"AAAAAAAAAAAAAAAA",
			"",
			"../escape",
			"../../../../../etc/passwd",
			"/etc/passwd",
			path.join(root, ".."),
			path.join(root, "..", "anywhere"),
			"a b",
			`${root}/../escape`,
		];
		for (const bad of bads) {
			expect(() => cleanWorkspace(bad)).toThrow(/repoKey/);
		}
		const rootResolved = path.resolve(root) + path.sep;
		for (const call of rmSpy.mock.calls) {
			const target = path.resolve(String(call[0]));
			expect(
				target === path.resolve(root) || target.startsWith(rootResolved),
				`fs.rmSync called with escaping path: ${target}`,
			).toBe(true);
		}
		expect(rmSpy).not.toHaveBeenCalled();
		rmSpy.mockRestore();
	});
});

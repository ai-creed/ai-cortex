// tests/integration/cli.test.ts
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = path.join(ROOT, "dist/src/cli.js");

let tmpDir: string;

beforeAll(() => {
	if (!fs.existsSync(CLI)) {
		execFileSync("pnpm", ["build"], { cwd: ROOT, stdio: "ignore" });
	}

	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-cli-test-"));
	execFileSync("git", ["init", tmpDir]);
	execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@test.com"]);
	execFileSync("git", ["-C", tmpDir, "config", "user.name", "Test"]);
	execFileSync("git", ["-C", tmpDir, "config", "commit.gpgsign", "false"]);
	fs.writeFileSync(
		path.join(tmpDir, "package.json"),
		JSON.stringify({ name: "cli-test-repo", version: "1.0.0" }),
	);
	fs.writeFileSync(path.join(tmpDir, "README.md"), "# CLI Test Repo\n");
	execFileSync("git", ["-C", tmpDir, "add", "."]);
	execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("rehydrate CLI", () => {
	it("text output is two lines matching spec format", () => {
		const result = spawnSync("node", [CLI, "rehydrate", tmpDir], {
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		const lines = result.stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(
			/^rehydrated cli-test-repo \((reindexed|fresh|stale), \d+ files, \d+ docs\)$/,
		);
		// The CLI tilde-collapses the briefing path only when it lives under
		// os.homedir(). The global vitest setup pins AI_CORTEX_CACHE_HOME to a
		// session tmpdir (inherited by the spawned child), so the briefing is
		// under that tmpdir and stays absolute. Assert relative to the active
		// cache home rather than a hardcoded ~/ so the format check still holds
		// without weakening it. If the env var were unset it'd collapse to ~/.
		const cacheHome = process.env.AI_CORTEX_CACHE_HOME;
		if (cacheHome) {
			expect(lines[1]).toMatch(
				new RegExp(
					`^\\s+briefing: ${cacheHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/.+\\.md$`,
				),
			);
		} else {
			expect(lines[1]).toMatch(/^\s+briefing: ~\/.+\.md$/);
		}
	});

	it("--json outputs valid JSON with required fields", () => {
		const result = spawnSync("node", [CLI, "rehydrate", "--json", tmpDir], {
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		const json = JSON.parse(result.stdout);
		expect(json).toMatchObject({
			briefingPath: expect.stringMatching(/\.md$/),
			cacheStatus: expect.stringMatching(/^(fresh|reindexed|stale)$/),
			packageName: "cli-test-repo",
			fileCount: expect.any(Number),
			docCount: expect.any(Number),
		});
		expect(path.isAbsolute(json.briefingPath)).toBe(true);
	});

	it("--stale flag succeeds and includes project name in output", () => {
		const result = spawnSync("node", [CLI, "rehydrate", "--stale", tmpDir], {
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("cli-test-repo");
	});

	it("exits with code 1 and writes to stderr when not a git repo", () => {
		const result = spawnSync("node", [CLI, "rehydrate", os.tmpdir()], {
			encoding: "utf8",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("ai-cortex:");
	});
});

function seedSuggestRepo(): void {
	fs.writeFileSync(
		path.join(tmpDir, "src.ts"),
		"export const persistenceStore = true;\n" +
			"export const restoreFlow = true;\n",
	);
	fs.writeFileSync(
		path.join(tmpDir, "guide.md"),
		"# Persistence Guide\nPersistence guide body.\n",
	);
	execFileSync("git", ["-C", tmpDir, "add", "."]);
	const status = spawnSync("git", ["-C", tmpDir, "status", "--porcelain"], {
		encoding: "utf8",
	});
	if (status.stdout.trim()) {
		execFileSync("git", [
			"-C",
			tmpDir,
			"commit",
			"-m",
			"seed suggest fixtures",
		]);
	}
}

describe("suggest CLI", () => {
	it("renders numbered text output", () => {
		seedSuggestRepo();

		const result = spawnSync("node", [CLI, "suggest", "persistence", tmpDir], {
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("suggested files for: persistence");
		expect(result.stdout).toMatch(/\n\n1\. /);
		expect(result.stdout).toContain("reason:");
		expect(result.stdout).toMatch(/\[(file|doc) · score \d+\]/);
		expect(result.stdout).toMatch(/^escalation hint: /m);
	});

	it("supports --json output", () => {
		seedSuggestRepo();

		const result = spawnSync(
			"node",
			[CLI, "suggest", "persistence", "--json", tmpDir],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		const json = JSON.parse(result.stdout);
		expect(json).toMatchObject({
			task: "persistence",
			from: null,
			cacheStatus: expect.stringMatching(/^(fresh|reindexed|stale)$/),
			results: expect.any(Array),
		});
	});

	it("exits with code 2 for invalid limit", () => {
		seedSuggestRepo();

		const result = spawnSync(
			"node",
			[CLI, "suggest", "persistence", "--limit", "0", tmpDir],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("ai-cortex:");
	});

	it("exits with code 2 for an empty task", () => {
		seedSuggestRepo();

		const result = spawnSync("node", [CLI, "suggest", "", tmpDir], {
			encoding: "utf8",
		});

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("ai-cortex:");
	});
});

describe("suggest-deep CLI", () => {
	it("runs and emits JSON with mode:deep", () => {
		seedSuggestRepo();

		const result = spawnSync(
			"node",
			[CLI, "suggest-deep", "persistence", "--json", tmpDir],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(0);
		const json = JSON.parse(result.stdout);
		expect(json.mode).toBe("deep");
		expect(Array.isArray(json.results)).toBe(true);
		expect(typeof json.poolSize).toBe("number");
	});

	it("text output has deep header and no escalation hint", () => {
		seedSuggestRepo();

		const result = spawnSync(
			"node",
			[CLI, "suggest-deep", "persistence", tmpDir],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("suggested files (deep) for: persistence");
		expect(result.stdout).not.toMatch(/^escalation hint: /m);
	});

	it("exits with code 1 on --pool non-numeric", () => {
		seedSuggestRepo();

		const result = spawnSync(
			"node",
			[CLI, "suggest-deep", "persistence", "--pool", "foo", tmpDir],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/--pool must be a number/);
	});

	it("exits with code 1 on --limit non-numeric", () => {
		seedSuggestRepo();

		const result = spawnSync(
			"node",
			[CLI, "suggest", "persistence", "--limit", "foo", tmpDir],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/--limit must be a number/);
	});
});

describe("ai-cortex --version", () => {
	const expectedVersion = JSON.parse(
		fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
	).version as string;

	it.each(["--version", "-v", "version"])(
		"prints version and exits 0 for '%s'",
		(flag) => {
			const result = spawnSync("node", [CLI, flag], { encoding: "utf8" });
			expect(result.status).toBe(0);
			expect(result.stdout).toBe(`ai-cortex ${expectedVersion}\n`);
		},
	);
});

describe("ai-cortex --help", () => {
	it.each(["--help", "-h", "help"])(
		"prints command list and exits 0 for '%s'",
		(flag) => {
			const result = spawnSync("node", [CLI, flag], { encoding: "utf8" });
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("ai-cortex <command>");
			expect(result.stdout).toContain("index");
			expect(result.stdout).toContain("rehydrate");
			expect(result.stdout).toContain("suggest");
			expect(result.stdout).toContain("mcp");
			expect(result.stdout).toContain("history");
			expect(result.stdout).toContain("memory");
		},
	);
});

function freshRepo(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-cli-flags-"));
	execFileSync("git", ["init", d]);
	execFileSync("git", ["-C", d, "config", "user.email", "test@test.com"]);
	execFileSync("git", ["-C", d, "config", "user.name", "Test"]);
	execFileSync("git", ["-C", d, "config", "commit.gpgsign", "false"]);
	fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "flags-repo", version: "1.0.0" }));
	fs.writeFileSync(path.join(d, "src.ts"), "export function f() { return 1; }\n");
	execFileSync("git", ["-C", d, "add", "."]);
	execFileSync("git", ["-C", d, "commit", "-m", "init"]);
	return d;
}
function dbFilesUnder(cacheHome: string): string[] {
	const out: string[] = [];
	const walk = (p: string) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith(".db") && !f.endsWith(".seq.db")) out.push(f); } };
	if (fs.existsSync(cacheHome)) walk(cacheHome);
	return out;
}

describe.each(["index", "rehydrate"])("%s CLI flag handling (A7)", (cmd) => {
	let repo: string;
	let cacheHome: string;
	beforeAll(() => { repo = freshRepo(); });
	afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));
	const env = () => { cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-cli-home-")); return { ...process.env, AI_CORTEX_CACHE_HOME: cacheHome }; };

	it.each(["--help", "-h"])("%s prints usage to stdout, exits 0, creates no store", (flag) => {
		const r = spawnSync("node", [CLI, cmd, flag, repo], { encoding: "utf8", env: env() });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`ai-cortex ${cmd}`);
		expect(r.stderr).toBe("");
		expect(dbFilesUnder(cacheHome)).toEqual([]);
	});

	it("--bogus prints usage naming the flag to stderr, exits 2, creates no store", () => {
		const r = spawnSync("node", [CLI, cmd, "--bogus", repo], { encoding: "utf8", env: env() });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("unknown flag: --bogus");
		expect(r.stderr).toContain(`ai-cortex ${cmd}`);
		expect(r.stdout).toBe("");
		expect(dbFilesUnder(cacheHome)).toEqual([]);
	});

	it("--bogus --json is still rejected with the same usage and flag name on stderr and no partial JSON", () => {
		const r = spawnSync("node", [CLI, cmd, "--bogus", "--json", repo], { encoding: "utf8", env: env() });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("unknown flag: --bogus");
		expect(r.stderr).toContain(`ai-cortex ${cmd}`);
		expect(r.stdout).toBe("");
		expect(dbFilesUnder(cacheHome)).toEqual([]);
	});
});

describe("index / rehydrate --json (A7)", () => {
	const A7_FIELDS = ["cacheStatus", "packageName", "fileCount", "docCount", "dbPath", "schemaVersion", "fingerprint", "contentFingerprint", "indexSeq", "indexedAt", "dirtyAtIndex"];
	let repo: string;
	beforeAll(() => { repo = freshRepo(); });
	afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

	it("index --json has every A7 field and no briefingPath; human output prints the .db path", () => {
		const j = spawnSync("node", [CLI, "index", "--json", repo], { encoding: "utf8" });
		expect(j.status).toBe(0);
		const obj = JSON.parse(j.stdout);
		for (const f of A7_FIELDS) expect(obj).toHaveProperty(f);
		expect(obj).not.toHaveProperty("briefingPath");
		expect(obj.schemaVersion).toBe("3.2");
		expect(obj.dbPath).toMatch(/\.db$/);
		expect(["fresh", "reindexed"]).toContain(obj.cacheStatus);
		const h = spawnSync("node", [CLI, "index", repo], { encoding: "utf8" });
		expect(h.stdout).toMatch(/cache: .*\.db\n/);
		expect(h.stdout).not.toContain(".json");
	});

	it("rehydrate --json keeps the existing fields and adds the A7 fields", () => {
		const r = spawnSync("node", [CLI, "rehydrate", "--json", repo], { encoding: "utf8" });
		expect(r.status).toBe(0);
		const obj = JSON.parse(r.stdout);
		for (const f of ["briefingPath", ...A7_FIELDS]) expect(obj).toHaveProperty(f);
		expect(typeof obj.indexSeq).toBe("number");
	});

	it("two consecutive index --refresh --json runs report n and n+1 with unchanged fingerprints", () => {
		const one = JSON.parse(spawnSync("node", [CLI, "index", "--refresh", "--json", repo], { encoding: "utf8" }).stdout);
		const two = JSON.parse(spawnSync("node", [CLI, "index", "--refresh", "--json", repo], { encoding: "utf8" }).stdout);
		expect(one.cacheStatus).toBe("reindexed");
		expect(two.cacheStatus).toBe("reindexed");
		expect(two.indexSeq).toBe(one.indexSeq + 1);
		expect(two.fingerprint).toBe(one.fingerprint);
		expect(two.contentFingerprint).toBe(one.contentFingerprint);
	});

	it("rehydrate --stale --json on an out-of-date store reports stale and does not move indexSeq", () => {
		const before = JSON.parse(spawnSync("node", [CLI, "rehydrate", "--json", repo], { encoding: "utf8" }).stdout);
		fs.appendFileSync(path.join(repo, "src.ts"), "export const dirty = 1;\n");
		const stale = JSON.parse(spawnSync("node", [CLI, "rehydrate", "--stale", "--json", repo], { encoding: "utf8" }).stdout);
		expect(stale.cacheStatus).toBe("stale");
		expect(stale.indexSeq).toBe(before.indexSeq);
		const dirty = JSON.parse(spawnSync("node", [CLI, "rehydrate", "--json", repo], { encoding: "utf8" }).stdout);
		expect(dirty.cacheStatus).toBe("reindexed");
		expect(dirty.indexSeq).toBe(before.indexSeq + 1);
		expect(dirty.contentFingerprint).not.toBe(before.contentFingerprint);
		expect(dirty.fingerprint).toBe(before.fingerprint);
		expect(dirty.dirtyAtIndex).toBe(true);
	});

	it("index --json on a non-git directory exits 1 with one ai-cortex: line on stderr and empty stdout", () => {
		const r = spawnSync("node", [CLI, "index", "--json", os.tmpdir()], { encoding: "utf8" });
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
		expect(r.stderr.trim().split("\n")).toHaveLength(1);
		expect(r.stderr).toMatch(/^ai-cortex:/);
	});
});

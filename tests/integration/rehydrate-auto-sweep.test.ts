// tests/integration/rehydrate-auto-sweep.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distCli = path.resolve(
	fileURLToPath(import.meta.url),
	"../../../dist/src/cli.js",
);

describe("rehydrate_project auto-sweep wiring (spec §4.4, acceptance 5)", () => {
	let cacheRoot: string;
	let repoDir: string;

	beforeAll(async () => {
		cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicortex-autosweep-"));
		repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosweep-repo-"));
		execFileSync("git", ["init"], { cwd: repoDir });
		await fs.writeFile(path.join(repoDir, "a.txt"), "x\n");
		execFileSync("git", ["add", "."], { cwd: repoDir });
		execFileSync(
			"git",
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
			{ cwd: repoDir },
		);
	});
	afterAll(async () => {
		await fs.rm(cacheRoot, { recursive: true, force: true });
		await fs.rm(repoDir, { recursive: true, force: true });
	});

	it("two consecutive rehydrate_project calls run the sweep exactly once", async () => {
		const transport = new StdioClientTransport({
			command: "node",
			args: [distCli, "mcp"],
			env: { ...process.env, AI_CORTEX_CACHE_HOME: cacheRoot } as Record<
				string,
				string
			>,
		});
		const client = new Client(
			{ name: "autosweep-test", version: "0.0.1" },
			{ capabilities: {} },
		);
		await client.connect(transport);
		try {
			// AI_CORTEX_CACHE_HOME set directly (no implicit "v1" segment —
			// getCacheDir() only inserts "v1" for the homedir-default path, see
			// src/lib/cache-store.ts) → bucket dirs are direct children of
			// cacheRoot: <cacheRoot>/<repoKeyHash>/memory/.last-auto-sweep.
			const readSentinels = async (): Promise<string> => {
				const buckets = await fs.readdir(cacheRoot).catch(() => [] as string[]);
				const stamps = await Promise.all(
					buckets.map((b) =>
						fs
							.readFile(
								path.join(cacheRoot, b, "memory", ".last-auto-sweep"),
								"utf8",
							)
							.catch(() => ""),
					),
				);
				return stamps.join("|");
			};

			const first = await client.callTool({
				name: "rehydrate_project",
				arguments: { path: repoDir },
			});
			// briefing still returned (sweep must never degrade the response)
			expect(JSON.stringify(first.content)).toContain("cache:");
			const s1 = await readSentinels();
			expect(s1.replace(/\|/g, "").trim().length).toBeGreaterThan(0); // sentinel written → sweep attempted once

			const second = await client.callTool({
				name: "rehydrate_project",
				arguments: { path: repoDir },
			});
			expect(JSON.stringify(second.content)).toContain("cache:");
			const s2 = await readSentinels();
			// identical sentinel content across the second call ⇒ rate limit
			// held ⇒ the sweep ran exactly once across both rehydrates
			expect(s2).toBe(s1);
		} finally {
			await client.close();
		}
	}, 30000);
});

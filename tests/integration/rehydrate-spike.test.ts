import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCache } from "../../src/spike/build-cache.js";
import { coldOrient } from "../../src/spike/cold-orient.js";
import { measure } from "../../src/spike/measure.js";
import { rehydrateFromCache } from "../../src/spike/rehydrate.js";
import { runPhase0 } from "../../src/spike/run-phase-0.js";
import { extractImportEdgesFromSource } from "../../src/spike/ts-import-graph.js";

describe("phase 0 spike workspace", () => {
	it("loads the spike entrypoint", async () => {
		const mod = await import("../../src/spike/run-phase-0.js");
		expect(typeof mod.runPhase0).toBe("function");
	});

	it("extracts relative import edges from TypeScript source", () => {
		const edges = extractImportEdgesFromSource(
			"src/a.ts",
			"import { b } from './b';\nimport c from '../shared/c';\nimport x from 'react';"
		);

		expect(edges).toEqual([
			{ from: "src/a.ts", to: "src/b" },
			{ from: "src/a.ts", to: "shared/c" }
		]);
	});

	it("builds a repo cache with files and docs", () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-phase0-"));
		fs.writeFileSync(path.join(repoRoot, "README.md"), "# Example Repo\n");
		fs.mkdirSync(path.join(repoRoot, "src"));
		fs.writeFileSync(path.join(repoRoot, "src", "main.ts"), "export const x = 1;\n");

		// This spike currently writes cache files into the real user cache dir.
		// That is acceptable for Phase 0, but test runs will leave cache artifacts behind.
		const cache = buildCache(repoRoot);
		expect(cache.repoPath).toBe(repoRoot);
		expect(cache.files.some(node => node.path === "README.md")).toBe(true);
		expect(cache.docs[0]?.path).toBe("README.md");
	});

	it("produces a compact rehydration summary", () => {
		const cache = {
			repoPath: "/tmp/example",
			repoKey: "abc123",
			indexedAt: "2026-04-10T00:00:00.000Z",
			fingerprint: "fingerprint-1",
			files: [
				{ path: "README.md", kind: "file" as const },
				{ path: "src/main.tsx", kind: "file" as const },
				{ path: "src/app/App.tsx", kind: "file" as const }
			],
			docs: [
				{
					path: "README.md",
					title: "Example Repo",
					body: "# Example Repo\nSession-first workflow\n"
				}
			],
			imports: [{ from: "src/main.tsx", to: "src/app/App" }]
		};

		const result = rehydrateFromCache(cache);
		expect(result.summary).toContain("Example Repo");
		expect(result.priorityFiles).toContain("src/main.tsx");
	});

	it("uses entry-file heuristics instead of cache import order", () => {
		const cache = {
			repoPath: "/tmp/example",
			repoKey: "abc123",
			indexedAt: "2026-04-10T00:00:00.000Z",
			fingerprint: "fingerprint-1",
			files: [
				{ path: "README.md", kind: "file" as const },
				{ path: "src/app/App.tsx", kind: "file" as const },
				{ path: "src/main.tsx", kind: "file" as const },
				{ path: "electron/main/index.ts", kind: "file" as const },
				{ path: "services/workspace/workspace-persistence-service.ts", kind: "file" as const }
			],
			docs: [
				{
					path: "README.md",
					title: "Example Repo",
					body: "# Example Repo\nSession-first workflow\n"
				}
			],
			imports: [
				{ from: "services/workspace/workspace-persistence-service.ts", to: "src/app/App" },
				{ from: "src/app/App.tsx", to: "src/main" }
			]
		};

		const result = rehydrateFromCache(cache);
		expect(result.priorityFiles[0]).toBe("electron/main/index.ts");
		expect(result.priorityFiles).toContain("src/main.tsx");
		expect(result.priorityFiles).toContain("src/app/App.tsx");
	});

	it("measures operation duration", async () => {
		const result = await measure("noop", async () => 42);

		expect(result.label).toBe("noop");
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.value).toBe(42);
	});

	it("rehydrates from existing cache without rebuilding when fingerprint matches", async () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-rehydrate-"));
		fs.writeFileSync(path.join(repoRoot, "README.md"), "# Example Repo\n");
		fs.mkdirSync(path.join(repoRoot, "src"));
		fs.writeFileSync(path.join(repoRoot, "src", "main.ts"), "export const x = 1;\n");

		buildCache(repoRoot);
		const output = await runPhase0(repoRoot, { writeToStdout: false });

		expect(output.cacheStatus).toBe("fresh");
		expect(output.stale).toBe(false);
		expect(output.summary).toContain("Example Repo");
	});

	it("cold-orients a repo into the same summary shape without cache", () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-cold-orient-"));
		fs.writeFileSync(path.join(repoRoot, "README.md"), "# Example Repo\n");
		fs.writeFileSync(
			path.join(repoRoot, "package.json"),
			JSON.stringify({ name: "example-repo", private: true }, null, 2) + "\n"
		);
		fs.mkdirSync(path.join(repoRoot, "electron", "main"), { recursive: true });
		fs.mkdirSync(path.join(repoRoot, "src", "app"), { recursive: true });
		fs.writeFileSync(
			path.join(repoRoot, "electron", "main", "index.ts"),
			"import { startApp } from '../../src/app/App';\nexport { startApp };\n"
		);
		fs.writeFileSync(
			path.join(repoRoot, "src", "app", "App.ts"),
			"export function startApp() { return 'ok'; }\n"
		);

		const result = coldOrient(repoRoot);
		expect(result.summary).toContain("Example Repo");
		expect(result.priorityDocs).toContain("README.md");
		expect(result.priorityFiles).toContain("electron/main/index.ts");
		expect(result.cacheStatus).toBe("missing");
	});
});

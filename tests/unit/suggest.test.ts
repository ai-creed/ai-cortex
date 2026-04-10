import { describe, expect, it } from "vitest";
import { suggestFiles } from "../../src/spike/suggest.js";

describe("suggestFiles", () => {
	it("prefers files that match task words and doc titles", () => {
		const results = suggestFiles(
			"inspect persistence logic",
			{
				repoPath: "/tmp/example",
				repoKey: "abc",
				indexedAt: "2026-04-10T00:00:00.000Z",
				fingerprint: "fingerprint-1",
				files: [
					{ path: "src/persistence/store.ts", kind: "file" },
					{ path: "src/viewer/FileViewer.tsx", kind: "file" },
					{ path: "docs/shared/architecture_decisions.md", kind: "file" }
				],
				docs: [
					{
						path: "docs/shared/architecture_decisions.md",
						title: "Architecture Decisions",
						body: "Persistence boundary and restore behavior."
					}
				],
				imports: []
			},
			3
		);

		expect(results[0]?.path).toBe("src/persistence/store.ts");
		expect(results[0]?.reason).toContain("persistence");
	});

	it("prefers code files over docs when both match the same task terms", () => {
		const results = suggestFiles(
			"inspect persistence logic",
			{
				repoPath: "/tmp/example",
				repoKey: "abc",
				indexedAt: "2026-04-10T00:00:00.000Z",
				fingerprint: "fingerprint-1",
				files: [
					{
						path: "docs/superpowers/specs/2026-04-04-phase-5-persistence-and-restore-design.md",
						kind: "file"
					},
					{ path: "services/workspace/workspace-persistence-service.ts", kind: "file" }
				],
				docs: [
					{
						path: "docs/superpowers/specs/2026-04-04-phase-5-persistence-and-restore-design.md",
						title: "Phase 5 Persistence And Restore Design",
						body: "Persistence and restore flow."
					}
				],
				imports: []
			},
			2
		);

		expect(results[0]?.path).toBe("services/workspace/workspace-persistence-service.ts");
	});

	it("matches exact path tokens instead of substrings inside larger words", () => {
		const results = suggestFiles(
			"review the main ui shell",
			{
				repoPath: "/tmp/example",
				repoKey: "abc",
				indexedAt: "2026-04-10T00:00:00.000Z",
				fingerprint: "fingerprint-1",
				files: [
					{ path: "electron-builder.yml", kind: "file" },
					{ path: "src/app/shell.tsx", kind: "file" }
				],
				docs: [],
				imports: []
			},
			1
		);

		expect(results[0]?.path).toBe("src/app/shell.tsx");
	});
});

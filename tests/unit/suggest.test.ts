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
});

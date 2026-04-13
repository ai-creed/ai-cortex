// tests/unit/lib/briefing.test.ts
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../../src/lib/models.js";
import type { RepoCache } from "../../../src/lib/models.js";
import { renderBriefing } from "../../../src/lib/briefing.js";

function makeCache(overrides: Partial<RepoCache> = {}): RepoCache {
	return {
		schemaVersion: SCHEMA_VERSION,
		repoKey: "aabbccdd11223344",
		worktreeKey: "eeff00112233aabb",
		worktreePath: "/repo",
		indexedAt: "2026-04-10T09:30:00.000Z",
		fingerprint: "abc123",
		packageMeta: {
			name: "test-app",
			version: "1.2.3",
			framework: "electron",
		},
		entryFiles: ["electron/main/index.ts", "src/main.tsx"],
		files: [
			{ path: "README.md", kind: "file" },
			{ path: "package.json", kind: "file" },
			{ path: "electron/main/index.ts", kind: "file" },
			{ path: "electron/preload/index.ts", kind: "file" },
			{ path: "src/main.tsx", kind: "file" },
			{ path: "src/app/App.tsx", kind: "file" },
			{ path: "src/features/auth.ts", kind: "file" },
			{ path: "shared/models/user.ts", kind: "file" },
			{ path: "tests/unit/app.test.ts", kind: "file" },
			{ path: "docs/guide.md", kind: "file" },
		],
		docs: [
			{ path: "README.md", title: "Test App", body: "# Test App\n" },
			{
				path: "docs/guide.md",
				title: "Guide",
				body: "# Guide\n",
			},
		],
		imports: [
			{ from: "src/main.tsx", to: "src/app/App" },
			{ from: "src/app/App.tsx", to: "shared/models/user" },
			{ from: "src/features/auth.ts", to: "shared/models/user" },
			{ from: "electron/main/index.ts", to: "shared/models/user" },
		],
		calls: [],
		functions: [],
		...overrides,
	};
}

describe("renderBriefing", () => {
	it("renders header with project name, framework, version, file count, timestamp", () => {
		const md = renderBriefing(makeCache());
		expect(md).toContain("# test-app");
		expect(md).toContain("**Framework:** electron");
		expect(md).toContain("**Version:** 1.2.3");
		expect(md).toContain("**Files:** 10");
		expect(md).toContain("**Indexed:** 2026-04-10T09:30:00.000Z");
	});

	it("omits framework when null", () => {
		const md = renderBriefing(
			makeCache({
				packageMeta: { name: "app", version: "1.0.0", framework: null },
			}),
		);
		expect(md).not.toContain("**Framework:**");
		expect(md).toContain("**Version:** 1.0.0");
	});

	it("renders key docs section with top 3 paths and titles", () => {
		const md = renderBriefing(makeCache());
		expect(md).toContain("## Key Docs");
		expect(md).toContain("- `README.md` — Test App");
		expect(md).toContain("- `docs/guide.md` — Guide");
	});

	it("renders entry files section", () => {
		const md = renderBriefing(makeCache());
		expect(md).toContain("## Entry Files");
		expect(md).toContain("- `electron/main/index.ts`");
		expect(md).toContain("- `src/main.tsx`");
	});

	it("derives directory structure from files (top 2 levels, dirs only)", () => {
		const md = renderBriefing(makeCache());
		expect(md).toContain("## Directory Structure");
		expect(md).toContain("electron/");
		expect(md).toContain("  main/");
		expect(md).toContain("  preload/");
		expect(md).toContain("src/");
		expect(md).toContain("  app/");
		expect(md).toContain("  features/");
		expect(md).toContain("shared/");
		expect(md).toContain("  models/");
		expect(md).toContain("tests/");
		expect(md).toContain("  unit/");
	});

	it("computes import hot spots sorted by inbound count", () => {
		const md = renderBriefing(makeCache());
		expect(md).toContain("## Import Hot Spots");
		expect(md).toContain("- `shared/models/user` (3 importers)");
		expect(md).toContain("- `src/app/App` (1 importers)");
	});

	it("omits import hot spots section when imports is empty", () => {
		const md = renderBriefing(makeCache({ imports: [] }));
		expect(md).not.toContain("## Import Hot Spots");
	});

	it("handles empty docs gracefully", () => {
		const md = renderBriefing(makeCache({ docs: [] }));
		expect(md).toContain("## Key Docs");
		// Extract just the Key Docs section and verify it has no bullet lines
		const keyDocsSection = md.split("## Key Docs")[1].split("##")[0];
		expect(keyDocsSection).not.toContain("- `");
	});

	it("handles empty entry files gracefully", () => {
		const md = renderBriefing(makeCache({ entryFiles: [] }));
		expect(md).toContain("## Entry Files");
	});

	it("handles empty files gracefully", () => {
		const md = renderBriefing(makeCache({ files: [] }));
		expect(md).toContain("## Directory Structure");
	});
});

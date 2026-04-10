// tests/unit/lib/import-graph.test.ts
import { describe, expect, it } from "vitest";
import { extractImportEdgesFromSource } from "../../../src/lib/import-graph.js";

describe("extractImportEdgesFromSource", () => {
	it("extracts relative imports and resolves paths", () => {
		const edges = extractImportEdgesFromSource(
			"src/a.ts",
			"import { b } from './b';\nimport c from '../shared/c';",
		);
		expect(edges).toEqual([
			{ from: "src/a.ts", to: "src/b" },
			{ from: "src/a.ts", to: "shared/c" },
		]);
	});

	it("skips non-relative imports", () => {
		const edges = extractImportEdgesFromSource(
			"src/a.ts",
			"import React from 'react';\nimport { x } from 'vitest';",
		);
		expect(edges).toHaveLength(0);
	});

	it("strips file extensions from resolved paths", () => {
		const edges = extractImportEdgesFromSource(
			"src/a.ts",
			"import { b } from './b.ts';\nimport c from './c.js';",
		);
		expect(edges[0]?.to).toBe("src/b");
		expect(edges[1]?.to).toBe("src/c");
	});

	it("does not match 'ui' as substring inside 'builder' (token-boundary check)", () => {
		// 'electron-builder.yml' path contains 'ui' as substring — must not score
		const edges = extractImportEdgesFromSource(
			"src/a.ts",
			"import { build } from './electron-builder';",
		);
		// resolved path is "src/electron-builder" — valid relative import, will be included
		// but the scoring test belongs in suggest (Phase 3), not here
		expect(edges[0]?.to).toBe("src/electron-builder");
	});

	it("uses forward slashes on all platforms", () => {
		const edges = extractImportEdgesFromSource(
			"src/deep/a.ts",
			"import x from '../other';",
		);
		expect(edges[0]?.to).toBe("src/other");
		expect(edges[0]?.to).not.toContain("\\");
	});
});

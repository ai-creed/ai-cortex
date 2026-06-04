import { describe, it, expect } from "vitest";
import {
	projectId,
	fileId,
	dirId,
	symbolId,
	memoryNodeId,
} from "../../../../src/lib/graph/types.js";

describe("graph node id helpers", () => {
	it("namespaces every id by store key", () => {
		expect(projectId("abc123")).toBe("project:abc123");
		expect(fileId("abc123", "src/a.ts")).toBe("file:abc123:src/a.ts");
		expect(dirId("abc123", "src")).toBe("dir:abc123:src");
		expect(symbolId("abc123", "src/a.ts", "Foo.bar")).toBe(
			"symbol:abc123:src/a.ts::Foo.bar",
		);
		expect(memoryNodeId("abc123", "mem-1")).toBe("memory:abc123:mem-1");
		expect(memoryNodeId("global", "mem-1")).toBe("memory:global:mem-1");
	});

	it("keeps the same raw id distinct across stores", () => {
		expect(memoryNodeId("repoA", "dup")).not.toBe(memoryNodeId("repoB", "dup"));
	});
});

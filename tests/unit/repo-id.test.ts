import { describe, expect, it } from "vitest";
import { getRepoKey } from "../../src/spike/repo-id.js";

describe("getRepoKey", () => {
	it("returns a stable key for the same repo path", () => {
		const a = getRepoKey("/tmp/example-repo");
		const b = getRepoKey("/tmp/example-repo");
		expect(a).toBe(b);
	});

	it("changes when the repo path changes", () => {
		const a = getRepoKey("/tmp/example-repo-a");
		const b = getRepoKey("/tmp/example-repo-b");
		expect(a).not.toBe(b);
	});
});

// tests/unit/lib/memory/id.test.ts
import { describe, it, expect } from "vitest";
import { generateMemoryId, deriveSlug } from "../../../../src/lib/memory/id.js";

describe("deriveSlug", () => {
	it("kebab-cases simple titles", () => {
		expect(deriveSlug("Cache writes use atomic temp-file rename")).toBe(
			"cache-writes-use-atomic-temp-file-rename",
		);
	});

	it("strips punctuation and collapses whitespace", () => {
		expect(deriveSlug("Hello, World! — what a `title`")).toBe(
			"hello-world-what-a-title",
		);
	});

	it("caps slug at 40 chars on word boundary when possible", () => {
		const long =
			"this title is intentionally written to be way longer than the cap allows";
		const slug = deriveSlug(long);
		expect(slug.length).toBeLessThanOrEqual(40);
		expect(slug).not.toMatch(/-$/);
	});

	it("returns a non-empty fallback when every char strips out", () => {
		expect(deriveSlug("@@@!!!---")).toBe("memory");
	});
});

describe("generateMemoryId", () => {
	it("matches mem-YYYY-MM-DD-<slug>-<6hex>", () => {
		const id = generateMemoryId(
			"Cache writes",
			new Date("2026-04-30T09:18:44Z"),
		);
		expect(id).toMatch(/^mem-2026-04-30-cache-writes-[0-9a-f]{6}$/);
	});

	it("produces 6-hex suffixes that are well-distributed across small batches", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			seen.add(
				generateMemoryId("same title", new Date("2026-04-30T00:00:00Z")),
			);
		}
		expect(seen.size).toBeGreaterThanOrEqual(195);
	});

	it("uses UTC date even when locale would differ", () => {
		const id = generateMemoryId("late night", new Date("2026-04-30T00:00:00Z"));
		expect(id).toMatch(/^mem-2026-04-30-late-night-[0-9a-f]{6}$/);
	});
});

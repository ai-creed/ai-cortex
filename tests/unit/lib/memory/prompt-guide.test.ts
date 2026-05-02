import { describe, it, expect } from "vitest";
import {
	PROMPT_GUIDE_VERSION,
	MEMORY_GUIDE_TEXT,
	applyInstall,
	applyUninstall,
	extractGuideVersion,
} from "../../../../src/lib/memory/prompt-guide.js";

describe("MEMORY_GUIDE_TEXT", () => {
	it("teaches the cardinal recall→get pattern", () => {
		expect(MEMORY_GUIDE_TEXT).toMatch(/recall_memory/);
		expect(MEMORY_GUIDE_TEXT).toMatch(/get_memory/);
		expect(MEMORY_GUIDE_TEXT).toMatch(/cardinal pattern/i);
	});

	it("references the write tools", () => {
		expect(MEMORY_GUIDE_TEXT).toMatch(/record_memory/);
		expect(MEMORY_GUIDE_TEXT).toMatch(/deprecate_memory/);
	});
});

describe("applyInstall", () => {
	it("appends the block to an empty file", () => {
		const out = applyInstall("");
		expect(out).toContain(`<!-- ai-cortex:memory-rule:start ${PROMPT_GUIDE_VERSION} -->`);
		expect(out).toContain("<!-- ai-cortex:memory-rule:end -->");
		expect(out).toContain("recall_memory");
	});

	it("appends to an existing file with separating blank line", () => {
		const before = "# My project\n\nSome content here.\n";
		const after = applyInstall(before);
		expect(after.startsWith(before)).toBe(true);
		expect(after).toContain("<!-- ai-cortex:memory-rule:start");
	});

	it("is idempotent — running twice produces the same output", () => {
		const once = applyInstall("");
		const twice = applyInstall(once);
		expect(twice).toBe(once);
	});

	it("replaces older version blocks in place", () => {
		const olderBlock = `<!-- ai-cortex:memory-rule:start v0 -->\nold guidance\n<!-- ai-cortex:memory-rule:end -->`;
		const before = `# Project\n\n${olderBlock}\n`;
		const after = applyInstall(before);
		expect(after).not.toContain("old guidance");
		expect(after).toContain(`v${PROMPT_GUIDE_VERSION.slice(1)} -->` /* allow exact match */);
		expect(extractGuideVersion(after)).toBe(PROMPT_GUIDE_VERSION);
	});

	it("preserves content before and after the replaced block", () => {
		const before = `# Project\n\n<!-- ai-cortex:memory-rule:start v0 -->\nold\n<!-- ai-cortex:memory-rule:end -->\n\n## More content\n`;
		const after = applyInstall(before);
		expect(after.startsWith("# Project\n")).toBe(true);
		expect(after).toContain("## More content");
	});
});

describe("applyUninstall", () => {
	it("removes the block when present", () => {
		const installed = applyInstall("# Project\n\nIntro.\n");
		const removed = applyUninstall(installed);
		expect(removed).not.toContain("<!-- ai-cortex:memory-rule:start");
		expect(removed).toContain("# Project");
		expect(removed).toContain("Intro.");
	});

	it("is a no-op when the block is absent", () => {
		const before = "# Project\n\nNo guidance here.\n";
		expect(applyUninstall(before)).toBe(before);
	});

	it("removes block + surrounding blank lines but leaves other content intact", () => {
		const installed = applyInstall("# A\n\n## B\n");
		const removed = applyUninstall(installed);
		expect(removed).toContain("# A");
		expect(removed).toContain("## B");
		expect(removed).not.toContain("ai-cortex:memory-rule");
	});
});

describe("extractGuideVersion", () => {
	it("returns the version string when block present", () => {
		const installed = applyInstall("");
		expect(extractGuideVersion(installed)).toBe(PROMPT_GUIDE_VERSION);
	});

	it("returns null when block absent", () => {
		expect(extractGuideVersion("# Just a header\n")).toBeNull();
	});

	it("detects older version markers", () => {
		const v0 = `<!-- ai-cortex:memory-rule:start v0 -->\nold\n<!-- ai-cortex:memory-rule:end -->`;
		expect(extractGuideVersion(v0)).toBe("v0");
	});
});

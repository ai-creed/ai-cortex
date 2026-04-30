import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openLifecycle, createMemory, pinMemory } from "../../../../src/lib/memory/lifecycle.js";
import { renderPinnedSection } from "../../../../src/lib/memory/briefing-pinned.js";

let tmp: string;
let repoKey: string;

beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-bp-"));
    process.env.AI_CORTEX_CACHE_HOME = tmp;
    repoKey = "test-briefing-pinned";
});
afterEach(async () => {
    delete process.env.AI_CORTEX_CACHE_HOME;
    await fs.rm(tmp, { recursive: true, force: true });
});

describe("renderPinnedSection", () => {
    it("returns null when no pinned or auto-selected memories", async () => {
        // Create an active memory that is NOT pinned and confidence < 0.9
        const lc = await openLifecycle(repoKey, { agentId: "test" });
        try {
            await createMemory(lc, {
                type: "pattern", title: "Some pattern", body: "## Body\ncontent",
                scope: { files: [], tags: [] }, source: "explicit",
            });
        } finally { lc.close(); }

        const result = await renderPinnedSection(repoKey);
        expect(result).toBeNull();
    });

    it("includes explicitly pinned memory", async () => {
        const lc = await openLifecycle(repoKey, { agentId: "test" });
        let id: string;
        try {
            id = await createMemory(lc, {
                type: "decision", title: "Always use pnpm", body: "## Decision\nuse pnpm",
                scope: { files: [], tags: [] }, source: "explicit",
            });
            await pinMemory(lc, id);
        } finally { lc.close(); }

        const result = await renderPinnedSection(repoKey);
        expect(result).not.toBeNull();
        expect(result).toMatch(/## Pinned memories/);
        expect(result).toMatch(/Always use pnpm/);
    });

    it("auto-selects active decision/gotcha with confidence >= 0.9 and no file scope", async () => {
        const lc = await openLifecycle(repoKey, { agentId: "test" });
        try {
            await createMemory(lc, {
                type: "gotcha", title: "Never mutate cache", body: "## Gotcha\nread-only",
                scope: { files: [], tags: [] }, source: "explicit",
                confidence: 0.9, typeFields: { severity: "warning" },
            });
        } finally { lc.close(); }

        const result = await renderPinnedSection(repoKey);
        expect(result).not.toBeNull();
        expect(result).toMatch(/Never mutate cache/);
    });

    it("does NOT auto-select decision with confidence < 0.9", async () => {
        const lc = await openLifecycle(repoKey, { agentId: "test" });
        try {
            await createMemory(lc, {
                type: "decision", title: "Low confidence decision", body: "## Decision\ncontent",
                scope: { files: [], tags: [] }, source: "explicit",
                confidence: 0.5, // explicitly set low confidence
            });
        } finally { lc.close(); }

        const result = await renderPinnedSection(repoKey);
        expect(result).toBeNull();
    });

    it("does NOT auto-select memories scoped to specific files", async () => {
        const lc = await openLifecycle(repoKey, { agentId: "test" });
        try {
            // confidence 1.0 (explicit source) but excluded by file scope
            await createMemory(lc, {
                type: "decision", title: "File-scoped decision", body: "## Decision\ncontent",
                scope: { files: ["src/foo.ts"], tags: [] }, source: "explicit",
            });
        } finally { lc.close(); }

        const result = await renderPinnedSection(repoKey);
        expect(result).toBeNull();
    });

    it("renders formatted markdown with type and id", async () => {
        const lc = await openLifecycle(repoKey, { agentId: "test" });
        let id: string;
        try {
            id = await createMemory(lc, {
                type: "pattern", title: "Use dependency injection", body: "## Pattern\nuse DI",
                scope: { files: [], tags: [] }, source: "explicit",
            });
            await pinMemory(lc, id);
        } finally { lc.close(); }

        const result = await renderPinnedSection(repoKey);
        expect(result).toMatch(/\*\*pattern\*\*/);
        expect(result).toMatch(new RegExp(id!));
    });
});

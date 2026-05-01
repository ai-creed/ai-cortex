// tests/unit/lib/memory/global-tier.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import {
  openLifecycle,
  openGlobalLifecycle,
  createMemory,
  promoteToGlobal,
} from "../../../../src/lib/memory/lifecycle.js";
import {
  openRetrieve,
  recallMemory,
  recallMemoryCrossTier,
} from "../../../../src/lib/memory/retrieve.js";

let repoKey: string;

beforeEach(async () => {
  repoKey = await mkRepoKey("global-tier-test");
});
afterEach(async () => {
  await cleanupRepo(repoKey);
});

describe("openGlobalLifecycle", () => {
  it("opens a lifecycle with repoKey=global", async () => {
    const lc = await openGlobalLifecycle({ agentId: "test" });
    try {
      expect(lc.repoKey).toBe("global");
    } finally {
      lc.close();
    }
  });

  it("can create a memory in the global store", async () => {
    const lc = await openGlobalLifecycle({ agentId: "test" });
    try {
      const id = await createMemory(lc, {
        type: "gotcha",
        title: "global gotcha",
        body: "## Body\nglobal",
        scope: { files: [], tags: ["ts"] },
        source: "explicit",
        typeFields: { severity: "info" },
      });
      expect(id).toMatch(/^mem-/);
      expect(lc.index.getMemory(id)?.status).toBe("active");
    } finally {
      lc.close();
    }
  });
});

describe("promoteToGlobal", () => {
  it("creates a copy in global with promotedFrom set", async () => {
    const lc = await openLifecycle(repoKey, { agentId: "test" });
    let globalId: string;
    try {
      const id = await createMemory(lc, {
        type: "gotcha",
        title: "promote me",
        body: "## Body\nshould go global",
        scope: { files: [], tags: ["node"] },
        source: "explicit",
        typeFields: { severity: "warning" },
      });

      globalId = await promoteToGlobal(lc, id);

      const globalLc = await openGlobalLifecycle({ agentId: "test" });
      try {
        const globalRow = globalLc.index.getMemory(globalId);
        expect(globalRow?.status).toBe("active");
        expect(globalRow?.title).toBe("promote me");

        const { readMemoryFile } = await import("../../../../src/lib/memory/store.js");
        const globalRecord = await readMemoryFile("global", globalId, "memories");
        expect(globalRecord.frontmatter.promotedFrom).toEqual([
          { repoKey, memoryId: id },
        ]);
      } finally {
        globalLc.close();
      }
    } finally {
      lc.close();
    }
  });

  it("marks original as merged_into pointing to global id", async () => {
    const lc = await openLifecycle(repoKey, { agentId: "test" });
    try {
      const id = await createMemory(lc, {
        type: "gotcha",
        title: "promote me too",
        body: "## Body\noriginal",
        scope: { files: [], tags: [] },
        source: "explicit",
        typeFields: { severity: "critical" },
      });

      const globalId = await promoteToGlobal(lc, id);

      const origRow = lc.index.getMemory(id);
      expect(origRow?.status).toBe("merged_into");

      const { readMemoryFile } = await import("../../../../src/lib/memory/store.js");
      const origRecord = await readMemoryFile(repoKey, id, "memories");
      expect(origRecord.frontmatter.mergedInto).toBe(globalId);
    } finally {
      lc.close();
    }
  });

  it("throws when memory does not exist", async () => {
    const lc = await openLifecycle(repoKey, { agentId: "test" });
    try {
      await expect(promoteToGlobal(lc, "mem-nonexistent")).rejects.toThrow(
        "memory not found",
      );
    } finally {
      lc.close();
    }
  });

  it("throws when memory is already merged_into", async () => {
    const lc = await openLifecycle(repoKey, { agentId: "test" });
    try {
      const id = await createMemory(lc, {
        type: "gotcha",
        title: "merge guard test",
        body: "## Body\ntest",
        scope: { files: [], tags: [] },
        source: "explicit",
        typeFields: { severity: "info" },
      });
      // First promote succeeds
      await promoteToGlobal(lc, id);
      // Second promote should throw because original is now merged_into
      await expect(promoteToGlobal(lc, id)).rejects.toThrow("merged_into");
    } finally {
      lc.close();
    }
  });

  it("throws when memory is trashed", async () => {
    const lc = await openLifecycle(repoKey, { agentId: "test" });
    try {
      const { trashMemory } = await import("../../../../src/lib/memory/lifecycle.js");
      const id = await createMemory(lc, {
        type: "gotcha",
        title: "trash guard test",
        body: "## Body\ntest",
        scope: { files: [], tags: [] },
        source: "explicit",
        typeFields: { severity: "info" },
      });
      await trashMemory(lc, id, "test-trash");
      await expect(promoteToGlobal(lc, id)).rejects.toThrow("trashed");
    } finally {
      lc.close();
    }
  });
});

describe("recallMemoryCrossTier", () => {
  it("returns results from both project and global stores", async () => {
    // Create in project
    const projectLc = await openLifecycle(repoKey, { agentId: "test" });
    try {
      await createMemory(projectLc, {
        type: "decision",
        title: "TypeScript strict mode decision",
        body: "## Body\nAlways enable strict mode",
        scope: { files: [], tags: ["ts"] },
        source: "explicit",
      });
    } finally {
      projectLc.close();
    }

    // Create in global
    const globalLc = await openGlobalLifecycle({ agentId: "test" });
    try {
      await createMemory(globalLc, {
        type: "gotcha",
        title: "TypeScript declaration merging gotcha",
        body: "## Body\nDeclaration merging can bite you",
        scope: { files: [], tags: ["ts"] },
        source: "explicit",
        typeFields: { severity: "info" },
      });
    } finally {
      globalLc.close();
    }

    const projectRh = openRetrieve(repoKey);
    const globalRh = openRetrieve("global");
    try {
      const results = await recallMemoryCrossTier(
        projectRh,
        globalRh,
        "TypeScript",
        { limit: 10 },
      );
      const types = results.map((r) => r.type);
      expect(types).toContain("decision");
      expect(types).toContain("gotcha");
    } finally {
      projectRh.close();
      globalRh.close();
    }
  });

  it("project results score +0.10 higher than equivalent global results", async () => {
    // Create identical memories in both stores to check boost
    const body = "## Body\nidentical content for boost test";
    const projectLc = await openLifecycle(repoKey, { agentId: "test" });
    try {
      await createMemory(projectLc, {
        type: "decision",
        title: "boost test memory",
        body,
        scope: { files: [], tags: [] },
        source: "explicit",
      });
    } finally {
      projectLc.close();
    }

    const globalLc = await openGlobalLifecycle({ agentId: "test" });
    try {
      await createMemory(globalLc, {
        type: "decision",
        title: "boost test memory",
        body,
        scope: { files: [], tags: [] },
        source: "explicit",
      });
    } finally {
      globalLc.close();
    }

    const projectRh = openRetrieve(repoKey);
    const globalRh = openRetrieve("global");
    try {
      const results = await recallMemoryCrossTier(
        projectRh,
        globalRh,
        "boost test",
        { limit: 10 },
      );
      // Both exist; project result should rank first
      expect(results.length).toBeGreaterThanOrEqual(2);
      // The top result's score should be higher than the second by ~0.10
      expect(results[0]!.score - results[1]!.score).toBeGreaterThanOrEqual(0.09);
    } finally {
      projectRh.close();
      globalRh.close();
    }
  });
});

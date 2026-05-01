// tests/unit/lib/memory/global-tier.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import {
  openLifecycle,
  openGlobalLifecycle,
  createMemory,
  promoteToGlobal,
} from "../../../../src/lib/memory/lifecycle.js";

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
});

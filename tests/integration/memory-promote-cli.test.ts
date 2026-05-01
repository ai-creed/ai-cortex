// tests/integration/memory-promote-cli.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../helpers/memory-fixtures.js";
import {
  openLifecycle,
  createMemory,
  openGlobalLifecycle,
} from "../../src/lib/memory/lifecycle.js";
import { runMemoryPromote } from "../../src/lib/memory/cli/promote.js";

let repoKey: string;

beforeEach(async () => {
  repoKey = await mkRepoKey("promote-cli");
});
afterEach(async () => {
  await cleanupRepo(repoKey);
});

async function makeProjectMemory(): Promise<string> {
  const lc = await openLifecycle(repoKey, { agentId: "test" });
  try {
    return await createMemory(lc, {
      type: "gotcha",
      title: "promote-me",
      body: "## Body\ncross-project insight",
      scope: { files: [], tags: ["node"] },
      source: "explicit",
      typeFields: { severity: "info" },
    });
  } finally {
    lc.close();
  }
}

describe("runMemoryPromote", () => {
  it("promotes a memory to global and outputs the global id", async () => {
    const id = await makeProjectMemory();
    const out: string[] = [];
    const code = await runMemoryPromote([id], {
      repoKey,
      stdout: { write: (s: string) => { out.push(s); return true; } } as any,
    });
    expect(code).toBe(0);
    const globalId = out.join("").trim();
    expect(globalId).toMatch(/^mem-/);
    expect(globalId).not.toBe(id);

    // Verify global store has it
    const globalLc = await openGlobalLifecycle({ agentId: "test" });
    try {
      expect(globalLc.index.getMemory(globalId)).toBeDefined();
    } finally {
      globalLc.close();
    }
  });

  it("returns exit code 1 and prints error for nonexistent id", async () => {
    const code = await runMemoryPromote(["mem-doesnotexist"], { repoKey });
    expect(code).toBe(1);
  });

  it("requires an id argument", async () => {
    const code = await runMemoryPromote([], { repoKey });
    expect(code).toBe(1);
  });
});

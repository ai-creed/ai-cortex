// tests/integration/memory-sweep-cli.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../helpers/memory-fixtures.js";
import { openLifecycle, createMemory } from "../../src/lib/memory/lifecycle.js";
import { runMemorySweep } from "../../src/lib/memory/cli/sweep.js";

let repoKey: string;

beforeEach(async () => {
  repoKey = await mkRepoKey("sweep-cli");
});
afterEach(async () => {
  await cleanupRepo(repoKey);
});

const DAY_MS = 86_400_000;

async function makeOldCandidate(): Promise<string> {
  const lc = await openLifecycle(repoKey, { agentId: "test" });
  try {
    const id = await createMemory(lc, {
      type: "decision",
      title: "old-candidate",
      body: "## Body\nold",
      scope: { files: [], tags: [] },
      source: "extracted",
    });
    lc.index.rawDb()
      .prepare("UPDATE memories SET status='candidate', updated_at=? WHERE id=?")
      .run(new Date(Date.now() - 91 * DAY_MS).toISOString(), id);
    return id;
  } finally {
    lc.close();
  }
}

describe("runMemorySweep", () => {
  it("returns exit code 0 on success", async () => {
    await makeOldCandidate();
    const out: string[] = [];
    const code = await runMemorySweep([], {
      repoKey,
      stdout: { write: (s: string) => { out.push(s); return true; } } as any,
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("trashed");
    expect(text).toContain("1");
  });

  it("--dry-run reports but does not apply changes", async () => {
    const id = await makeOldCandidate();
    const out: string[] = [];
    const code = await runMemorySweep(["--dry-run"], {
      repoKey,
      stdout: { write: (s: string) => { out.push(s); return true; } } as any,
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("dry-run");

    const lc = await openLifecycle(repoKey, { agentId: "test" });
    try {
      expect(lc.index.getMemory(id)?.status).toBe("candidate");
    } finally {
      lc.close();
    }
  });

  it("outputs 0 actions when nothing aged", async () => {
    const out: string[] = [];
    const code = await runMemorySweep([], {
      repoKey,
      stdout: { write: (s: string) => { out.push(s); return true; } } as any,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("0");
  });
});

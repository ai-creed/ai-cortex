// tests/unit/lib/memory/aging.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import {
  openLifecycle,
  createMemory,
  deprecateMemory,
  mergeMemories,
  trashMemory,
} from "../../../../src/lib/memory/lifecycle.js";
import { sweepAging } from "../../../../src/lib/memory/aging.js";

let repoKey: string;

beforeEach(async () => {
  repoKey = await mkRepoKey("aging-test");
});
afterEach(async () => {
  await cleanupRepo(repoKey);
});

// All helpers use real lifecycle transitions so SQL and markdown stay in sync.
// Backdating is SQL-only after the transition since the sweeper reads updated_at
// from the index, while the lifecycle functions read the .md file for frontmatter.

async function makeCandidate(ageMs: number): Promise<string> {
  const lc = await openLifecycle(repoKey, { agentId: "test" });
  try {
    // source:"extracted" → createMemory writes status=candidate in both SQL and .md
    const id = await createMemory(lc, {
      type: "decision",
      title: `test-${Math.random().toString(36).slice(2)}`,
      body: "## Body\ntest",
      scope: { files: [], tags: [] },
      source: "extracted",
    });
    const cutoff = new Date(Date.now() - ageMs).toISOString();
    lc.index.rawDb().prepare("UPDATE memories SET updated_at=? WHERE id=?").run(cutoff, id);
    return id;
  } finally {
    lc.close();
  }
}

async function makeDeprecated(ageMs: number): Promise<string> {
  const lc = await openLifecycle(repoKey, { agentId: "test" });
  try {
    const id = await createMemory(lc, {
      type: "decision",
      title: `test-${Math.random().toString(36).slice(2)}`,
      body: "## Body\ntest",
      scope: { files: [], tags: [] },
      source: "explicit",
    });
    await deprecateMemory(lc, id, "test-deprecate");
    const cutoff = new Date(Date.now() - ageMs).toISOString();
    lc.index.rawDb().prepare("UPDATE memories SET updated_at=? WHERE id=?").run(cutoff, id);
    return id;
  } finally {
    lc.close();
  }
}

async function makeMergedInto(ageMs: number): Promise<string> {
  const lc = await openLifecycle(repoKey, { agentId: "test" });
  try {
    const srcId = await createMemory(lc, {
      type: "decision",
      title: `test-src-${Math.random().toString(36).slice(2)}`,
      body: "## Body\nsrc",
      scope: { files: [], tags: [] },
      source: "explicit",
    });
    const dstId = await createMemory(lc, {
      type: "decision",
      title: `test-dst-${Math.random().toString(36).slice(2)}`,
      body: "## Body\ndst",
      scope: { files: [], tags: [] },
      source: "explicit",
    });
    await mergeMemories(lc, srcId, dstId, "## Body\nmerged");
    const cutoff = new Date(Date.now() - ageMs).toISOString();
    lc.index.rawDb().prepare("UPDATE memories SET updated_at=? WHERE id=?").run(cutoff, srcId);
    return srcId;
  } finally {
    lc.close();
  }
}

async function makeTrashed(ageMs: number): Promise<string> {
  const lc = await openLifecycle(repoKey, { agentId: "test" });
  try {
    const id = await createMemory(lc, {
      type: "decision",
      title: `test-${Math.random().toString(36).slice(2)}`,
      body: "## Body\ntest",
      scope: { files: [], tags: [] },
      source: "explicit",
    });
    await trashMemory(lc, id, "test-trash");
    const cutoff = new Date(Date.now() - ageMs).toISOString();
    lc.index.rawDb().prepare("UPDATE memories SET updated_at=? WHERE id=?").run(cutoff, id);
    return id;
  } finally {
    lc.close();
  }
}

const DAY_MS = 86_400_000;

describe("sweepAging — candidate transitions", () => {
  it("trashes a candidate older than 90 days", async () => {
    const id = await makeCandidate(91 * DAY_MS);
    const report = await sweepAging(repoKey);
    expect(report.dryRun).toBe(false);
    const action = report.actionsApplied.find((a) => a.id === id);
    expect(action?.newStatus).toBe("trashed");
  });

  it("does NOT trash a candidate younger than 90 days", async () => {
    const id = await makeCandidate(30 * DAY_MS);
    const report = await sweepAging(repoKey);
    expect(report.actionsApplied.find((a) => a.id === id)).toBeUndefined();
  });

});

describe("sweepAging — deprecated transitions", () => {
  it("trashes a deprecated memory older than 180 days", async () => {
    const id = await makeDeprecated(181 * DAY_MS);
    const report = await sweepAging(repoKey);
    expect(report.actionsApplied.find((a) => a.id === id)?.newStatus).toBe("trashed");
  });

  it("does NOT trash a deprecated memory younger than 180 days", async () => {
    const id = await makeDeprecated(90 * DAY_MS);
    const report = await sweepAging(repoKey);
    expect(report.actionsApplied.find((a) => a.id === id)).toBeUndefined();
  });
});

describe("sweepAging — merged_into transitions", () => {
  it("trashes a merged_into memory older than 90 days", async () => {
    const id = await makeMergedInto(91 * DAY_MS);
    const report = await sweepAging(repoKey);
    expect(report.actionsApplied.find((a) => a.id === id)?.newStatus).toBe("trashed");
  });
});

describe("sweepAging — trashed→purge transitions", () => {
  it("purges a trashed memory older than 90 days", async () => {
    const id = await makeTrashed(91 * DAY_MS);
    const report = await sweepAging(repoKey);
    const action = report.actionsApplied.find((a) => a.id === id);
    expect(action?.newStatus).toBe("purged");
  });

  it("does NOT purge a trashed memory younger than 90 days", async () => {
    const id = await makeTrashed(30 * DAY_MS);
    const report = await sweepAging(repoKey);
    expect(report.actionsApplied.find((a) => a.id === id)).toBeUndefined();
  });
});

describe("sweepAging — stale_reference never aged", () => {
  it("leaves stale_reference untouched regardless of age", async () => {
    // makeCandidate puts status=candidate in both SQL and .md; then we force
    // status=stale_reference in SQL only. The sweeper checks SQL status for
    // query filtering — stale_reference is excluded from the query — so the
    // SQL-only override is safe here (no lifecycle function reads the .md for
    // this record during the sweep).
    const id = await makeCandidate(91 * DAY_MS);
    const lc = await openLifecycle(repoKey, { agentId: "test" });
    try {
      lc.index.rawDb()
        .prepare("UPDATE memories SET status='stale_reference' WHERE id=?")
        .run(id);
    } finally {
      lc.close();
    }
    const report = await sweepAging(repoKey);
    expect(report.actionsApplied.find((a) => a.id === id)).toBeUndefined();
  });
});

describe("sweepAging — dryRun", () => {
  it("reports actions but applies none when dryRun=true", async () => {
    const id = await makeCandidate(91 * DAY_MS);
    const report = await sweepAging(repoKey, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.actionsApplied.find((a) => a.id === id)?.newStatus).toBe("trashed");

    // Verify no state change in the index
    const lc = await openLifecycle(repoKey, { agentId: "test" });
    try {
      const row = lc.index.getMemory(id);
      expect(row?.status).toBe("candidate");
    } finally {
      lc.close();
    }
  });
});

// tests/integration/memory-recall-source.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkRepoKey, cleanupRepo } from "../helpers/memory-fixtures.js";
import {
  openLifecycle,
  createMemory,
  openGlobalLifecycle,
} from "../../src/lib/memory/lifecycle.js";
import { spawnSync } from "node:child_process";
import path from "node:path";

let repoKey: string;
const CLI = path.resolve("dist/src/cli.js");

beforeEach(async () => {
  repoKey = await mkRepoKey("recall-source-test");
});
afterEach(async () => {
  await cleanupRepo(repoKey);
});

async function seedStores(): Promise<void> {
  const projectLc = await openLifecycle(repoKey, { agentId: "test" });
  try {
    await createMemory(projectLc, {
      type: "decision",
      title: "project-specific typescript config",
      body: "## Body\nproject only",
      scope: { files: [], tags: ["ts"] },
      source: "explicit",
    });
  } finally {
    projectLc.close();
  }
  const globalLc = await openGlobalLifecycle({ agentId: "test" });
  try {
    await createMemory(globalLc, {
      type: "gotcha",
      title: "global typescript gotcha",
      body: "## Body\nglobal gotcha content",
      scope: { files: [], tags: ["ts"] },
      source: "explicit",
      typeFields: { severity: "info" },
    });
  } finally {
    globalLc.close();
  }
}

describe("ai-cortex memory recall --source", () => {
  it("--source project returns only project results", async () => {
    await seedStores();
    const r = spawnSync(
      process.execPath,
      [CLI, "memory", "recall", "typescript", "--repo-key", repoKey, "--source", "project", "--json"],
      { env: { ...process.env }, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const results = JSON.parse(r.stdout);
    expect(results.every((x: any) => x.type === "decision")).toBe(true);
  });

  it("--source global returns only global results", async () => {
    await seedStores();
    const r = spawnSync(
      process.execPath,
      [CLI, "memory", "recall", "typescript", "--repo-key", repoKey, "--source", "global", "--json"],
      { env: { ...process.env }, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const results = JSON.parse(r.stdout);
    expect(results.every((x: any) => x.type === "gotcha")).toBe(true);
  });

  it("--source all (default) returns results from both stores", async () => {
    await seedStores();
    const r = spawnSync(
      process.execPath,
      [CLI, "memory", "recall", "typescript", "--repo-key", repoKey, "--source", "all", "--json"],
      { env: { ...process.env }, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const results = JSON.parse(r.stdout);
    const types = results.map((x: any) => x.type);
    expect(types).toContain("decision");
    expect(types).toContain("gotcha");
  });
});

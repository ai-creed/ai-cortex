// src/lib/library/__tests__/cli.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLibraryCli } from "../index.js";
import type { Embedder } from "../index.js";

function fakeEmbedder(dim = 8): Embedder {
  return {
    modelId: "fake-test-model",
    dim,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(dim);
        for (let i = 0; i < t.length; i++) v[i % dim] += t.charCodeAt(i) / 100;
        let n = 0;
        for (let j = 0; j < dim; j++) n += v[j]! * v[j]!;
        n = Math.sqrt(n) || 1;
        for (let j = 0; j < dim; j++) v[j]! /= n;
        return v;
      });
    },
  };
}

describe("runLibraryCli", () => {
  let cacheHome: string;
  let dir: string;
  let out: string;
  const write = (s: string) => { out += s; };
  beforeEach(() => {
    cacheHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lib-cli-cache-")));
    process.env.AI_CORTEX_CACHE_HOME = cacheHome;
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lib-cli-dir-")));
    fs.writeFileSync(path.join(dir, "g.md"), "# Guide\nUse exponential backoff for retries.\n");
    out = "";
  });
  afterEach(() => {
    delete process.env.AI_CORTEX_CACHE_HOME;
    for (const d of [cacheHome, dir]) fs.rmSync(d, { recursive: true, force: true });
  });

  it("registers, lists, reindexes, and searches via the CLI", async () => {
    const e = fakeEmbedder();
    const deps = { write, embedder: e, nowIso: "t" };
    expect(await runLibraryCli(["register", dir, "--label", "guides"], deps)).toBe(0);
    expect(out).toContain("registered guides");

    out = "";
    expect(await runLibraryCli(["list"], deps)).toBe(0);
    expect(out).toContain("guides");
    expect(out).toContain("docs="); // status includes document count

    out = "";
    expect(await runLibraryCli(["reindex"], deps)).toBe(0);
    expect(out).toContain("indexed=1");

    out = "";
    expect(await runLibraryCli(["search", "exponential", "backoff"], deps)).toBe(0);
    expect(out).toContain("g.md:");
  });

  it("returns a non-zero code and usage for an unknown subcommand", async () => {
    expect(await runLibraryCli(["bogus"], { write })).toBe(1);
    expect(out).toContain("usage:");
  });
});

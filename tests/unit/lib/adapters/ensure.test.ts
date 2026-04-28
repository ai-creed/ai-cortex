import { describe, expect, it, beforeEach } from "vitest";
import { adapterForFile } from "../../../../src/lib/adapters/index.js";
import {
  ensureAdapters,
  resetEnsureAdapters,
} from "../../../../src/lib/adapters/ensure.js";

beforeEach(() => {
  resetEnsureAdapters();
});

describe("ensureAdapters", () => {
  it("registers an adapter for .ts files", async () => {
    await ensureAdapters();
    expect(adapterForFile("src/main.ts")).toBeDefined();
  });

  it("registers an adapter for .c files", async () => {
    await ensureAdapters();
    expect(adapterForFile("src/main.c")).toBeDefined();
  });

  it("registers an adapter for .cpp files", async () => {
    await ensureAdapters();
    expect(adapterForFile("src/main.cpp")).toBeDefined();
  });
});

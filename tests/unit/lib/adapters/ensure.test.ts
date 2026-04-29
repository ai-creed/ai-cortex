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

  it("registers an adapter for .py files", async () => {
    await ensureAdapters();
    expect(adapterForFile("src/main.py")).toBeDefined();
  });

  it("is safe when called concurrently before first resolution", async () => {
    // Simulates the race that occurs on Linux when multiple code paths invoke
    // ensureAdapters (or the adapter factories) simultaneously before the
    // web-tree-sitter Emscripten module has finished initialising.
    resetEnsureAdapters();
    await Promise.all([ensureAdapters(), ensureAdapters(), ensureAdapters()]);
    expect(adapterForFile("src/main.py")).toBeDefined();
    expect(adapterForFile("src/main.c")).toBeDefined();
    expect(adapterForFile("src/main.ts")).toBeDefined();
  });
});

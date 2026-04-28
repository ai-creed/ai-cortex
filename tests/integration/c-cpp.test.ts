import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAdapters, resetEnsureAdapters } from "../../src/lib/adapters/ensure.js";
import { extractCallGraph } from "../../src/lib/call-graph.js";
import { extractImports } from "../../src/lib/import-graph.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/c-cpp-mixed",
);

const FILES = [
  "src/utils.h",
  "src/utils.cpp",
  "src/main.cpp",
  "src/main.ts",
];

beforeAll(async () => {
  resetEnsureAdapters();
  await ensureAdapters();
});

describe("C/C++ + TS mixed indexing", () => {
  it("extracts functions from all files", async () => {
    const { functions } = await extractCallGraph(FIXTURE, FILES);
    const names = functions.map((f) => f.qualifiedName);
    expect(names).toContain("add");
    expect(names).toContain("main");
    expect(names).toContain("tsEntry");
  });

  it("marks utils.h add() as declaration-only", async () => {
    const { functions } = await extractCallGraph(FIXTURE, FILES);
    const headerDecl = functions.find(
      (f) => f.qualifiedName === "add" && f.file === "src/utils.h",
    );
    expect(headerDecl).toBeDefined();
    expect(headerDecl?.isDeclarationOnly).toBe(true);
  });

  it("marks utils.cpp add() as live definition", async () => {
    const { functions } = await extractCallGraph(FIXTURE, FILES);
    const def = functions.find(
      (f) => f.qualifiedName === "add" && f.file === "src/utils.cpp",
    );
    expect(def).toBeDefined();
    expect(def?.isDeclarationOnly).toBeFalsy();
  });

  it("resolves main.cpp::main -> utils.cpp::add via repo-wide fallback", async () => {
    const { calls } = await extractCallGraph(FIXTURE, FILES);
    expect(calls).toContainEqual(
      expect.objectContaining({
        from: "src/main.cpp::main",
        to: "src/utils.cpp::add",
        kind: "call",
      }),
    );
  });

  it("extracts #include edges for main.cpp", async () => {
    const imports = await extractImports(FIXTURE, FILES, FILES);
    const mainIncludes = imports.filter((e) => e.from === "src/main.cpp");
    expect(mainIncludes.some((e) => e.to === "src/utils.h")).toBe(true);
  });
});

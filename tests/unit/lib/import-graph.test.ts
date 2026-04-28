import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractImports } from "../../../src/lib/import-graph.js";

describe("import-graph (adapter-driven)", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(
      path.join(dir, "src", "a.ts"),
      `import { b } from "./b";\nimport "react";`,
    );
    fs.writeFileSync(path.join(dir, "src", "b.ts"), `export const b = 1;`);
  });

  it("emits canonical edges by resolving against allFilePaths", async () => {
    const edges = await extractImports(
      dir,
      ["src/a.ts", "src/b.ts"],
      ["src/a.ts", "src/b.ts"],
    );
    expect(edges).toContainEqual({ from: "src/a.ts", to: "src/b" });
    expect(edges.find((e) => e.to.includes("react"))).toBeUndefined();
  });

  it("drops unresolved sites", async () => {
    const edges = await extractImports(
      dir,
      ["src/a.ts"],
      ["src/a.ts"], // b.ts is not in allFilePaths
    );
    expect(edges).toEqual([]);
  });
});

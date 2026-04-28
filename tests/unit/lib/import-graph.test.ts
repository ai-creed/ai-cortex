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

describe("import-graph — C/C++ basename fallback", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-cfamily-"));
    // Source directory — where the caller lives
    fs.mkdirSync(path.join(dir, "src"));
    // Header lives in a different directory than the caller
    fs.mkdirSync(path.join(dir, "lib"));

    // Caller: #include "utils.h" — no relative path component, just a basename
    fs.writeFileSync(
      path.join(dir, "src", "main.cpp"),
      `#include "utils.h"\n\nint main() { return 0; }\n`,
    );
    // Target header is in lib/, not src/ — so candidate "src/utils.h" won't
    // exist in allFilePaths but "lib/utils.h" will match by basename.
    fs.writeFileSync(
      path.join(dir, "lib", "utils.h"),
      `int helper();\n`,
    );
  });

  it("resolves #include by basename when exact candidate path is absent", async () => {
    // allFilePaths includes lib/utils.h but NOT src/utils.h (the candidate the
    // C-family adapter would synthesize for a bare #include "utils.h" from src/).
    const edges = await extractImports(
      dir,
      ["src/main.cpp"],
      ["src/main.cpp", "lib/utils.h"],
    );
    expect(edges).toContainEqual({ from: "src/main.cpp", to: "lib/utils.h" });
  });

  it("drops include when no file with matching basename exists in allFilePaths", async () => {
    // allFilePaths does not contain any file named utils.h
    const edges = await extractImports(
      dir,
      ["src/main.cpp"],
      ["src/main.cpp"],
    );
    expect(edges).toEqual([]);
  });

  it("drops include when multiple files share the same basename (ambiguous)", async () => {
    // Two files both named utils.h → basename fallback returns null (ambiguous)
    fs.mkdirSync(path.join(dir, "alt"), { recursive: true });
    fs.writeFileSync(path.join(dir, "alt", "utils.h"), `// alt\n`);

    const edges = await extractImports(
      dir,
      ["src/main.cpp"],
      ["src/main.cpp", "lib/utils.h", "alt/utils.h"],
    );
    expect(edges).toEqual([]);
  });
});

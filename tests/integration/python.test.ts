import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureAdapters, resetEnsureAdapters } from "../../src/lib/adapters/ensure.js";
import { extractCallGraph } from "../../src/lib/call-graph.js";
import { buildIndex, buildIncrementalIndex } from "../../src/lib/indexer.js";
import { resolveRepoIdentity } from "../../src/lib/repo-identity.js";
import type { FunctionNode } from "../../src/lib/models.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/python-basic",
);

const FILES = [
  "mypackage/__init__.py",
  "mypackage/utils.py",
  "mypackage/models.py",
  "main.py",
];

let tmpDir: string;

beforeAll(async () => {
  resetEnsureAdapters();
  await ensureAdapters();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-py-"));
  execFileSync("git", ["init", tmpDir]);
  execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@test.com"]);
  execFileSync("git", ["-C", tmpDir, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", tmpDir, "config", "commit.gpgsign", "false"]);

  fs.mkdirSync(path.join(tmpDir, "mypackage"), { recursive: true });
  for (const file of FILES) {
    fs.copyFileSync(path.join(FIXTURE, file), path.join(tmpDir, file));
  }

  execFileSync("git", ["-C", tmpDir, "add", "."]);
  execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Python indexing — function extraction", () => {
  it("extracts all expected function names", async () => {
    const { functions } = await extractCallGraph(FIXTURE, FILES);
    const names = functions.map((f: FunctionNode) => f.qualifiedName);
    expect(names).toContain("helper");
    expect(names).toContain("Model.save");
    expect(names).toContain("Model.finalize");
    expect(names).toContain("run");
  });
});

describe("Python indexing — call edges", () => {
  it("resolves self.method() to same-file ClassName.method edge", async () => {
    const { calls } = await extractCallGraph(FIXTURE, FILES);
    expect(calls).toContainEqual(
      expect.objectContaining({
        from: "mypackage/models.py::Model.save",
        to: "mypackage/models.py::Model.finalize",
        kind: "method",
      }),
    );
  });

  it("resolves relative import call: Model.finalize → helper", async () => {
    const { calls } = await extractCallGraph(FIXTURE, FILES);
    expect(calls).toContainEqual(
      expect.objectContaining({
        from: "mypackage/models.py::Model.finalize",
        to: "mypackage/utils.py::helper",
        kind: "call",
      }),
    );
  });

  it("resolves absolute import call: run → helper", async () => {
    const { calls } = await extractCallGraph(FIXTURE, FILES);
    expect(calls).toContainEqual(
      expect.objectContaining({
        from: "main.py::run",
        to: "mypackage/utils.py::helper",
        kind: "call",
      }),
    );
  });
});

describe("Python incremental reindex — caller invalidation", () => {
  it("evicts stale call edges from callers of a renamed function", async () => {
    const identity = resolveRepoIdentity(tmpDir);
    const initial = await buildIndex(identity);

    // Verify initial index has the cross-file call edge
    expect(initial.calls).toContainEqual(
      expect.objectContaining({
        from: "mypackage/models.py::Model.finalize",
        to: "mypackage/utils.py::helper",
      }),
    );

    // Rename helper → helper_new in utils.py on disk.
    // This makes the stale edge detectable: if models.py is NOT invalidated,
    // the old "→ utils.py::helper" edge is kept; if it IS invalidated it is gone.
    fs.writeFileSync(
      path.join(tmpDir, "mypackage", "utils.py"),
      "def helper_new():\n    pass\n",
    );

    const diff = {
      changed: ["mypackage/utils.py"],
      removed: [] as string[],
      method: "hash-compare" as const,
    };

    const updated = await buildIncrementalIndex(identity, initial, diff, false);

    // utils.py was reparsed: helper is gone, helper_new exists
    const names = updated.functions.map((f: FunctionNode) => f.qualifiedName);
    expect(names).not.toContain("helper");
    expect(names).toContain("helper_new");

    // models.py and main.py were invalidated as affected callers, so their stale
    // edges referencing the now-absent "helper" must be absent.
    const stale = updated.calls.find(
      (c) =>
        c.from === "mypackage/models.py::Model.finalize" &&
        c.to === "mypackage/utils.py::helper",
    );
    expect(stale).toBeUndefined();
  });
});

describe("Python src-layout absolute import — end-to-end through extractCallGraph", () => {
  it("resolves absolute import call when package lives under src/", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "py-srclayout-"));
    fs.mkdirSync(path.join(dir, "src", "mylib"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "pyproject.toml"),
      "[tool.setuptools.packages.find]\nwhere = [\"src\"]\n",
    );
    fs.writeFileSync(
      path.join(dir, "src", "mylib", "__init__.py"),
      "",
    );
    fs.writeFileSync(
      path.join(dir, "src", "mylib", "utils.py"),
      "def compute():\n    pass\n",
    );
    fs.writeFileSync(
      path.join(dir, "app.py"),
      "from mylib.utils import compute\n\ndef run():\n    compute()\n",
    );

    const files = [
      "src/mylib/__init__.py",
      "src/mylib/utils.py",
      "app.py",
    ];

    try {
      const { calls, functions } = await extractCallGraph(dir, files);

      const fnNames = functions.map((f: FunctionNode) => f.qualifiedName);
      expect(fnNames).toContain("compute");
      expect(fnNames).toContain("run");

      expect(calls).toContainEqual(
        expect.objectContaining({
          from: "app.py::run",
          to: "src/mylib/utils.py::compute",
          kind: "call",
        }),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

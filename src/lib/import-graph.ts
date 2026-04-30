// src/lib/import-graph.ts
import fs from "node:fs";
import path from "node:path";
import { getAdapterForFile } from "./adapters/index.js";
import { ensureAdapters } from "./adapters/ensure.js";
import type { ImportEdge } from "./models.js";

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const C_FAMILY_EXTS = new Set([
  ".c", ".cpp", ".cc", ".cxx", ".c++",
  ".h", ".hpp", ".hh", ".hxx", ".h++",
]);

function langOf(filePath: string): "ts" | "cfamily" | "python" | "other" {
  const ext = path.extname(filePath);
  if (TS_EXTS.has(ext)) return "ts";
  if (C_FAMILY_EXTS.has(ext)) return "cfamily";
  if (ext === ".py") return "python";
  return "other";
}

export async function discoverPythonPackageRoots(worktreePath: string): Promise<Set<string>> {
  // pyproject.toml — look for [tool.setuptools.packages.find] where = ["src"]
  try {
    const content = await fs.promises.readFile(
      path.join(worktreePath, "pyproject.toml"),
      "utf8",
    );
    const m = content.match(/\bwhere\s*=\s*\[([^\]]+)\]/u);
    if (m) {
      const roots = [...m[1].matchAll(/["']([^"']+)["']/gu)].map((r) => r[1]);
      if (roots.length > 0) return new Set(roots);
    }
  } catch { /* not found */ }

  // setup.cfg — look for package_dir = = src  (or similar)
  try {
    const content = await fs.promises.readFile(
      path.join(worktreePath, "setup.cfg"),
      "utf8",
    );
    const m = content.match(/package_dir\s*=\s*\w*\s*=\s*([^\s;#]+)/u);
    if (m) return new Set([m[1]]);
  } catch { /* not found */ }

  // setup.py — look for package_dir={'': 'src'}
  try {
    const content = await fs.promises.readFile(
      path.join(worktreePath, "setup.py"),
      "utf8",
    );
    const m = content.match(
      /package_dir\s*=\s*\{[^}]*["']\s*:\s*["']([^"']+)["']/u,
    );
    if (m) return new Set([m[1]]);
  } catch { /* not found */ }

  return new Set([""]);
}

function resolveSite(
  candidate: string,
  allFilePaths: Set<string>,
  lang: "ts" | "cfamily" | "python" | "other",
  packageRoots?: Set<string>,
): string | null {
  if (lang === "ts") {
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      const guess = `${candidate}${ext}`;
      if (allFilePaths.has(guess)) return candidate;
    }
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      const guess = `${candidate}/index${ext}`;
      if (allFilePaths.has(guess)) return `${candidate}/index`;
    }
    return null;
  }
  if (lang === "cfamily") {
    if (allFilePaths.has(candidate)) return candidate;
    const baseName = path.basename(candidate);
    const matches: string[] = [];
    for (const f of allFilePaths) {
      if (path.basename(f) === baseName) matches.push(f);
    }
    if (matches.length === 1) return matches[0];
    return null;
  }
  if (lang === "python") {
    // Direct probe first — handles repo-root-relative relative import candidates.
    // Must come before package-root prefixing to avoid double-prefixing
    // (e.g. candidate "src/pkg/utils" must not become "src/src/pkg/utils.py").
    if (allFilePaths.has(candidate + ".py")) return candidate + ".py";
    if (allFilePaths.has(candidate + "/__init__.py"))
      return candidate + "/__init__.py";
    // Package-root prefix probing — covers absolute imports in src-layout projects.
    for (const root of packageRoots ?? []) {
      if (!root) continue;
      const prefixed = root + "/" + candidate;
      if (allFilePaths.has(prefixed + ".py")) return prefixed + ".py";
      if (allFilePaths.has(prefixed + "/__init__.py"))
        return prefixed + "/__init__.py";
    }
    return null;
  }
  return null;
}

export async function extractImports(
  worktreePath: string,
  filePaths: string[],
  allFilePaths: string[],
  contentMap?: Map<string, string>,
): Promise<ImportEdge[]> {
  await ensureAdapters();
  const fileSet = new Set(allFilePaths);
  const hasPy = filePaths.some((f) => f.endsWith(".py"));
  const packageRoots = hasPy
    ? await discoverPythonPackageRoots(worktreePath)
    : undefined;
  const edges: ImportEdge[] = [];
  for (const filePath of filePaths) {
    const adapter = getAdapterForFile(filePath);
    if (!adapter) continue;
    const content = contentMap?.get(filePath);
    if (contentMap && content === undefined) continue;
    let sites;
    try {
      sites = await adapter.extractImports(worktreePath, filePath, content);
    } catch {
      continue;
    }
    const lang = langOf(filePath);
    for (const site of sites) {
      const to = resolveSite(site.candidate, fileSet, lang, packageRoots);
      if (to) edges.push({ from: filePath, to });
    }
  }
  return edges;
}

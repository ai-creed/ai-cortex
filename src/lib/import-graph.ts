// src/lib/import-graph.ts
import fs from "node:fs";
import path from "node:path";
import { adapterForFile } from "./adapters/index.js";
import { ensureAdapters } from "./adapters/ensure.js";
import type { ImportEdge } from "./models.js";

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const C_FAMILY_EXTS = new Set([
  ".c", ".cpp", ".cc", ".cxx", ".c++",
  ".h", ".hpp", ".hh", ".hxx", ".h++",
]);

function langOf(filePath: string): "ts" | "cfamily" | "other" {
  const ext = path.extname(filePath);
  if (TS_EXTS.has(ext)) return "ts";
  if (C_FAMILY_EXTS.has(ext)) return "cfamily";
  return "other";
}

function resolveSite(
  candidate: string,
  allFilePaths: Set<string>,
  lang: "ts" | "cfamily" | "other",
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
  return null;
}

export async function extractImports(
  worktreePath: string,
  filePaths: string[],
  allFilePaths: string[],
): Promise<ImportEdge[]> {
  await ensureAdapters();
  const fileSet = new Set(allFilePaths);
  const edges: ImportEdge[] = [];
  for (const filePath of filePaths) {
    const adapter = adapterForFile(filePath);
    if (!adapter) continue;
    let source: string;
    try {
      source = fs.readFileSync(path.join(worktreePath, filePath), "utf8");
    } catch {
      continue;
    }
    let sites;
    try {
      sites = adapter.extractImportSites(source, filePath);
    } catch {
      continue;
    }
    const lang = langOf(filePath);
    for (const site of sites) {
      const to = resolveSite(site.candidate, fileSet, lang);
      if (to) edges.push({ from: filePath, to });
    }
  }
  return edges;
}

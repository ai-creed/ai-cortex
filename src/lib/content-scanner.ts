// src/lib/content-scanner.ts
//
// Query-time grep over a small pool of candidate files. Records up to 3 hits
// per file with line + snippet. Aborts if total elapsed exceeds the budget.

import fs from "node:fs";
import path from "node:path";

export type ContentHit = {
  line: number;
  snippet: string;
  token: string;
};

export type ContentScanResult = {
  hits: Map<string, ContentHit[]>;
  truncated: boolean;
  durationMs: number;
};

const MAX_FILE_BYTES = 500_000;
const MAX_HITS_PER_FILE = 3;
const DEFAULT_BUDGET_MS = 400;

/**
 * Scan the given files for case-insensitive occurrences of any task token.
 * Returns per-file hits plus a `truncated` flag if the budget was exhausted.
 *
 * SAFETY: callers must pass only paths that exist in `cache.files` (git-tracked).
 */
export function contentScan(
  worktreePath: string,
  filePaths: string[],
  tokens: string[],
  budgetMs: number = DEFAULT_BUDGET_MS,
): ContentScanResult {
  const start = Date.now();
  const hits = new Map<string, ContentHit[]>();
  let truncated = false;

  if (tokens.length === 0) {
    return { hits, truncated, durationMs: 0 };
  }

  const needles = tokens.map((t) => t.toLowerCase());

  for (const relPath of filePaths) {
    if (Date.now() - start > budgetMs) {
      truncated = true;
      break;
    }
    const full = path.join(worktreePath, relPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue; // missing or inaccessible — skip silently
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;

    let source: string;
    try {
      source = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }

    const lines = source.split("\n");
    const fileHits: ContentHit[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const lower = lines[i].toLowerCase();
      for (const needle of needles) {
        if (lower.includes(needle)) {
          fileHits.push({
            line: i + 1,
            snippet: lines[i].trim().slice(0, 160),
            token: needle,
          });
          break; // at most one hit per line
        }
      }
      if (fileHits.length >= MAX_HITS_PER_FILE) break;
    }

    if (fileHits.length > 0) hits.set(relPath, fileHits);
  }

  return { hits, truncated, durationMs: Date.now() - start };
}

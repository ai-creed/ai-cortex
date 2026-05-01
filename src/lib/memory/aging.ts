// src/lib/memory/aging.ts
import { openLifecycle, trashMemory, purgeMemory } from "./lifecycle.js";
import { loadMemoryConfig } from "./config.js";

export type AgingAction = {
  id: string;
  title: string;
  currentStatus: string;
  newStatus: "trashed" | "purged";
  reason: string;
};

export type AgingSweepReport = {
  actionsApplied: AgingAction[];
  dryRun: boolean;
};

const DAY_MS = 86_400_000;

function cutoff(agingDays: number): string {
  return new Date(Date.now() - agingDays * DAY_MS).toISOString();
}

export async function sweepAging(
  repoKey: string,
  opts: { dryRun?: boolean } = {},
): Promise<AgingSweepReport> {
  const dryRun = opts.dryRun ?? false;
  const cfg = await loadMemoryConfig(repoKey);
  const a = cfg.aging;

  const lc = await openLifecycle(repoKey, { agentId: "aging-sweep" });
  try {
    const db = lc.index.rawDb();

    type AgingRow = { id: string; title: string; status: string; updated_at: string; confidence: number };

    const toTrash: AgingRow[] = db.prepare<[], AgingRow>(`
      SELECT id, title, status, updated_at, confidence FROM memories
      WHERE (
        (status = 'candidate'    AND updated_at < ?)
        OR (status = 'deprecated'  AND updated_at < ?)
        OR (status = 'merged_into' AND updated_at < ?)
      )
    `).all(
      cutoff(a.candidateToTrashedDays),
      cutoff(a.deprecatedToTrashedDays),
      cutoff(a.mergedIntoToTrashedDays),
    );

    const toPurge: AgingRow[] = db.prepare<[], AgingRow>(`
      SELECT id, title, status, updated_at, confidence FROM memories
      WHERE status = 'trashed' AND updated_at < ?
    `).all(cutoff(a.trashedToPurgedDays));

    const actions: AgingAction[] = [];

    for (const row of toTrash) {
      const threshold =
        row.status === "deprecated"
          ? a.deprecatedToTrashedDays
          : row.status === "merged_into"
            ? a.mergedIntoToTrashedDays
            : a.candidateToTrashedDays;
      const reason = `aging: ${row.status} for >${threshold}d`;
      actions.push({
        id: row.id,
        title: row.title,
        currentStatus: row.status,
        newStatus: "trashed",
        reason,
      });
      if (!dryRun) {
        await trashMemory(lc, row.id, reason);
      }
    }

    for (const row of toPurge) {
      actions.push({
        id: row.id,
        title: row.title,
        currentStatus: row.status,
        newStatus: "purged",
        reason: `aging: trashed >${a.trashedToPurgedDays}d`,
      });
      if (!dryRun) {
        await purgeMemory(lc, row.id, `aging: trashed >${a.trashedToPurgedDays}d`);
      }
    }

    return { actionsApplied: actions, dryRun };
  } finally {
    lc.close();
  }
}

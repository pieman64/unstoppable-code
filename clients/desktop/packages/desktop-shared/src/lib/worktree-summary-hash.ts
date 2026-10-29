import type { WorktreeSummaryData } from '../types';
import { stableHash } from './stable-hash';

/**
 * Content hash of the *meaningful* parts of a worktree summary: title,
 * description, highlights, and repo summaries.
 *
 * This uses an explicit **allow-list** — only the narrative fields hashed below
 * contribute. The volatile bookkeeping fields on {@link WorktreeSummaryData}
 * (`generatedAt`, `turnCountAtGeneration`, `lastFullRefreshAt`,
 * `lastFullRefreshTurnCount`) are intentionally excluded so a regeneration that
 * produces byte-identical narrative content hashes the same and does not create
 * a spurious history snapshot.
 *
 * Because this is allow-list based, any field added to `WorktreeSummaryData` is
 * excluded from the hash *by default*. If a newly added field is part of the
 * narrative content (i.e. a change to it should append a new history snapshot),
 * add it to the object below; otherwise it correctly stays out of the hash.
 *
 * Pure and browser-safe (uses the FNV-1a `stableHash`, no `node:crypto`) so it
 * stays testable and passes `check:electron-boundary`.
 */
export function worktreeSummaryContentHash(
  summary: WorktreeSummaryData,
): string {
  return stableHash({
    title: summary.title.trim(),
    description: summary.description.trim(),
    highlights: summary.highlights.map((entry) => entry.trim()),
    repos: (summary.repos ?? []).map((repo) => ({
      name: repo.name.trim(),
      description: repo.description.trim(),
    })),
  });
}

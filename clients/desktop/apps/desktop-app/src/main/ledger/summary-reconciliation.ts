import { readdir } from 'node:fs/promises';
import { LEDGER_RECEIPT_KEYS_MAX } from '@canopy/desktop-shared/node/ledger';
import {
  APP_ADVISOR_PROJECT_ID,
  type WorktreeSummarySnapshot,
} from '@canopy/desktop-shared/types';
import { getWorkspaceSummariesDir } from '../lib/paths';
import { listRegisteredWorkspaceIds } from '../lib/workspace-registry';
import { readWorktreeSummaryFile } from '../lib/worktree-summary-persistence';
import { isSafeLedgerContainerId } from './lifecycle-containers';
import {
  DESKTOP_SUMMARY_PUBLICATION_HOST,
  isPublishableSummarySnapshot,
  publishResolvedSummarySnapshot,
  resolveSummaryScopeLedger,
  summaryPublicationKey,
  type PublishableSummarySnapshot,
  type SummaryPublicationHost,
  type SummaryScope,
} from './summary-publication';

/*
 * Startup reconciliation of Summary publication (phase 09, LD06). A snapshot
 * written while the Ledger was on records that it is publishable; one whose
 * publication a crash, a lost response or an unavailable Ledger left
 * unfinished has no publication receipt. This pass publishes those, oldest
 * first, however long after the write the scope was first bound. Replaying a
 * publication that did commit returns its original receipt, so a stale view
 * never duplicates an entry. Snapshots written before the Ledger was on carry
 * no marker, so history is never backfilled.
 */

export interface SummaryReconciliationHost {
  readonly publication: SummaryPublicationHost;
  /** Every Summary scope with a summary file. */
  readonly listScopes: () => Promise<SummaryScope[]>;
  /** A scope's snapshot history, oldest first; empty when unreadable. */
  readonly readHistory: (
    scope: SummaryScope,
  ) => Promise<readonly WorktreeSummarySnapshot[]>;
}

/** Summary scopes of every loaded workspace and of App Advisor. */
async function listDesktopSummaryScopes(): Promise<SummaryScope[]> {
  const scopes: SummaryScope[] = [];
  for (const projectId of [
    ...listRegisteredWorkspaceIds(),
    APP_ADVISOR_PROJECT_ID,
  ]) {
    let names: string[];
    try {
      names = await readdir(getWorkspaceSummariesDir(projectId));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const worktreeId = name.slice(0, -'.json'.length);
      if (isSafeLedgerContainerId(worktreeId)) {
        scopes.push({ projectId, worktreeId });
      }
    }
  }
  return scopes;
}

export const DESKTOP_SUMMARY_RECONCILIATION_HOST: SummaryReconciliationHost = {
  publication: DESKTOP_SUMMARY_PUBLICATION_HOST,
  listScopes: listDesktopSummaryScopes,
  readHistory: async (scope): Promise<readonly WorktreeSummarySnapshot[]> =>
    (await readWorktreeSummaryFile(scope.projectId, scope.worktreeId))
      ?.history ?? [],
};

export interface SummaryReconciliationResult {
  /** Scopes that had unpublished snapshots. */
  readonly scopes: number;
  readonly published: number;
  /** Snapshots left unpublished for a later startup. */
  readonly pending: number;
}

/** The publication keys among `keys` that already hold a receipt. */
async function readPublishedKeys(
  host: SummaryPublicationHost,
  ledgerId: string,
  keys: readonly string[],
): Promise<Set<string>> {
  const published = new Set<string>();
  for (let start = 0; start < keys.length; start += LEDGER_RECEIPT_KEYS_MAX) {
    const page = keys.slice(start, start + LEDGER_RECEIPT_KEYS_MAX);
    for (const key of await host.publishedKeys(ledgerId, page)) {
      published.add(key);
    }
  }
  return published;
}

/** What one scope's pass published and left for a later one. */
export interface SummaryScopePublication {
  readonly published: number;
  readonly pending: number;
}

/**
 * Publishes one scope's unpublished snapshots in order. A snapshot that does
 * not publish stops the pass, so later snapshots never overtake it, unless
 * the Ledger rejected it outright: retrying cannot help, so it is reported
 * and skipped.
 */
async function publishInOrder(
  scope: SummaryScope,
  snapshots: readonly PublishableSummarySnapshot[],
  host: SummaryPublicationHost,
): Promise<SummaryScopePublication> {
  const scopeLedger = await resolveSummaryScopeLedger(scope, host);
  if (scopeLedger === null) return { published: 0, pending: 0 };
  const keys = snapshots.map((snapshot) =>
    summaryPublicationKey(scopeLedger.ledgerId, snapshot.snapshotId),
  );
  const published = await readPublishedKeys(host, scopeLedger.ledgerId, keys);
  const unpublished = snapshots.filter(
    (_snapshot, index) => !published.has(keys[index] ?? ''),
  );
  let publishedNow = 0;
  let rejected = 0;
  for (const snapshot of unpublished) {
    const outcome = await publishResolvedSummarySnapshot(
      scopeLedger,
      snapshot,
      host,
    );
    if (outcome === 'published') {
      publishedNow += 1;
    } else if (outcome === 'rejected') {
      rejected += 1;
    } else {
      break;
    }
  }
  if (rejected > 0) host.recordGap(`rejected: ${String(rejected)}`);
  return {
    published: publishedNow,
    pending: unpublished.length - publishedNow,
  };
}

/**
 * Publishes, oldest first, the scope's publishable snapshots that have no
 * publication receipt: right after the scheduler writes a new snapshot, and
 * at startup. Never rejects.
 */
export async function publishPendingSummarySnapshots(
  scope: SummaryScope,
  host: SummaryReconciliationHost = DESKTOP_SUMMARY_RECONCILIATION_HOST,
): Promise<SummaryScopePublication> {
  try {
    if (!host.publication.isEnabled()) return { published: 0, pending: 0 };
    const snapshots = (await host.readHistory(scope)).filter(
      isPublishableSummarySnapshot,
    );
    if (snapshots.length === 0) return { published: 0, pending: 0 };
    try {
      return await publishInOrder(scope, snapshots, host.publication);
    } catch {
      return { published: 0, pending: snapshots.length };
    }
  } catch {
    return { published: 0, pending: 0 };
  }
}

/**
 * Publishes every publishable Summary snapshot that has no publication
 * receipt. Runs once at startup, after the Ledger's own startup pass, and
 * only while the Ledger is on. Never rejects.
 */
export async function reconcileSummaryPublications(
  host: SummaryReconciliationHost = DESKTOP_SUMMARY_RECONCILIATION_HOST,
): Promise<SummaryReconciliationResult> {
  const result = { scopes: 0, published: 0, pending: 0 };
  if (!host.publication.isEnabled()) return result;
  let scopes: SummaryScope[];
  try {
    scopes = await host.listScopes();
  } catch {
    return result;
  }
  for (const scope of scopes) {
    const outcome = await publishPendingSummarySnapshots(scope, host);
    if (outcome.published + outcome.pending > 0) result.scopes += 1;
    result.published += outcome.published;
    result.pending += outcome.pending;
  }
  return result;
}

import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  WorktreeRepoSummary,
  WorktreeSummaryData,
  WorktreeSummaryFile,
  WorktreeSummaryProvenance,
  WorktreeSummarySnapshot,
} from '@canopy/desktop-shared/types';
import { fnv1aHex } from '@canopy/desktop-shared/lib/stable-hash';
import { worktreeSummaryContentHash } from '@canopy/desktop-shared/lib/worktree-summary-hash';
import { MAX_TELEMETRY_SUMMARIES_PER_WORKTREE } from '@canopy/protocol';
import { writeFileAtomically } from './atomic-file';
import { resolveWorktreeSummaryFilePath } from './resolve-worktree';
import { isRecord } from './type-guards';
import { worktreeScopedParentLocalId } from '@canopy/protocol/portal';
import {
  createPortalEvent,
  enqueuePortalEvent,
  isCanopyPortalActive,
} from '../portal/portal-event-bus';

const lastEmittedPortalSummaryFingerprints = new Map<string, string>();

export function clearWorktreeSummaryPortalFingerprints(): void {
  lastEmittedPortalSummaryFingerprints.clear();
}

export function emitWorktreeSummaryPortalDelta(
  projectId: string,
  worktreeId: string,
  summary: WorktreeSummaryData,
  generating: boolean,
): void {
  // Match chat TODO / hook-descriptor re-emission: desktop-only writes must
  // avoid even projection/fingerprint work when no portal session can consume it.
  if (!isCanopyPortalActive()) return;
  const payload = {
    workspaceLocalId: projectId,
    worktreeLocalId: worktreeId,
    title: summary.title,
    description: summary.description,
    highlights: summary.highlights,
    repos: summary.repos,
    generatedAt: summary.generatedAt,
    lastFullRefreshAt: summary.lastFullRefreshAt,
    generating,
  };
  const key = `${projectId}\u0000${worktreeId}`;
  const fingerprint = JSON.stringify(payload);
  if (lastEmittedPortalSummaryFingerprints.get(key) === fingerprint) return;
  lastEmittedPortalSummaryFingerprints.set(key, fingerprint);
  enqueuePortalEvent(
    createPortalEvent('portal.state.delta', {
      scope: 'worktree',
      target: {
        workspaceLocalId: projectId,
        worktreeLocalId: worktreeId,
      },
      entities: [
        {
          entityType: 'worktree_summary',
          localId: worktreeId,
          parentLocalId: worktreeScopedParentLocalId(projectId, worktreeId),
          payload,
        },
      ],
      generatedAt: new Date().toISOString(),
    }),
  );
}

/**
 * Dependency-inverted hook fired whenever a worktree summary is (re)written.
 * The telemetry-sync service (CAN-402) registers here so it can amend the
 * worktree-level summary upload without this module importing the service.
 *
 * `snapshotId` is the stable id of the current latest snapshot; `isNewSnapshot`
 * is true only when this write produced a *new* history entry (meaningful
 * content change), so telemetry can enqueue exactly the changed snapshot.
 */
export type WorktreeSummaryChangeListener = (event: {
  projectId: string;
  worktreeId: string;
  summary: WorktreeSummaryData;
  snapshotId: string;
  isNewSnapshot: boolean;
}) => void;

const worktreeSummaryChangeListeners = new Set<WorktreeSummaryChangeListener>();

export function addWorktreeSummaryChangeListener(
  fn: WorktreeSummaryChangeListener,
): void {
  worktreeSummaryChangeListeners.add(fn);
}

export function removeWorktreeSummaryChangeListener(
  fn: WorktreeSummaryChangeListener,
): void {
  worktreeSummaryChangeListeners.delete(fn);
}

function emitWorktreeSummaryChange(
  projectId: string,
  worktreeId: string,
  summary: WorktreeSummaryData,
  snapshotId: string,
  isNewSnapshot: boolean,
): void {
  worktreeSummaryChangeListeners.forEach((listener) => {
    try {
      listener({ projectId, worktreeId, summary, snapshotId, isNewSnapshot });
    } catch {
      // Listener failures must not change summary persistence semantics.
    }
  });
}

/**
 * Read and normalize the on-disk summary file to the current v2 shape. A legacy
 * v1 file is upgraded to a single-entry v2 history whose `snapshotId` is derived
 * deterministically from the summary's `generatedAt`, so repeated reads of the
 * same legacy file yield a stable id. Returns null when the file is
 * missing/corrupt or fails validation.
 */
async function readWorktreeSummaryFileNormalized(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeSummaryFile | null> {
  try {
    const filePath = resolveWorktreeSummaryFilePath(projectId, worktreeId);
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return normalizeWorktreeSummaryFile(parsed);
  } catch {
    return null;
  }
}

/** The summary file as a write reads it. */
type WorktreeSummaryFileRead =
  | { readonly kind: 'present'; readonly file: WorktreeSummaryFile }
  | { readonly kind: 'missing' }
  /** It exists but does not parse as a summary file. */
  | { readonly kind: 'corrupt' }
  /** Reading it failed for another reason, perhaps only for now. */
  | { readonly kind: 'unreadable' };

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

async function readWorktreeSummaryFileForWrite(
  filePath: string,
): Promise<WorktreeSummaryFileRead> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    return isMissingFileError(error)
      ? { kind: 'missing' }
      : { kind: 'unreadable' };
  }
  try {
    const file = normalizeWorktreeSummaryFile(JSON.parse(raw));
    return file === null ? { kind: 'corrupt' } : { kind: 'present', file };
  } catch {
    return { kind: 'corrupt' };
  }
}

export async function readWorktreeSummary(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeSummaryData | null> {
  const file = await readWorktreeSummaryFileNormalized(projectId, worktreeId);
  return file ? file.summary : null;
}

/**
 * Read the full v2 summary file (latest pointer plus append-on-change history).
 * Used by telemetry sync and a future local timeline UI. Legacy v1 files are
 * normalized to v2 on read.
 */
export async function readWorktreeSummaryFile(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeSummaryFile | null> {
  return readWorktreeSummaryFileNormalized(projectId, worktreeId);
}

/** What a summary write did to the history. */
export interface WorktreeSummaryWriteResult {
  /** The latest snapshot: the new one, or the unchanged one it matched. */
  readonly snapshot: WorktreeSummarySnapshot;
  readonly isNewSnapshot: boolean;
  /**
   * Ledger-publishable snapshots this write dropped from the capped history,
   * oldest first. One that never published can no longer be reconciled.
   */
  readonly droppedPublishableSnapshotIds: readonly string[];
  /**
   * The previous file did not parse, so this write replaced it, history and
   * all. Whatever it held could not have been published.
   */
  readonly replacedCorruptFile: boolean;
}

export async function writeWorktreeSummary(
  projectId: string,
  worktreeId: string,
  summary: WorktreeSummaryData,
): Promise<boolean> {
  return (
    (await writeWorktreeSummarySnapshot(projectId, worktreeId, summary)) !==
    null
  );
}

/**
 * Writes a summary, appending a history snapshot when its content changed.
 * `provenance` is recorded only on a new snapshot; an unchanged summary
 * keeps the snapshot (and provenance) it matched. The file is replaced
 * atomically and durably, so it can serve as the Ledger publication journal.
 * A file that exists but cannot be read aborts the write, so its pending
 * snapshots are never replaced. Null when the write failed or was aborted.
 */
export async function writeWorktreeSummarySnapshot(
  projectId: string,
  worktreeId: string,
  summary: WorktreeSummaryData,
  provenance?: WorktreeSummaryProvenance,
): Promise<WorktreeSummaryWriteResult | null> {
  try {
    const filePath = resolveWorktreeSummaryFilePath(projectId, worktreeId);
    const summaryDir = dirname(filePath);
    await mkdir(summaryDir, { recursive: true });

    const existing = await readWorktreeSummaryFileForWrite(filePath);
    if (existing.kind === 'unreadable') return null;
    const history: WorktreeSummarySnapshot[] =
      existing.kind === 'present' ? [...existing.file.history] : [];

    const newHash = worktreeSummaryContentHash(summary);
    const last = history[history.length - 1];
    const lastHash = last ? worktreeSummaryContentHash(last.summary) : null;

    let snapshot: WorktreeSummarySnapshot;
    let isNewSnapshot: boolean;
    if (last === undefined || lastHash !== newHash) {
      // Meaningful content change (or first snapshot) → append a new entry.
      snapshot = {
        snapshotId: randomUUID(),
        summary,
        ...(provenance === undefined ? {} : { provenance }),
      };
      history.push(snapshot);
      isNewSnapshot = true;
    } else {
      // Unchanged narrative content (only volatile bookkeeping moved) → keep the
      // existing history but still refresh the latest pointer below.
      snapshot = last;
      isNewSnapshot = false;
    }

    // Bound the on-disk history so a long-lived worktree with frequent
    // meaningful content changes doesn't grow the JSON file without limit.
    // History is oldest-first, so keep the most recent N entries. The cap
    // matches the telemetry flush slice and server keyset paging so local and
    // uploaded history stay aligned.
    const trimmedHistory = history.slice(-MAX_TELEMETRY_SUMMARIES_PER_WORKTREE);
    const droppedPublishableSnapshotIds = history
      .slice(0, history.length - trimmedHistory.length)
      .filter((dropped) => dropped.provenance?.ledgerPublishable === true)
      .map((dropped) => dropped.snapshotId);

    const payload: WorktreeSummaryFile = {
      version: 2,
      summary,
      history: trimmedHistory,
    };
    await writeFileAtomically(filePath, JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      durable: true,
    });
    emitWorktreeSummaryPortalDelta(projectId, worktreeId, summary, false);
    emitWorktreeSummaryChange(
      projectId,
      worktreeId,
      summary,
      snapshot.snapshotId,
      isNewSnapshot,
    );
    return {
      snapshot,
      isNewSnapshot,
      droppedPublishableSnapshotIds,
      replacedCorruptFile: existing.kind === 'corrupt',
    };
  } catch {
    return null;
  }
}

export function isWorktreeSummaryData(
  value: unknown,
): value is WorktreeSummaryData {
  if (!isRecord(value)) {
    return false;
  }

  const title = value.title;
  const description = value.description;
  const highlights = value.highlights;
  const generatedAt = value.generatedAt;
  const turnCountAtGeneration = value.turnCountAtGeneration;
  const lastFullRefreshAt = value.lastFullRefreshAt;
  const lastFullRefreshTurnCount = value.lastFullRefreshTurnCount;
  const repos = value.repos;

  return (
    typeof title === 'string' &&
    title.trim().length > 0 &&
    typeof description === 'string' &&
    description.trim().length > 0 &&
    Array.isArray(highlights) &&
    highlights.every(
      (entry) => typeof entry === 'string' && entry.trim().length > 0,
    ) &&
    typeof generatedAt === 'string' &&
    typeof turnCountAtGeneration === 'number' &&
    Number.isFinite(turnCountAtGeneration) &&
    typeof lastFullRefreshAt === 'string' &&
    typeof lastFullRefreshTurnCount === 'number' &&
    Number.isFinite(lastFullRefreshTurnCount) &&
    (repos === undefined ||
      (Array.isArray(repos) && repos.every(isWorktreeRepoSummary)))
  );
}

export function isWorktreeSummarySnapshot(
  value: unknown,
): value is WorktreeSummarySnapshot {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.snapshotId === 'string' &&
    value.snapshotId.trim().length > 0 &&
    isWorktreeSummaryData(value.summary)
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function isWorktreeSummaryProvenance(
  value: unknown,
): value is WorktreeSummaryProvenance {
  return (
    isRecord(value) &&
    typeof value.generationId === 'string' &&
    value.generationId.trim().length > 0 &&
    isNullableString(value.harness) &&
    isNullableString(value.model) &&
    isNullableString(value.thinkingEffort) &&
    isNullableString(value.observedTaskKey) &&
    typeof value.capturedAt === 'string' &&
    (value.ledgerPublishable === undefined ||
      typeof value.ledgerPublishable === 'boolean')
  );
}

/**
 * A snapshot whose provenance does not validate keeps its summary but loses
 * the provenance, so it is never published under details nobody captured.
 */
function withValidProvenance(
  snapshot: WorktreeSummarySnapshot,
): WorktreeSummarySnapshot {
  if (
    snapshot.provenance === undefined ||
    isWorktreeSummaryProvenance(snapshot.provenance)
  ) {
    return snapshot;
  }
  const withoutProvenance: WorktreeSummarySnapshot = { ...snapshot };
  delete withoutProvenance.provenance;
  return withoutProvenance;
}

/**
 * Normalize an unknown parsed JSON value to the current v2 file shape. Accepts
 * both v1 (single latest snapshot) and v2 (latest + history) on-disk formats.
 * Returns null when neither form validates.
 */
function normalizeWorktreeSummaryFile(
  value: unknown,
): WorktreeSummaryFile | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.version === 2) {
    if (!isWorktreeSummaryData(value.summary)) {
      return null;
    }
    const rawHistory = value.history;
    if (!Array.isArray(rawHistory)) {
      return null;
    }
    const history = rawHistory
      .filter(isWorktreeSummarySnapshot)
      .map(withValidProvenance);
    return { version: 2, summary: value.summary, history };
  }

  if (value.version === 1 && isWorktreeSummaryData(value.summary)) {
    const summary = value.summary;
    return {
      version: 2,
      summary,
      history: [
        {
          snapshotId: `legacy-${fnv1aHex(summary.generatedAt)}`,
          summary,
        },
      ],
    };
  }

  return null;
}

function isWorktreeRepoSummary(value: unknown): value is WorktreeRepoSummary {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    typeof value.description === 'string' &&
    value.description.trim().length > 0
  );
}

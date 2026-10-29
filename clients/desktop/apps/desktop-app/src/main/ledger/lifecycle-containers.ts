import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import {
  APP_ADVISOR_PROJECT_ID,
  type ArchivedContainerManifest,
} from '@canopy/desktop-shared/types';
import type { LedgerContainerIncarnation } from './lifecycle';

/*
 * The Ledger containers that host records name, for the lifecycle
 * participants. Pure mappings with no storage, so host code derives an
 * incarnation inside its own try/catch without touching the Ledger.
 */

/** A persisted row: the container's own ID and creation time (RFC 3339). */
interface LedgerContainerRow {
  readonly id: string;
  readonly createdAt: string;
}

/** Mirrors `validateId`: persisted workspace, worktree and entry IDs. */
const SAFE_CONTAINER_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Whether an ID is safe to address persistence with, as `validateId` checks
 * every workspace, worktree and entry ID the app persists.
 */
export function isSafeLedgerContainerId(id: string): boolean {
  return SAFE_CONTAINER_ID.test(id);
}

/**
 * The Ledger container of a Cowork or App Advisor Work Entry. App Advisor
 * entries live in their app workspace, outside the workspace index.
 */
export function ledgerWorkEntryContainer(
  workspaceId: string,
  entryId: string,
): LedgerContainer {
  return workspaceId === APP_ADVISOR_PROJECT_ID
    ? {
        kind: 'advisor_entry',
        appWorkspaceId: APP_ADVISOR_PROJECT_ID,
        entryId,
      }
    : { kind: 'cowork_entry', workspaceId, entryId };
}

/** A Work Entry at the incarnation its `work-entries.json` row records. */
export function workEntryLedgerIncarnation(
  workspaceId: string,
  entry: LedgerContainerRow,
): LedgerContainerIncarnation {
  return {
    container: ledgerWorkEntryContainer(workspaceId, entry.id),
    containerCreatedAt: entry.createdAt,
  };
}

/** A code worktree at the incarnation its `worktrees.json` row records. */
export function worktreeLedgerIncarnation(
  workspaceId: string,
  worktree: LedgerContainerRow,
): LedgerContainerIncarnation {
  return {
    container: { kind: 'code_worktree', workspaceId, worktreeId: worktree.id },
    containerCreatedAt: worktree.createdAt,
  };
}

/**
 * The incarnation an archived worktree or Work Entry was archived from: the
 * original container and the verified creation time its manifest keeps.
 */
export function archivedLedgerIncarnation(
  manifest: ArchivedContainerManifest,
): LedgerContainerIncarnation {
  return manifest.kind === 'worktree'
    ? worktreeLedgerIncarnation(manifest.projectId, manifest)
    : workEntryLedgerIncarnation(manifest.projectId, manifest);
}

/**
 * The incarnation a restore created from this archive: the same kind of
 * container, in the same workspace, under the restored ID and creation time.
 */
export function restoredLedgerIncarnation(
  manifest: ArchivedContainerManifest,
  restored: LedgerContainerRow,
): LedgerContainerIncarnation {
  return manifest.kind === 'worktree'
    ? worktreeLedgerIncarnation(manifest.projectId, restored)
    : workEntryLedgerIncarnation(manifest.projectId, restored);
}

/**
 * Where a partially restored archive's Ledger scope belongs: the incarnation
 * it was archived from and the one its restore created. While the archive
 * remains, its `restoredTo` may be the only lasting record of that mapping.
 * Null without a restore destination, or when the manifest predates restore
 * creation times and so cannot prove one.
 */
export function ledgerRestoreMappingOf(manifest: ArchivedContainerManifest): {
  readonly archived: LedgerContainerIncarnation;
  readonly restored: LedgerContainerIncarnation;
} | null {
  const restoredTo = manifest.restoredTo;
  if (restoredTo?.createdAt === undefined) return null;
  return {
    archived: archivedLedgerIncarnation(manifest),
    restored: restoredLedgerIncarnation(manifest, {
      id: restoredTo.id,
      createdAt: restoredTo.createdAt,
    }),
  };
}

/**
 * The incarnation whose scope purging this archive retires: the one it was
 * archived from. Null once a restore recorded a destination, because that
 * scope moved to the restored container, so purging what remains of the
 * restore's archive retires nothing.
 */
export function ledgerIncarnationRetiredByPurge(
  manifest: ArchivedContainerManifest,
): LedgerContainerIncarnation | null {
  return manifest.restoredTo ? null : archivedLedgerIncarnation(manifest);
}

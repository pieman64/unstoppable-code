import type {
  ProjectDeletionDiscardDescription,
  ProjectDeletionDiscardItem,
  ProjectDeletionInterruptedDeletion,
} from '@canopy/protocol/portal/project-deletion-discard';
import type {
  WorktreeDiscardDescription,
  WorktreeDiscardRefusal,
} from '@canopy/protocol/portal/worktree-discard';
import { basename, dirname, resolve } from 'node:path';
import { getArchivedContainersRootDir } from './paths';
import { isWritableScope } from './read-only-scope';
import { validateId } from './validation';
import {
  isAdmittedByUserProjectDeletion,
  isDestructiveRecoveryOwnerless,
  isInterruptedIndexRemovalDeletion,
  readWorkspaceDestructiveRecoveries,
} from './w5-destructive-recovery';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
} from './workspace-persistence';
import {
  assertRetainedArchivesReadable,
  assertWorkspaceDeletableBesideItsWorktrees,
  isWorkspaceIndexed,
} from './workspace-deletion';
import { describeWorktreeDiscard } from './worktree-discard';

/**
 * CAN-5337 (CAN-4995 E): what keeps a listed code project's deletion from
 * finishing, when that is only worktrees a user can discard (CAN-5334) and an
 * interrupted deletion the next one may supersede. Read-only, like the
 * worktree description it is built from; it discards nothing. Any other
 * refusal, an unreadable journal or an operation still running leaves it
 * `refused`, so the deletion's own message stands. An unindexed project is
 * out of scope (CAN-5316).
 */

/** An ordinary deletion finishes these itself; they block nothing. */
const ORDINARY_REMOVAL: ReadonlySet<WorktreeDiscardRefusal> = new Set([
  'no-broken-removal',
  'retry-available',
  'not-found',
]);

interface Candidate {
  worktreeId: string;
  worktreeName?: string;
  /** An unfinished journal of it that the deletion's admission refuses. */
  blocksAdmission: boolean;
}

function refusedDescription(
  workspaceId: string,
): ProjectDeletionDiscardDescription {
  return { version: 1, workspaceId, status: 'refused', items: [] };
}

/** Its list order: the rows, then worktrees only a journal still names. */
async function readCandidates(
  workspaceId: string,
  blocking: ReadonlySet<string>,
): Promise<Candidate[] | null> {
  const list = await readWorkspaceWorktreesDetailed(workspaceId, {
    persistRemovalCleanup: false,
  });
  if (list.authority !== 'ok' && list.authority !== 'absent') return null;
  const candidates: Candidate[] = list.worktrees.map((worktree) => ({
    worktreeId: worktree.id,
    worktreeName: worktree.label?.trim() || worktree.branchName || worktree.id,
    blocksAdmission: blocking.has(worktree.id),
  }));
  for (const worktreeId of blocking)
    if (!candidates.some((candidate) => candidate.worktreeId === worktreeId))
      candidates.push({ worktreeId, blocksAdmission: true });
  return candidates;
}

/** An indexed code project whose deletion's other admission checks pass. */
async function isDeletableBesideItsWorktrees(
  workspaceId: string,
): Promise<boolean> {
  if (!(await isWorkspaceIndexed(workspaceId))) return false;
  const kind = await assertWorkspaceDeletableBesideItsWorktrees(workspaceId);
  return (
    (kind === 'single-repo' || kind === 'multi-repo') &&
    (await readWorkspaceConfigDetailed(workspaceId)).authority === 'ok'
  );
}

interface JournalFindings {
  /** Worktrees whose unfinished journal the deletion's admission refuses. */
  blocking: Set<string>;
  interruptedDeletion?: ProjectDeletionInterruptedDeletion;
}

/**
 * The project's unfinished journals as the deletion's admission sees them;
 * null when one refuses it for anything but a discardable item. Throws for
 * any unreadable journal, which keeps its quarantine review.
 */
async function readJournalFindings(
  workspaceId: string,
): Promise<JournalFindings | null> {
  const findings: JournalFindings = { blocking: new Set() };
  for (const record of await readWorkspaceDestructiveRecoveries(workspaceId)) {
    if (record.state === 'completed') continue;
    if (!isDestructiveRecoveryOwnerless(record)) return null;
    if (await isAdmittedByUserProjectDeletion(record)) continue;
    if (record.worktreeId !== undefined) {
      findings.blocking.add(record.worktreeId);
      continue;
    }
    if (!(await isInterruptedIndexRemovalDeletion(record))) return null;
    findings.interruptedDeletion = { operationId: record.operationId };
  }
  return findings;
}

/** Each discardable candidate; null when one blocks for anything else. */
async function describeItems(
  workspaceId: string,
  candidates: readonly Candidate[],
  ignoreInterruptedDeletion: boolean,
): Promise<ProjectDeletionDiscardItem[] | null> {
  const items: ProjectDeletionDiscardItem[] = [];
  for (const candidate of candidates) {
    const description: WorktreeDiscardDescription =
      await describeWorktreeDiscard(workspaceId, candidate.worktreeId, {
        ignoreInterruptedDeletion,
      });
    if (description.status === 'discardable') {
      items.push({
        ...(candidate.worktreeName
          ? { worktreeName: candidate.worktreeName }
          : {}),
        description,
      });
      continue;
    }
    const reason = description.refusal?.reason;
    if (
      candidate.blocksAdmission ||
      reason === undefined ||
      !ORDINARY_REMOVAL.has(reason)
    )
      return null;
  }
  return items;
}

/**
 * The archive-root entries the items' discards remove: each recovery copy
 * target where it now is, in place or moved aside by an interrupted discard.
 * A container a discard does not target stays under the deletion's reads.
 */
function archiveDirectoriesDiscarded(
  workspaceId: string,
  items: readonly ProjectDeletionDiscardItem[],
): Set<string> {
  const root = resolve(getArchivedContainersRootDir(workspaceId));
  const names = new Set<string>();
  for (const { description } of items)
    for (const target of description.targets)
      if (
        target.kind === 'files-only-recovery' &&
        resolve(dirname(target.path)) === root
      )
        names.add(basename(target.path));
  return names;
}

export async function describeProjectDeletionDiscard(
  workspaceId: string,
): Promise<ProjectDeletionDiscardDescription> {
  validateId(workspaceId, 'workspaceId');
  const refused = refusedDescription(workspaceId);
  if (!isWritableScope(workspaceId)) return refused;
  try {
    if (!(await isDeletableBesideItsWorktrees(workspaceId))) return refused;
    const findings = await readJournalFindings(workspaceId);
    if (!findings) return refused;
    const { interruptedDeletion } = findings;
    const candidates = await readCandidates(workspaceId, findings.blocking);
    const items =
      candidates &&
      (await describeItems(
        workspaceId,
        candidates,
        interruptedDeletion !== undefined,
      ));
    if (!items || (items.length === 0 && !interruptedDeletion)) return refused;
    // The deletion would fail on another archive after these discards.
    await assertRetainedArchivesReadable(
      workspaceId,
      archiveDirectoriesDiscarded(workspaceId, items),
    );
    return {
      version: 1,
      workspaceId,
      status: 'discardable',
      items,
      ...(interruptedDeletion ? { interruptedDeletion } : {}),
    };
  } catch {
    return refused;
  }
}

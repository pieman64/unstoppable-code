import { cp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ArchivedContainerManifest,
  ArchivedContainerSummary,
} from '@canopy/desktop-shared/types';
import { toArchivedContainerSummary } from '@canopy/desktop-shared/lib/archived-container-contracts';
import { getArchivedContainerCostDir, getEntryCostDir } from '../lib/paths';
import { isErrnoException, isRecord } from '../lib/type-guards';

/*
 * Cost follows an entry through archive, restore and deletion, but it never
 * decides whether they happen. Every hook here is best-effort: a failure is
 * reported without entry content and the entry's own operation carries on.
 * The worst outcome is an entry whose retained cost is stale or absent.
 */

function reportCostLifecycleFailure(step: string, error: unknown): void {
  // The error's name only: messages can carry host paths.
  const kind = error instanceof Error ? error.name : typeof error;
  // eslint-disable-next-line no-console
  console.warn(`[cost-index] ${step} failed; continuing without it (${kind})`);
}

/** Called under the archive operation lease, before its mutation/copy lock. */
export async function prepareEntryCostArchive(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  try {
    const { getDesktopCostIndexStore, CostServiceError } =
      await import('./service');
    const store = getDesktopCostIndexStore();
    const scope = { kind: 'entry', projectId, worktreeId } as const;
    try {
      await store.refreshInternal('archive', scope);
      await store.sealScope(scope);
    } catch (error) {
      // A retry after removal uses the captured payload; it must not recreate live data.
      if (error instanceof CostServiceError && error.reason === 'no_scope')
        return;
      throw error;
    }
  } catch (error) {
    // The archive copies whatever cost files exist, unsealed or stale.
    reportCostLifecycleFailure('archive catch-up', error);
  }
}

/** Copies cost into the archive on its own, so a failed copy never stops it. */
export async function captureEntryCostArchive(
  copy: () => Promise<unknown>,
): Promise<void> {
  try {
    await copy();
  } catch (error) {
    // The archive keeps every other payload and shows no retained cost.
    reportCostLifecycleFailure('archive copy', error);
  }
}

export async function restoreEntryCostArchive(
  projectId: string,
  containerId: string,
  worktreeId: string,
  incarnation: string,
): Promise<void> {
  try {
    const directory = getEntryCostDir(projectId, worktreeId);
    try {
      await cp(getArchivedContainerCostDir(projectId, containerId), directory, {
        recursive: true,
        force: true,
      });
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return;
      throw error;
    }
    const { getDesktopCostIndexStore } = await import('./service');
    await getDesktopCostIndexStore().restoreScope(
      directory,
      { kind: 'entry', projectId, worktreeId },
      incarnation,
    );
  } catch (error) {
    // The restored entry starts without its earlier cost.
    reportCostLifecycleFailure('restore', error);
  }
}

/** The retained copy stays sealed; a still-live entry can survive archive rollback. */
export async function finishEntryCostArchive(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  try {
    const { getDesktopCostIndexStore } = await import('./service');
    await getDesktopCostIndexStore().resumeScope({
      kind: 'entry',
      projectId,
      worktreeId,
    });
  } catch (error) {
    reportCostLifecycleFailure('reopen after archive', error);
  }
}

export async function removeEntryCost(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  try {
    const { getDesktopCostIndexStore } = await import('./service');
    await getDesktopCostIndexStore().retireScope({
      kind: 'entry',
      projectId,
      worktreeId,
    });
  } catch (error) {
    // The files are removed regardless, so no cost outlives its entry.
    reportCostLifecycleFailure('retire', error);
  }
  await rm(getEntryCostDir(projectId, worktreeId), {
    recursive: true,
    force: true,
  });
}

/** The archive list reads a small sealed summary, never starts the cost writer. */
export async function archivedContainerSummaryWithCost(
  manifest: ArchivedContainerManifest,
): Promise<ArchivedContainerSummary> {
  const summary = toArchivedContainerSummary(manifest);
  try {
    const raw: unknown = JSON.parse(
      await readFile(
        join(
          getArchivedContainerCostDir(manifest.projectId, manifest.id),
          'summary.json',
        ),
        'utf8',
      ),
    );
    if (
      !isRecord(raw) ||
      raw.version !== 1 ||
      raw.incarnation !== manifest.createdAt ||
      typeof raw.sealedAt !== 'string' ||
      !isRecord(raw.totals)
    )
      return summary;
    const usd = raw.totals.usd;
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0)
      return summary;
    const recorded =
      (Array.isArray(raw.chats) && raw.chats.length > 0) ||
      (Array.isArray(raw.pipelineRuns) && raw.pipelineRuns.length > 0) ||
      raw.unattached !== undefined;
    return recorded ? { ...summary, observedCostUsd: usd } : summary;
  } catch {
    // Missing, unreadable or malformed: the entry is listed without a cost.
    return summary;
  }
}

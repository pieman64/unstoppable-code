import type {
  PortalEntityEnvelope,
  PortalEntityRemoval,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import {
  type PortalBackgroundProcessEntity,
  worktreeScopedParentLocalId,
} from '@canopy/protocol/portal';
import { logMainProcessError } from '../../lib/main-process-logging';
import {
  listTrackedBackgroundProcesses,
  subscribeBackgroundProcessTracker,
  type BackgroundProcessTrackerTarget,
  type TrackedBackgroundProcess,
} from '../background-process-tracker';
import {
  createPortalEvent,
  enqueuePortalEvent,
  isCanopyPortalActive,
} from '../portal-event-bus';

interface BackgroundProcessAdapterDependencies {
  portalActive?: () => boolean;
  emit?: (event: PortalEventEnvelope) => void;
}

const fingerprints = new Map<string, string>();
const emittedLocalIds = new Map<string, string[]>();
let unsubscribeTracker: (() => void) | null = null;

function projectionKey(target: BackgroundProcessTrackerTarget): string {
  return `${target.workspaceLocalId}\u0000${target.worktreeLocalId}`;
}

export function projectPortalBackgroundProcessEntities(
  target: BackgroundProcessTrackerTarget,
  processes: readonly TrackedBackgroundProcess[],
): PortalBackgroundProcessEntity[] {
  return processes
    .map(
      (process): PortalBackgroundProcessEntity => ({
        localId: process.id,
        workspaceLocalId: target.workspaceLocalId,
        worktreeLocalId: target.worktreeLocalId,
        chatId: process.chatId,
        toolUseId: process.toolUseId,
        ...(process.taskId === undefined ? {} : { taskId: process.taskId }),
        kind: process.kind,
        description: process.description,
        status: process.status,
        startedAt: process.startedAt,
        updatedAt: process.updatedAt,
        ...(process.summary === undefined ? {} : { summary: process.summary }),
        ...(process.lastDescription === undefined
          ? {}
          : { lastDescription: process.lastDescription }),
        canStop: process.canStop,
      }),
    )
    .sort((left, right) => left.localId.localeCompare(right.localId));
}

export function portalBackgroundProcessEntityEnvelope(
  entity: PortalBackgroundProcessEntity,
): PortalEntityEnvelope {
  return {
    entityType: 'background_process',
    localId: entity.localId,
    parentLocalId: worktreeScopedParentLocalId(
      entity.workspaceLocalId,
      entity.worktreeLocalId,
    ),
    payload: entity,
  };
}

export function emitPortalBackgroundProcessProjection(
  target: BackgroundProcessTrackerTarget,
  dependencies: BackgroundProcessAdapterDependencies = {},
): void {
  const portalActive = (): boolean =>
    dependencies.portalActive?.() ?? isCanopyPortalActive();
  if (!portalActive()) {
    return;
  }
  const key = projectionKey(target);
  const entities = projectPortalBackgroundProcessEntities(
    target,
    listTrackedBackgroundProcesses(target),
  );
  const fingerprint = JSON.stringify(entities);
  if (fingerprints.get(key) === fingerprint) {
    return;
  }
  const previousLocalIds = emittedLocalIds.get(key) ?? [];
  if (entities.length === 0 && previousLocalIds.length === 0) {
    fingerprints.set(key, fingerprint);
    return;
  }
  const nextLocalIds = entities.map((entity) => entity.localId);
  const nextLocalIdSet = new Set(nextLocalIds);
  const parentLocalId = worktreeScopedParentLocalId(
    target.workspaceLocalId,
    target.worktreeLocalId,
  );
  const removed: PortalEntityRemoval[] = previousLocalIds
    .filter((localId) => !nextLocalIdSet.has(localId))
    .map((localId) => ({
      entityType: 'background_process',
      localId,
      parentLocalId,
    }));
  fingerprints.set(key, fingerprint);
  emittedLocalIds.set(key, nextLocalIds);
  const event = createPortalEvent('portal.state.delta', {
    scope: 'worktree',
    target,
    entities: entities.map(portalBackgroundProcessEntityEnvelope),
    ...(removed.length === 0 ? {} : { removed }),
    generatedAt: new Date().toISOString(),
  });
  if (dependencies.emit) {
    dependencies.emit(event);
  } else {
    enqueuePortalEvent(event);
  }
}

// NOTE: not a pure read — seeds the fingerprint/emitted-id caches so the
// next delta emission diffs against the snapshot baseline.
export function listPortalBackgroundProcessEntitiesForWorktree(
  target: BackgroundProcessTrackerTarget,
): PortalEntityEnvelope[] {
  const key = projectionKey(target);
  const entities = projectPortalBackgroundProcessEntities(
    target,
    listTrackedBackgroundProcesses(target),
  );
  fingerprints.set(key, JSON.stringify(entities));
  emittedLocalIds.set(
    key,
    entities.map((entity) => entity.localId),
  );
  return entities.map(portalBackgroundProcessEntityEnvelope);
}

export function startPortalBackgroundProcessProjection(): void {
  if (unsubscribeTracker) {
    return;
  }
  unsubscribeTracker = subscribeBackgroundProcessTracker((target): void => {
    try {
      emitPortalBackgroundProcessProjection(target);
    } catch (error: unknown) {
      logMainProcessError('Portal background-process projection failed', error);
    }
  });
}

export function clearPortalBackgroundProcessFingerprints(): void {
  fingerprints.clear();
  emittedLocalIds.clear();
}

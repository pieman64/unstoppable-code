import type { WebContents } from 'electron';
import {
  IPC_CHANNELS,
  type TrackedPlanFileVisibilityRequest,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from './register';
import { validateId } from '../lib/validation';
import { hasTrackedPlanStorage } from '../lib/tracked-plan-scope';
import {
  getPlanFileSyncService,
  planFileKey,
  type PlanFileRef,
} from '../lib/plan-file-sync';

/**
 * Live visibility leases per sending renderer, keyed by `planFileKey(ref)` +
 * `consumerId`. Mirrors the code-review sender-lease pattern
 * (`ipc/code-review.ts`).
 */
const visibilityLeases = new WeakMap<WebContents, Map<string, () => void>>();

/** The lease bookkeeping map for `sender`, wiring its bulk-release triggers
 * the first time this sender is seen. */
function leaseMapFor(sender: WebContents): Map<string, () => void> {
  const existing = visibilityLeases.get(sender);
  if (existing) {
    return existing;
  }
  const leases = new Map<string, () => void>();
  visibilityLeases.set(sender, leases);
  const release = (): void => {
    for (const close of Array.from(leases.values())) close();
    leases.clear();
  };
  sender.once('destroyed', release);
  sender.on('render-process-gone', release);
  // A same-document navigation (hash/history change) keeps the same views
  // mounted; only a main-frame cross-document navigation (reload, address
  // change) tears down every React tree that could hold a lease.
  sender.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      release();
    }
  });
  return leases;
}

/**
 * Registers the `tracked-plans:file-visibility` handler that lets a plan
 * document/diagram view (or the plan-explore takeover) tell
 * {@link PlanFileSyncService} it is on screen, so the plan's working file is
 * checked for agent edits while shown and the shared slow poll keeps running.
 * Leases are tracked per sending `WebContents` and released in bulk when that
 * renderer is destroyed, its process is gone, or its main frame navigates to
 * a new document — see {@link leaseMapFor}. Ignored for scopes without
 * tracked-plan storage (Cowork, assistant/app-managed sentinels, the
 * shared-container viewer).
 */
export function registerPlanFileVisibilityHandlers(): void {
  registerIpcHandler<[TrackedPlanFileVisibilityRequest], void>(
    IPC_CHANNELS.trackedPlansFileVisibility,
    (event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.planId, 'planId');
      validateId(request.consumerId, 'consumerId');
      if (typeof request.visible !== 'boolean') {
        throw new Error('visible must be a boolean');
      }
      if (!hasTrackedPlanStorage(request.projectId)) {
        return;
      }
      const ref: PlanFileRef = {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        planId: request.planId,
      };
      const service = getPlanFileSyncService();
      const ownerId = `${event.sender.id}:${request.consumerId}`;
      const key = `${planFileKey(ref)}:${request.consumerId}`;
      const leases = leaseMapFor(event.sender);
      if (request.visible) {
        leases.set(key, () => service.releaseVisibility(ref, ownerId));
        service.acquireVisibility(ref, ownerId);
      } else {
        leases.delete(key);
        service.releaseVisibility(ref, ownerId);
      }
    },
  );
}

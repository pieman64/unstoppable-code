import { retryElectronW5RecordPorts } from './electron-w5-record-port';
import type { ReadEvidenceCursor } from '@canopy/desktop-shared/lib/bounded-read-evidence';
import { snapshotFilesWorkCounters } from '@canopy/desktop-shared/node/work-counters';
import { BRAND } from '@canopy/brand/current';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import type { BackgroundServiceStatus } from '@canopy/desktop-shared/lib/background-service-status';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { resolveWorktreeTargetIds } from '../lib/resolve-worktree';
import { getWorkspaceType } from '../lib/workspace-registry';
import {
  createDaemonFilesRoute,
  type DaemonFilesRouteSender,
  type ObservedDaemonFilesRoute,
  type FilesRouteEvidenceSnapshot,
} from './daemon-files-route';
import { isLocalWindowCaller } from './daemon-read-route-guard';
import { isW5DaemonFlipCompiled } from '../lib/w5-flip-gate';
import {
  disposeElectronDaemonCallerLifetimes,
  disposeElectronDaemonConnections,
  getElectronDaemonCallerLifetime,
  getElectronDaemonConnections,
  getElectronDaemonFilesContext,
  isElectronW5HandoffPending,
  setElectronDaemonFilesConsumerEnabled,
} from './electron-daemon-access';
import { getElectronDaemonHealth } from './electron-daemon-health';

let route: ObservedDaemonFilesRoute | undefined;

/**
 * The production Files route, built on the first file-tree read. Building it
 * enables the Files consumer; the daemon is contacted only for a selected read.
 */
export function getDesktopDaemonFilesRoute(): ObservedDaemonFilesRoute {
  if (route) return route;
  const health = getElectronDaemonHealth();
  setElectronDaemonFilesConsumerEnabled(true);
  route = createDaemonFilesRoute({
    lifetime: getElectronDaemonCallerLifetime(),
    connections: getElectronDaemonConnections,
    hostContext: getElectronDaemonFilesContext,
    // `build-core-daemon.mjs` bakes the same name into the daemon.
    coworkManagedDirName: BRAND.storage.projectConfigDirNames[0],
    displayDataRoot: getCanopyDataDir,
    workspaceType: getWorkspaceType,
    resolveWorktreeTargetIds,
    reachability: {
      // The W5 flip handoff is a restart window: read in-process, show nothing.
      isLatched: () => health.isLatched() || isElectronW5HandoffPending(),
      noteFallback: (reason) => health.noteFallback('files_reads', reason),
    },
  });
  return route;
}

/**
 * Try again for the background service notice: one attach or start for the
 * requesting window, with exactly the caller and owner its Files reads use,
 * so the retry and those reads share one session instead of replacing each
 * other's. Only a local window that Files reads route for may retry.
 */
export function retryDesktopDaemonFilesConnection(
  sender: DaemonFilesRouteSender,
  caller: CanopyCallerDescriptor,
): Promise<BackgroundServiceStatus> {
  const health = getElectronDaemonHealth();
  if (!isLocalWindowCaller(caller, sender.id) || isElectronW5HandoffPending())
    return Promise.resolve(health.getStatus());
  const retryFiles = async (): Promise<boolean> => {
    const host = await getElectronDaemonFilesContext();
    const session = await getElectronDaemonConnections().get(
      { ...caller, authorityId: host.authorityId },
      getElectronDaemonCallerLifetime().ownerFor(sender),
      { reprobe: true },
    );
    // A reused session may still be reconnecting: that is not reached yet.
    return session.lease.state === 'active';
  };
  return health.retry(async () => {
    const results = await Promise.allSettled([
      retryFiles(),
      retryElectronW5RecordPorts(),
    ]);
    return results.every(
      (result) => result.status === 'fulfilled' && result.value,
    );
  });
}

/**
 * Quit: after the runtime drained, ends routed reads and daemon sessions. A
 * flip build keeps the connections, which the W5 store and its commit
 * observation still use, until its own slot after the last W5 writer.
 */
export async function disposeElectronDaemonFiles(): Promise<void> {
  route?.dispose();
  if (isW5DaemonFlipCompiled()) disposeElectronDaemonCallerLifetimes();
  else await disposeElectronDaemonConnections();
}

/** Reading this never creates the route, starts a daemon, or contacts auth. */
export interface DesktopFilesEvidenceSnapshot {
  source: 'desktop-main-files-singleton-v1';
  route: FilesRouteEvidenceSnapshot | null;
  counters: ReturnType<typeof snapshotFilesWorkCounters>;
}

export function snapshotDesktopFilesEvidence(
  after?: ReadEvidenceCursor,
): DesktopFilesEvidenceSnapshot {
  return {
    source: 'desktop-main-files-singleton-v1',
    route: route?.observe(after) ?? null,
    counters: snapshotFilesWorkCounters(),
  };
}

// First evaluation wins. Production evaluates this module once; Jest's global
// proxy retains every replaced value, and with it each reloaded app graph.
const EVIDENCE_GLOBAL = '__CANOPY_FILES_MAIN_EVIDENCE__';
if (!Object.getOwnPropertyDescriptor(globalThis, EVIDENCE_GLOBAL)) {
  Object.defineProperty(globalThis, EVIDENCE_GLOBAL, {
    value: Object.freeze({ snapshot: snapshotDesktopFilesEvidence }),
  });
}

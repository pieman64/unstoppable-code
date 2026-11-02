import type { ReadEvidenceCursor } from '@canopy/desktop-shared/lib/bounded-read-evidence';
import { snapshotFilesWorkCounters } from '@canopy/desktop-shared/node/work-counters';
import { BRAND } from '@canopy/brand/current';
import { getCanopyDataDir } from '@canopy/desktop-shared/canopy-paths';
import type { LabsExperimentsSnapshot } from '@canopy/desktop-shared/lib/labs-experiments';
import { getLabsExperimentsService } from '../services/labs-experiments-runtime';
import { resolveWorktreeTargetIds } from '../lib/resolve-worktree';
import { getWorkspaceType } from '../lib/workspace-registry';
import {
  createDaemonFilesRoute,
  type ObservedDaemonFilesRoute,
  type FilesRouteEvidenceSnapshot,
} from './daemon-files-route';
import {
  disposeElectronDaemonConnections,
  getElectronDaemonCallerLifetime,
  getElectronDaemonConnections,
  getElectronDaemonFilesContext,
} from './electron-daemon-access';

let route: ObservedDaemonFilesRoute | undefined;

/**
 * The production Files route, built on the first file-tree read. Building it
 * subscribes to authoritative Labs changes only; the daemon is contacted only for a read
 * the route selects.
 */
export function getDesktopDaemonFilesRoute(): ObservedDaemonFilesRoute {
  if (route) return route;
  const labs = getLabsExperimentsService();
  const projectEnabled = (snapshot: LabsExperimentsSnapshot): boolean =>
    snapshot.ready &&
    snapshot.experiments.some(
      (entry) => entry.id === 'daemon-files-reads' && entry.enabled,
    );
  // getSnapshot clones the whole registry; read eligibility needs only this bit.
  let enabled = projectEnabled(labs.getSnapshot());
  route = createDaemonFilesRoute({
    isFlagEnabled: (): boolean => enabled,
    onFlagChanged: (listener) =>
      labs.onSnapshotChanged((snapshot) => {
        enabled = projectEnabled(snapshot);
        listener();
      }),
    lifetime: getElectronDaemonCallerLifetime(),
    connections: getElectronDaemonConnections,
    hostContext: getElectronDaemonFilesContext,
    // `build-core-daemon.mjs` bakes the same name into the daemon.
    coworkManagedDirName: BRAND.storage.projectConfigDirNames[0],
    displayDataRoot: getCanopyDataDir,
    workspaceType: getWorkspaceType,
    resolveWorktreeTargetIds,
  });
  return route;
}

/** Quit: after the runtime drained, ends routed reads and daemon sessions. */
export async function disposeElectronDaemonFiles(): Promise<void> {
  route?.dispose();
  await disposeElectronDaemonConnections();
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

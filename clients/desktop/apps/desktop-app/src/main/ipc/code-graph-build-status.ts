import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { CodeGraphBuildStatusChangedEvent } from '@canopy/desktop-shared/types';
import {
  setCodeGraphBuildStatusListener,
  type CodeGraphBuildStatus,
} from '../code-graph/build-runner';
import { sendToWebContents } from '../lib/web-contents-send';

/**
 * Splits a `${projectId}/${worktreeId}` build-runner key into its parts.
 * Both ids are validated elsewhere against `/^[a-z0-9][a-z0-9-]*$/` (no
 * slashes), so the LAST `/` unambiguously separates them. Returns `null` for
 * a malformed key so a bad key can never broadcast a garbled event.
 */
function splitBuildKey(
  key: string,
): { projectId: string; worktreeId: string } | null {
  const separatorIndex = key.lastIndexOf('/');
  if (separatorIndex <= 0 || separatorIndex === key.length - 1) {
    return null;
  }
  return {
    projectId: key.slice(0, separatorIndex),
    worktreeId: key.slice(separatorIndex + 1),
  };
}

function broadcastCodeGraphBuildStatus(
  key: string,
  status: CodeGraphBuildStatus,
): void {
  const parts = splitBuildKey(key);
  if (parts === null) {
    return;
  }
  const event: CodeGraphBuildStatusChangedEvent = {
    projectId: parts.projectId,
    worktreeId: parts.worktreeId,
    status,
  };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      sendToWebContents(
        window.webContents,
        IPC_CHANNELS.codeGraphBuildStatusChanged,
        event,
      );
    }
  }
}

/**
 * Wire the code-graph build runner's status listener to broadcast a
 * `CodeGraphBuildStatusChangedEvent` to every renderer window, mirroring the
 * `featureFlagsSnapshotChanged` broadcast pattern
 * (`apps/desktop-app/src/main/ipc/feature-flags.ts`). Both worktree-create
 * scheduler builds and agent-invoked `BuildOrUpdateCodeGraph` builds route
 * through the single `runCodeGraphWorkerBuild` chokepoint, so wiring the
 * listener here covers both triggers. Call once during IPC handler
 * registration.
 */
export function registerCodeGraphBuildStatusBroadcast(): void {
  setCodeGraphBuildStatusListener(broadcastCodeGraphBuildStatus);
}

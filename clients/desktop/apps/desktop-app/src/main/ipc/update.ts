import { app } from 'electron';
import {
  IPC_CHANNELS,
  type DependencyVersions,
  type TargetUpdateRequest,
  type TargetUpdateVersionListRequest,
  type UpdateState,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from './register';
import {
  cancelScheduledUpdate,
  checkForVersion,
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  installUpdate,
  listTargetUpdateVersions,
  reportRendererBusyState,
  scheduleUpdate,
} from '../updater';
import { getCanopyReleaseFlavor } from '../lib/app-identity';
import { getInternalReleaseIndicatorForDisplay } from '../lib/internal-release-version';
import { isE2eBuild } from '../lib/e2e-gate';

function supportsTargetedUpdates(): boolean {
  const releaseFlavor = getCanopyReleaseFlavor();
  return releaseFlavor === 'internal' || releaseFlavor === 'rc';
}

/**
 * Build-time dependency versions injected by electron.vite.config.ts `define`.
 * These are resolved at compile time from package.json so the packaged app
 * does not need runtime access to that file.
 */
const DEPENDENCY_VERSIONS: DependencyVersions = {
  claudeCli: __DEP_CLAUDE_CLI__,
  claudeSdk: __DEP_CLAUDE_SDK__,
  codexCli: __DEP_CODEX_CLI__,
  ghCli: __DEP_GH_CLI__,
  rtkCli: __DEP_RTK_CLI__,
  octokit: __DEP_OCTOKIT__,
};

export function registerUpdateHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.updateCheck, () => checkForUpdates());
  if (supportsTargetedUpdates()) {
    registerIpcHandler(
      IPC_CHANNELS.updateCheckVersion,
      (_event, request: TargetUpdateRequest) => checkForVersion(request),
    );
    registerIpcHandler(
      IPC_CHANNELS.updateListVersions,
      (_event, request?: TargetUpdateVersionListRequest) =>
        listTargetUpdateVersions(request),
    );
  }
  registerIpcHandler(IPC_CHANNELS.updateDownload, () => downloadUpdate());
  registerIpcHandler(IPC_CHANNELS.updateInstall, () => installUpdate());
  registerIpcHandler(IPC_CHANNELS.updateSchedule, () => scheduleUpdate());
  registerIpcHandler(IPC_CHANNELS.updateCancelScheduled, () =>
    cancelScheduledUpdate(),
  );
  registerIpcHandler(
    IPC_CHANNELS.updateReportBusy,
    (_event, busy: boolean): void => {
      reportRendererBusyState(busy);
    },
  );
  registerIpcHandler(IPC_CHANNELS.updateGetVersion, (): string => {
    if (isE2eBuild()) {
      const override = process.env.CANOPY_E2E_APP_VERSION?.trim();
      if (override) return override;
    }
    return getCanopyReleaseFlavor() === 'internal'
      ? getInternalReleaseIndicatorForDisplay(app.getVersion())
      : app.getVersion();
  });
  registerIpcHandler(
    IPC_CHANNELS.updateGetDependencyVersions,
    (): DependencyVersions => DEPENDENCY_VERSIONS,
  );
  registerIpcHandler(
    IPC_CHANNELS.updateGetState,
    (): UpdateState => getUpdateState(),
  );
}

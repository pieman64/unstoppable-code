import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';
import { showRemoteOpenDialogForEvent } from '../lib/dialog-window';
import {
  IPC_CHANNELS,
  type GitExecutableInstallProgress,
} from '@canopy/desktop-shared/types';
import type { WorkerGitDispatcher } from '../canopy-runtime/worker-git-adapter';
import { getGitExecutableStatus } from '../canopy-runtime/worker-git-dispatch';
import type { DesktopIpcCallerResolver } from './file-tree';
import {
  detectGitExecutable,
  detectWinget,
  getGitExecutablePlatformStatus,
  installGitWithWinget,
  installGitWithXcode,
  setCachedGitExecutablePath,
  validateGitExecutable,
} from '../lib/git-executable';
import { registerIpcHandler } from './register';
import { sendToWebContents } from '../lib/web-contents-send';

function sendInstallProgress(
  getWindow: () => BrowserWindow | null,
  progress: GitExecutableInstallProgress,
): void {
  const win = getWindow();
  if (!win || win.isDestroyed()) {
    return;
  }
  sendToWebContents(
    win.webContents,
    IPC_CHANNELS.gitExecutableInstallProgress,
    progress,
  );
}

export function registerGitExecutableHandlers(
  getWindow: () => BrowserWindow | null,
  runtime: {
    dispatcher: WorkerGitDispatcher;
    resolveCaller: DesktopIpcCallerResolver;
  },
): void {
  // worker.git.executable.get; Browse, the installers and spawn-time
  // resolution keep the direct detection (CAN-5137).
  registerIpcHandler(IPC_CHANNELS.gitExecutableStatus, async (event) =>
    getGitExecutableStatus(runtime.dispatcher, runtime.resolveCaller(event), {
      recheck: false,
    }),
  );

  registerIpcHandler(IPC_CHANNELS.gitExecutableRedetect, async (event) =>
    getGitExecutableStatus(runtime.dispatcher, runtime.resolveCaller(event), {
      recheck: true,
    }),
  );

  registerIpcHandler(IPC_CHANNELS.gitExecutableBrowse, async (event) => {
    const win = getWindow();
    const options: OpenDialogOptions = {
      properties: ['openFile'],
      filters:
        hostPlatformOperatingSystem() === 'win32'
          ? [{ name: 'Git executable', extensions: ['exe'] }]
          : undefined,
    };
    const result =
      (await showRemoteOpenDialogForEvent(event, options)) ??
      (win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options));
    if (result.canceled || result.filePaths.length === 0) {
      return detectGitExecutable();
    }
    const selected = result.filePaths[0];
    const winget = await detectWinget();
    try {
      const validated = await validateGitExecutable(selected);
      await setCachedGitExecutablePath(validated.path);
      return {
        ...getGitExecutablePlatformStatus(),
        ready: true,
        path: validated.path,
        version: validated.version,
        source: 'browse' as const,
        wingetAvailable: winget.available,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        ...getGitExecutablePlatformStatus(),
        ready: false,
        path: null,
        version: null,
        source: 'not-found' as const,
        wingetAvailable: winget.available,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  registerIpcHandler(IPC_CHANNELS.gitExecutableInstallXcode, () =>
    installGitWithXcode(),
  );

  registerIpcHandler(IPC_CHANNELS.gitExecutableInstallWinget, () =>
    installGitWithWinget((progress) =>
      sendInstallProgress(getWindow, progress),
    ),
  );
}

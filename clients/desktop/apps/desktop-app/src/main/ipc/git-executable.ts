import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';
import { showRemoteOpenDialogForEvent } from '../lib/dialog-window';
import {
  IPC_CHANNELS,
  type GitExecutableInstallProgress,
} from '@canopy/desktop-shared/types';
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
): void {
  registerIpcHandler(IPC_CHANNELS.gitExecutableStatus, () =>
    detectGitExecutable(),
  );

  registerIpcHandler(IPC_CHANNELS.gitExecutableRedetect, () =>
    detectGitExecutable({ force: true }),
  );

  registerIpcHandler(IPC_CHANNELS.gitExecutableBrowse, async (event) => {
    const win = getWindow();
    const options: OpenDialogOptions = {
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
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

import { BrowserWindow } from 'electron';
import { rm } from 'node:fs/promises';
import {
  IPC_CHANNELS,
  type CloneJobSnapshot,
} from '@canopy/desktop-shared/types';
import { CloneJobRegistry } from './clone-jobs';
import { sendToWebContents } from '../lib/web-contents-send';

let registry: CloneJobRegistry | undefined;

function broadcast(jobs: CloneJobSnapshot[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed())
      sendToWebContents(
        window.webContents,
        IPC_CHANNELS.cloneJobsChanged,
        jobs,
      );
  }
}

export function getCloneJobs(): CloneJobRegistry {
  registry ??= new CloneJobRegistry({
    changed: broadcast,
    removeDirectory: (path): Promise<void> =>
      rm(path, { recursive: true, force: true, maxRetries: 3 }),
    now: Date.now,
  });
  return registry;
}

/** Stop in-flight clones and remove their partial checkouts before quit. */
export async function shutdownCloneJobs(): Promise<void> {
  await registry?.shutdown();
}

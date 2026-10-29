import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { DesktopSessionSnapshotArgs } from '@canopy/desktop-shared/types';
import { subscribeChatSessionActivity } from '../agents/session-manager';
import { buildDesktopSessionSnapshot } from '../services/desktop-session-snapshot-service';
import {
  scheduleDesktopSessionSnapshotInvalidation,
  subscribeDesktopSessionSnapshotInvalidation,
} from '../services/desktop-session-snapshot-invalidation';
import { registerIpcHandler } from './register';
import { sendToWebContents } from '../lib/web-contents-send';

let unsubscribeDesktopSessionSnapshotInvalidation: (() => void) | null = null;
let unsubscribeChatSessionActivity: (() => void) | null = null;

export function disposeDesktopSessionSnapshotHandlers(): void {
  unsubscribeDesktopSessionSnapshotInvalidation?.();
  unsubscribeDesktopSessionSnapshotInvalidation = null;
  unsubscribeChatSessionActivity?.();
  unsubscribeChatSessionActivity = null;
}

export function registerDesktopSessionSnapshotHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  registerIpcHandler(
    IPC_CHANNELS.desktopSessionSnapshot,
    (_event, args?: DesktopSessionSnapshotArgs) =>
      buildDesktopSessionSnapshot(args),
  );
  registerIpcHandler(
    IPC_CHANNELS.desktopSessionSnapshotInvalidate,
    (): void => {
      scheduleDesktopSessionSnapshotInvalidation();
    },
  );
  unsubscribeDesktopSessionSnapshotInvalidation?.();
  unsubscribeDesktopSessionSnapshotInvalidation =
    subscribeDesktopSessionSnapshotInvalidation((): void => {
      const window = getWindow();
      if (window && !window.isDestroyed()) {
        sendToWebContents(
          window.webContents,
          IPC_CHANNELS.desktopSessionSnapshotStale,
        );
      }
    });
  // The snapshot projects each worktree's `isStreaming` from live chat
  // sessions, and the shared sidebar gates Archive and Delete on it. The
  // runtime-status service stales the snapshot on session activity only while
  // a portal session runs, so without one a snapshot rebuilt mid-turn by an
  // unrelated write kept the row working, and those actions disabled, after
  // the turn ended. Session lifecycle changes (register, turn start/end,
  // queue, unregister) are discrete and the invalidation is throttled.
  unsubscribeChatSessionActivity?.();
  unsubscribeChatSessionActivity = subscribeChatSessionActivity((): void => {
    scheduleDesktopSessionSnapshotInvalidation();
  });
}

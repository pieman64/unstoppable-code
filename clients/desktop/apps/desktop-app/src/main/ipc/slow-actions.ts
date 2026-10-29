import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type SlowActionEvent,
  type SlowActionSnapshot,
} from '@canopy/desktop-shared/types';
import { sendToWindow } from '../lib/window-send';
import {
  clearSlowActions,
  getSlowActionSnapshot,
  subscribeSlowActions,
} from '../lib/slow-action-tracker';
import { registerIpcHandler } from './register';

let unsubscribeSlowActionBroadcast: (() => void) | null = null;

export function registerSlowActionHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  unsubscribeSlowActionBroadcast?.();
  unsubscribeSlowActionBroadcast = subscribeSlowActions(
    (event: SlowActionEvent) => {
      sendToWindow(getWindow(), IPC_CHANNELS.slowActionEvent, event);
    },
  );

  registerIpcHandler<[], SlowActionSnapshot>(
    IPC_CHANNELS.slowActionSnapshot,
    (): SlowActionSnapshot => getSlowActionSnapshot(),
  );

  registerIpcHandler<[], void>(IPC_CHANNELS.slowActionClear, (): void => {
    clearSlowActions();
  });
}

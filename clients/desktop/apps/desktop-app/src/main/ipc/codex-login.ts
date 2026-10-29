import type { BrowserWindow, WebContents } from 'electron';
import {
  IPC_CHANNELS,
  type CodexLoginStartRequest,
  type CodexLoginState,
} from '@canopy/desktop-shared/types';
import { codexLoginManager } from '../auth/codex-login';
import { sendToWindow } from '../lib/window-send';
import { openExternalGuarded } from '../lib/open-external';
import { registerIpcHandler } from './register';

export function registerCodexLoginHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  const observedSenders = new WeakSet<WebContents>();
  let attemptOwner: WebContents | null = null;
  const requireAttemptOwner = (sender: WebContents): void => {
    if (sender !== attemptOwner || sender !== getWindow()?.webContents)
      throw new Error(
        'Codex sign-in command requires the owning desktop window.',
      );
  };
  codexLoginManager.onState((state) => {
    if (state.phase === 'complete') attemptOwner = null;
    sendToWindow(getWindow(), IPC_CHANNELS.codexLoginState, state);
  });
  registerIpcHandler<[CodexLoginStartRequest], CodexLoginState>(
    IPC_CHANNELS.codexLoginStart,
    (event, request) => {
      if (
        !request ||
        typeof request.confirmPause !== 'boolean' ||
        (request.method !== 'chatgpt' && request.method !== 'chatgptDeviceCode')
      )
        throw new Error('Invalid Codex sign-in request.');
      if (event.sender !== getWindow()?.webContents)
        throw new Error('Codex sign-in requires the desktop window.');
      if (attemptOwner && attemptOwner !== event.sender)
        throw new Error(
          'Codex sign-in command requires the owning desktop window.',
        );
      if (!observedSenders.has(event.sender)) {
        observedSenders.add(event.sender);
        event.sender.once('destroyed', () => {
          if (attemptOwner === event.sender) attemptOwner = null;
          void codexLoginManager.finish('cancelled');
        });
      }
      const state = codexLoginManager.start(request);
      if (state.attemptId) attemptOwner = event.sender;
      return state;
    },
  );
  registerIpcHandler<[], CodexLoginState>(
    IPC_CHANNELS.codexLoginCancel,
    async (event) => {
      requireAttemptOwner(event.sender);
      return codexLoginManager.finish('cancelled');
    },
  );
  registerIpcHandler<[], CodexLoginState>(
    IPC_CHANNELS.codexLoginRetryVerification,
    async (event) => {
      requireAttemptOwner(event.sender);
      return codexLoginManager.retryVerification();
    },
  );
  registerIpcHandler<[], void>(
    IPC_CHANNELS.codexLoginOpenBrowser,
    async (event) => {
      requireAttemptOwner(event.sender);
      const url = codexLoginManager.browserUrl();
      // Fixture sign-ins must never open an OS browser or read a live account.
      if (__CANOPY_E2E__) return;
      await openExternalGuarded(url);
    },
  );
}

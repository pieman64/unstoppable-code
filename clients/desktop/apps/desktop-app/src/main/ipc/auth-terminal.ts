import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type AuthTerminalResizeRequest,
  type AuthTerminalStartRequest,
  type AuthTerminalStartResponse,
  type AuthTerminalStopRequest,
  type AuthTerminalWriteRequest,
  type AuthTerminalProvider,
} from '@canopy/desktop-shared/types';
import { sendToWindow } from '../lib/window-send';
import { getAuthTerminalManager } from '../auth-terminal/manager';
import { registerIpcHandler } from './register';
import type { ManagedOpenCodeRuntime } from '../opencode/connection';
import {
  checkClaudeAuthStatusObserved,
  checkCodexAuthStatusObserved,
} from '../auth/provider-auth-state';

async function refreshProviderAfterAuthTerminalExit(
  provider: AuthTerminalProvider,
  exitCode: number | null,
): Promise<void> {
  if (provider === 'opencode') {
    if (exitCode === 0)
      await (await import('../opencode/connection')).revokeOpenCodeRuntimes();
    return;
  }
  if (provider === 'claude') {
    await checkClaudeAuthStatusObserved('auth-terminal-exit', {
      forceAuthenticatedInvalidation: exitCode === 0,
    });
    return;
  }
  if (provider === 'codex') {
    await checkCodexAuthStatusObserved('auth-terminal-exit', {
      forceAuthenticatedInvalidation: exitCode === 0,
      prepareExplicitTransitionBeforeProbe: exitCode === 0,
    });
  }
}

export function registerAuthTerminalHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  const manager = getAuthTerminalManager();
  const openCodeSessions = new Map<string, () => Promise<void>>();
  manager.setEventSender((channel, payload): void => {
    if (channel === IPC_CHANNELS.authTerminalExit && 'provider' in payload) {
      if (payload.provider === 'opencode') {
        const release = openCodeSessions.get(payload.sessionId);
        // Release this lease before successful-auth revocation, which waits
        // for all registered runtimes (including this login) to finish.
        void (async (): Promise<void> => {
          await release?.();
          await refreshProviderAfterAuthTerminalExit(
            payload.provider,
            payload.exitCode,
          );
        })()
          .catch(() => undefined)
          .finally(() => sendToWindow(getWindow(), channel, payload));
        return;
      }
      if (payload.exitCode !== 0 || payload.provider !== 'codex') {
        sendToWindow(getWindow(), channel, payload);
        void refreshProviderAfterAuthTerminalExit(
          payload.provider,
          payload.exitCode,
        ).catch(() => undefined);
        return;
      }
      // Hold the renderer exit event until provider state has crossed the auth
      // boundary. AuthLoginModal immediately refreshes Usage and may open the
      // interrupted-session prompt when this event arrives.
      void refreshProviderAfterAuthTerminalExit(
        payload.provider,
        payload.exitCode,
      )
        .catch(() => undefined)
        .finally(() => sendToWindow(getWindow(), channel, payload));
      return;
    }
    sendToWindow(getWindow(), channel, payload);
  });

  registerIpcHandler<[AuthTerminalStartRequest], AuthTerminalStartResponse>(
    IPC_CHANNELS.authTerminalStart,
    async (_event, request): Promise<AuthTerminalStartResponse> => {
      const provider: unknown = request.provider;
      if (provider === 'codex')
        throw new Error('Use the managed Codex sign-in flow.');
      if (
        provider !== 'claude' &&
        provider !== 'codex' &&
        provider !== 'github' &&
        provider !== 'opencode'
      ) {
        throw new Error(`Invalid auth-terminal provider: ${String(provider)}`);
      }
      if (provider === 'opencode') {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60_000);
        const runtime = await (async (): Promise<ManagedOpenCodeRuntime> => {
          try {
            return await (
              await import('../opencode/connection')
            ).openManagedOpenCodeRuntime({
              signal: controller.signal,
              requireEnabled: false,
            });
          } finally {
            // Verification is bounded; interactive sign-in has no deadline.
            clearTimeout(timeout);
          }
        })();
        try {
          runtime.signal.throwIfAborted();
          const sessionId = manager.start(
            provider,
            request.cols,
            request.rows,
            runtime.executable,
          );
          const stop = (): void => manager.stop(sessionId);
          const release = (): Promise<void> => {
            openCodeSessions.delete(sessionId);
            runtime.signal.removeEventListener('abort', stop);
            return runtime.close();
          };
          openCodeSessions.set(sessionId, release);
          runtime.signal.addEventListener('abort', stop, { once: true });
          if (manager.getActiveSessionId() !== sessionId) await release();
          else if (runtime.signal.aborted) stop();
          return { sessionId };
        } catch (error) {
          await runtime.close();
          throw error;
        }
      }
      const sessionId = manager.start(
        request.provider,
        request.cols,
        request.rows,
      );
      return { sessionId };
    },
  );

  registerIpcHandler<[AuthTerminalWriteRequest], void>(
    IPC_CHANNELS.authTerminalWrite,
    (_event, request): void => {
      manager.write(request.sessionId, request.data);
    },
  );

  registerIpcHandler<[AuthTerminalResizeRequest], void>(
    IPC_CHANNELS.authTerminalResize,
    (_event, request): void => {
      manager.resize(request.sessionId, request.cols, request.rows);
    },
  );

  registerIpcHandler<[AuthTerminalStopRequest], void>(
    IPC_CHANNELS.authTerminalStop,
    (_event, request): void => {
      manager.stop(request.sessionId);
    },
  );
}

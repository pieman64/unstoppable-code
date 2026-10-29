import {
  isCursorHarnessEnabled,
  assertCursorHarnessEnabled,
} from '../cursor/feature-flag';
import { app, BrowserWindow, type WebContents } from 'electron';
import {
  IPC_CHANNELS,
  type CursorApprovalCheckResult,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from './register';

const active = new Map<
  number,
  { controller: AbortController; done: Promise<CursorApprovalCheckResult> }
>();

export async function shutdownCursorApprovalChecks(): Promise<void> {
  const runs = Array.from(active.values());
  for (const run of runs) run.controller.abort();
  await Promise.allSettled(runs.map((run) => run.done));
}

/** Local developer surface only. It does not register a general chat harness. */
export function registerCursorApprovalCheckHandlers(): void {
  const available = (): boolean =>
    isCursorHarnessEnabled() &&
    !app.isPackaged &&
    process.platform === 'darwin';
  const cancel = async (sender: WebContents): Promise<void> => {
    const run = active.get(sender.id);
    run?.controller.abort();
    // Run owns error reporting; Stop only waits for its teardown to settle.
    await run?.done.catch(() => {});
  };
  registerIpcHandler<[], boolean>(
    IPC_CHANNELS.cursorApprovalCheckAvailable,
    available,
  );
  registerIpcHandler<[string], CursorApprovalCheckResult>(
    IPC_CHANNELS.cursorApprovalCheckRun,
    async (event, binaryPath) => {
      assertCursorHarnessEnabled();
      if (!available())
        throw new Error(
          'Cursor approval checks are available in local macOS builds only.',
        );
      if (
        typeof binaryPath !== 'string' ||
        binaryPath.length > 4096 ||
        binaryPath.includes('\0')
      )
        throw new Error('Invalid executable path.');
      const owner = event.sender;
      const win = BrowserWindow.fromWebContents(owner);
      if (!win || event.senderFrame !== owner.mainFrame)
        throw new Error('Check window unavailable.');
      if (active.has(owner.id))
        throw new Error('A Cursor check is already running.');
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      owner.once('destroyed', stop);
      owner.once('render-process-gone', stop);
      owner.once('did-start-navigation', stop);
      const done = (async (): Promise<CursorApprovalCheckResult> => {
        // Keep the SDK and child-process code off the normal startup path.
        const { runCursorApprovalCheck } =
          await import('../cursor/approval-check');
        assertCursorHarnessEnabled();
        return runCursorApprovalCheck({
          binaryPath,
          signal: controller.signal,
          getWindow: () => (win.isDestroyed() ? null : win),
        });
      })();
      active.set(owner.id, { controller, done });
      try {
        return await done;
      } finally {
        active.delete(owner.id);
        owner.off('destroyed', stop);
        owner.off('render-process-gone', stop);
        owner.off('did-start-navigation', stop);
      }
    },
  );
  registerIpcHandler<[], void>(
    IPC_CHANNELS.cursorApprovalCheckCancel,
    (event) => cancel(event.sender),
  );
}

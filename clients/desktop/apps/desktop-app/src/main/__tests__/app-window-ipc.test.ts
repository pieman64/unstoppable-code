const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
const mockRelaunch = jest.fn();
const mockQuit = jest.fn();
const mockIs = { dev: false };

jest.mock('electron', () => ({
  app: {
    get relaunch(): typeof mockRelaunch {
      return mockRelaunch;
    },
    get quit(): typeof mockQuit {
      return mockQuit;
    },
  },
  ipcMain: {
    removeHandler: jest.fn((channel: string) => {
      registeredHandlers.delete(channel);
    }),
    handle: jest.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        registeredHandlers.set(channel, handler);
      },
    ),
  },
}));

jest.mock('@electron-toolkit/utils', () => ({
  get is(): typeof mockIs {
    return mockIs;
  },
}));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { registerAppWindowHandlers } from '../ipc/app-window';
import { createUnsavedCloseGuard } from '../lifecycle/unsaved-close-guard';

describe('registerAppWindowHandlers', () => {
  const onStartupUnlocked = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    registeredHandlers.clear();
    mockRelaunch.mockClear();
    mockQuit.mockClear();
    onStartupUnlocked.mockClear();
    mockIs.dev = false;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('schedules a hard reload for the invoking webContents', async () => {
    registerAppWindowHandlers(onStartupUnlocked);
    const reloadIgnoringCache = jest.fn();
    const sender = {
      isDestroyed: jest.fn(() => false),
      reloadIgnoringCache,
    };

    const handler = registeredHandlers.get(IPC_CHANNELS.appWindowReload);
    await expect(handler?.({ sender })).resolves.toBe(true);

    expect(reloadIgnoringCache).not.toHaveBeenCalled();
    jest.runOnlyPendingTimers();
    expect(reloadIgnoringCache).toHaveBeenCalledTimes(1);
  });

  test('schedules an app relaunch and quit for restart requests', async () => {
    registerAppWindowHandlers(onStartupUnlocked);

    const handler = registeredHandlers.get(IPC_CHANNELS.appWindowRestart);
    await expect(handler?.({})).resolves.toBe(true);

    expect(mockRelaunch).not.toHaveBeenCalled();
    expect(mockQuit).not.toHaveBeenCalled();

    jest.runOnlyPendingTimers();

    expect(mockRelaunch).toHaveBeenCalledTimes(1);
    expect(mockQuit).toHaveBeenCalledTimes(1);
  });

  test('does not relaunch under the electron-vite dev wrapper', async () => {
    mockIs.dev = true;
    registerAppWindowHandlers(onStartupUnlocked);

    const handler = registeredHandlers.get(IPC_CHANNELS.appWindowRestart);
    await expect(handler?.({})).resolves.toBe(false);

    jest.runOnlyPendingTimers();

    expect(mockRelaunch).not.toHaveBeenCalled();
    expect(mockQuit).not.toHaveBeenCalled();
  });

  test('notifies when startup is unlocked', async () => {
    registerAppWindowHandlers(onStartupUnlocked);

    const handler = registeredHandlers.get(IPC_CHANNELS.appStartupUnlocked);
    await expect(handler?.({})).resolves.toBeUndefined();

    expect(onStartupUnlocked).toHaveBeenCalledTimes(1);
  });

  describe('unsaved close guard', () => {
    const mainSender = { id: 1 };
    const otherSender = { id: 2 };

    function registerWithGuard(): {
      setDirty: jest.Mock;
      handleShown: jest.Mock;
      handleDecision: jest.Mock;
    } {
      const guard = {
        setDirty: jest.fn(),
        handleShown: jest.fn(),
        handleDecision: jest.fn(),
        isDirty: jest.fn(() => false),
      };
      registerAppWindowHandlers(onStartupUnlocked, {
        guard,
        isMainWindowSender: (sender) => sender === mainSender,
      });
      return guard;
    }

    test('records dirty state reported by the main window', async () => {
      const guard = registerWithGuard();
      const handler = registeredHandlers.get(
        IPC_CHANNELS.appWindowSetUnsavedChanges,
      );

      await handler?.({ sender: mainSender }, true);
      await handler?.({ sender: mainSender }, false);

      expect(guard.setDirty.mock.calls).toEqual([[true], [false]]);
    });

    test('ignores dirty reports from other windows or with a bad payload', async () => {
      const guard = registerWithGuard();
      const handler = registeredHandlers.get(
        IPC_CHANNELS.appWindowSetUnsavedChanges,
      );

      await handler?.({ sender: otherSender }, true);
      await handler?.({ sender: mainSender }, 'yes');

      expect(guard.setDirty).not.toHaveBeenCalled();
    });

    test('routes the two-step confirmation answer to the guard', async () => {
      const guard = registerWithGuard();
      const handler = registeredHandlers.get(
        IPC_CHANNELS.appWindowConfirmCloseResponse,
      );

      await handler?.(
        { sender: mainSender },
        { requestId: 'r1', kind: 'shown' },
      );
      await handler?.(
        { sender: mainSender },
        { requestId: 'r1', kind: 'decided', proceed: false },
      );

      expect(guard.handleShown).toHaveBeenCalledWith('r1');
      expect(guard.handleDecision).toHaveBeenCalledWith('r1', false);
    });

    test('drops malformed or foreign confirmation answers', async () => {
      const guard = registerWithGuard();
      const handler = registeredHandlers.get(
        IPC_CHANNELS.appWindowConfirmCloseResponse,
      );

      await handler?.(
        { sender: otherSender },
        { requestId: 'r1', kind: 'shown' },
      );
      await handler?.({ sender: mainSender }, { requestId: '', kind: 'shown' });
      await handler?.(
        { sender: mainSender },
        { requestId: 'r1', kind: 'decided' },
      );
      await handler?.({ sender: mainSender }, null);

      expect(guard.handleShown).not.toHaveBeenCalled();
      expect(guard.handleDecision).not.toHaveBeenCalled();
    });

    test('does not schedule a restart while workflow edits are unsaved', async () => {
      const guard = createUnsavedCloseGuard({
        revealWindow: jest.fn(),
        sendRequest: () => true,
      });
      registerAppWindowHandlers(onStartupUnlocked, {
        guard,
        isMainWindowSender: (sender) => sender === mainSender,
      });
      const restart = registeredHandlers.get(IPC_CHANNELS.appWindowRestart);

      // A relaunch queued for a quit the user then cancels would fire on
      // their next quit, so restart reports itself unavailable instead.
      guard.setDirty(true);
      await expect(restart?.({})).resolves.toBe(false);
      jest.runOnlyPendingTimers();
      expect(mockRelaunch).not.toHaveBeenCalled();
      expect(mockQuit).not.toHaveBeenCalled();

      guard.setDirty(false);
      await expect(restart?.({})).resolves.toBe(true);
      jest.runOnlyPendingTimers();
      expect(mockRelaunch).toHaveBeenCalledTimes(1);
      expect(mockQuit).toHaveBeenCalledTimes(1);
    });

    test('is inert without a guard', async () => {
      registerAppWindowHandlers(onStartupUnlocked);
      const handler = registeredHandlers.get(
        IPC_CHANNELS.appWindowSetUnsavedChanges,
      );

      await expect(
        handler?.({ sender: mainSender }, true),
      ).resolves.toBeUndefined();
    });
  });
});

import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContents } from 'electron';
import {
  IPC_CHANNELS,
  type CodexLoginState,
} from '@canopy/desktop-shared/types';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const mockFinish = jest.fn();
const mockRetryVerification = jest.fn();
const mockBrowserUrl = jest.fn(() => 'https://auth.openai.com/codex/device');
const mockOpenExternal = jest.fn();
const mockOnState = jest.fn();
const mockStart = jest.fn<
  CodexLoginState,
  [{ method: 'chatgpt'; confirmPause: boolean }]
>(() => ({
  attemptId: 'attempt-1',
  phase: 'waiting',
  activeWorkCount: 1,
  method: 'chatgpt',
}));

function createBrowserWindowIdentityDouble(): BrowserWindow {
  // This test checks sender identity only; Electron window behavior is unused.
  const webContents = new EventEmitter() as WebContents;
  return { webContents } as BrowserWindow;
}

jest.mock('electron', () => ({
  shell: {
    get openExternal(): typeof mockOpenExternal {
      return mockOpenExternal;
    },
  },
}));
jest.mock('../auth/codex-login', () => ({
  codexLoginManager: {
    get onState(): typeof mockOnState {
      return mockOnState;
    },
    get start(): typeof mockStart {
      return mockStart;
    },
    get finish(): typeof mockFinish {
      return mockFinish;
    },
    get retryVerification(): typeof mockRetryVerification {
      return mockRetryVerification;
    },
    get browserUrl(): typeof mockBrowserUrl {
      return mockBrowserUrl;
    },
  },
}));
jest.mock('../lib/window-send', () => ({ sendToWindow: jest.fn() }));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ): void => {
    handlers.set(channel, handler);
  },
}));

import { registerCodexLoginHandlers } from '../ipc/codex-login';

describe('registerCodexLoginHandlers', () => {
  beforeEach(() => {
    handlers.clear();
    jest.clearAllMocks();
    mockFinish.mockResolvedValue({
      attemptId: 'attempt-1',
      phase: 'complete',
      activeWorkCount: 1,
      outcome: 'cancelled',
    });
    mockRetryVerification.mockResolvedValue({
      attemptId: 'attempt-1',
      phase: 'waiting',
      activeWorkCount: 1,
    });
  });

  it('rejects follow-up login commands from a renderer that does not own the attempt', async () => {
    const ownerWindow = createBrowserWindowIdentityDouble();
    const otherWindow = createBrowserWindowIdentityDouble();
    const owner = ownerWindow.webContents;
    const other = otherWindow.webContents;
    registerCodexLoginHandlers(() => ownerWindow);
    const start = handlers.get(IPC_CHANNELS.codexLoginStart);
    const cancel = handlers.get(IPC_CHANNELS.codexLoginCancel);
    const retry = handlers.get(IPC_CHANNELS.codexLoginRetryVerification);
    const openBrowser = handlers.get(IPC_CHANNELS.codexLoginOpenBrowser);
    if (!start || !cancel || !retry || !openBrowser)
      throw new Error('Codex login handlers were not registered');

    await start({ sender: owner }, { method: 'chatgpt', confirmPause: true });

    await expect(cancel({ sender: other })).rejects.toThrow(
      'owning desktop window',
    );
    await expect(retry({ sender: other })).rejects.toThrow(
      'owning desktop window',
    );
    await expect(openBrowser({ sender: other })).rejects.toThrow(
      'owning desktop window',
    );
    expect(mockFinish).not.toHaveBeenCalled();
    expect(mockRetryVerification).not.toHaveBeenCalled();
    expect(mockOpenExternal).not.toHaveBeenCalled();

    await cancel({ sender: owner });
    expect(mockFinish).toHaveBeenCalledWith('cancelled');
  });
});

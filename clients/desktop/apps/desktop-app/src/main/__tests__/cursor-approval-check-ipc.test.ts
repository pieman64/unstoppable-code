const mockCursorFlagEnabled = jest.fn(() => true);
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: mockCursorFlagEnabled,
  }),
}));
import { EventEmitter } from 'node:events';
import {
  IPC_CHANNELS,
  type CursorApprovalCheckResult,
} from '@canopy/desktop-shared/types';
import { registerCursorApprovalCheckHandlers } from '../ipc/cursor-approval-check';
import { runCursorApprovalCheck } from '../cursor/approval-check';

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: {
    fromWebContents: (): { isDestroyed: () => boolean } => ({
      isDestroyed: (): boolean => false,
    }),
  },
}));
const mockSender = Object.assign(new EventEmitter(), {
  id: 142,
  mainFrame: {},
});
const mockEvent = { sender: mockSender, senderFrame: mockSender.mainFrame };
type TestHandler = (event: typeof mockEvent, ...args: unknown[]) => unknown;
const mockHandlers = new Map<string, TestHandler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: TestHandler): void => {
    mockHandlers.set(channel, handler);
  },
}));
jest.mock('../cursor/approval-check', () => ({
  runCursorApprovalCheck: jest.fn(),
}));

test('cancel waits for cleanup without repeating an error already delivered to Run', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!platform) throw new Error('Missing platform descriptor');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  try {
    registerCursorApprovalCheckHandlers();
    const handler = (channel: string): TestHandler => {
      const registered = mockHandlers.get(channel);
      if (!registered) throw new Error(`Missing ${channel}`);
      return registered;
    };
    const event = mockEvent;
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    jest.mocked(runCursorApprovalCheck).mockImplementation(
      ({ signal }) =>
        new Promise<CursorApprovalCheckResult>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('Cleanup failed')),
            { once: true },
          );
          started();
        }),
    );
    const running = handler(IPC_CHANNELS.cursorApprovalCheckRun)(
      event,
      '/fixture/cursor',
    );
    const failure = expect(running).rejects.toThrow('Cleanup failed');
    await ready;
    await expect(
      handler(IPC_CHANNELS.cursorApprovalCheckCancel)(event),
    ).resolves.toBeUndefined();
    await failure;
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('flag off hides approval diagnostics and refuses direct runs', async () => {
  registerCursorApprovalCheckHandlers();
  mockCursorFlagEnabled.mockReturnValue(false);
  jest.mocked(runCursorApprovalCheck).mockClear();
  try {
    const available = mockHandlers.get(
      IPC_CHANNELS.cursorApprovalCheckAvailable,
    );
    const run = mockHandlers.get(IPC_CHANNELS.cursorApprovalCheckRun);
    if (!available || !run) throw new Error('Missing handlers');
    expect(available(mockEvent)).toBe(false);
    await expect(run(mockEvent, '/fixture/cursor')).rejects.toThrow(
      'This Cursor model is unavailable. Choose another Cursor model and try again.',
    );
    expect(runCursorApprovalCheck).not.toHaveBeenCalled();
  } finally {
    mockCursorFlagEnabled.mockReturnValue(true);
  }
});

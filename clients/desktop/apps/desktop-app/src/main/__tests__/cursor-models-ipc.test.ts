import { CursorModelAuthenticationError } from '../cursor/model-discovery-error';
const mockCursorFlagEnabled = jest.fn(() => true);
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: mockCursorFlagEnabled,
  }),
}));
import { EventEmitter } from 'node:events';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  registerCursorConnectionHandlers,
  shutdownCursorConnections,
} from '../ipc/cursor-connection';
import { listCursorModels, invalidateCursorModels } from '../cursor/models';
import { changeCursorAccount } from '../cursor/connection';
import { broadcastModelRegistryUpdated } from '../models/model-registry';
import {
  getCursorModelEntries,
  initCursorModels,
} from '@canopy/desktop-shared/types';

jest.mock('../models/model-registry', () => ({
  broadcastModelRegistryUpdated: jest.fn(),
}));

jest.mock('electron', () => ({
  BrowserWindow: { fromWebContents: (): object => ({}) },
}));
const mockSender = Object.assign(new EventEmitter(), {
  id: 142,
  mainFrame: {},
  isDestroyed: (): boolean => false,
});
const mockEvent = { sender: mockSender, senderFrame: mockSender.mainFrame };
type TestHandler = (event: typeof mockEvent, ...args: unknown[]) => unknown;
const mockHandlers = new Map<string, TestHandler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: TestHandler): void => {
    mockHandlers.set(channel, handler);
  },
}));
jest.mock('../cursor/connection', () => ({
  disconnectCursor: jest.fn(() => Promise.resolve()),
  changeCursorAccount: jest.fn(() =>
    Promise.resolve({
      enabled: true,
      installed: true,
      supported: true,
      phase: 'connected',
    }),
  ),
  connectCursor: jest.fn(() =>
    Promise.resolve({
      enabled: true,
      installed: true,
      supported: true,
      phase: 'connected',
    }),
  ),
}));
jest.mock('../cursor/models', () => ({
  listCursorModels: jest.fn(() => Promise.resolve([])),
  invalidateCursorModels: jest.fn(() => Promise.resolve()),
}));

test('disconnect invalidates startup discovery before any picker registered a callback', async () => {
  registerCursorConnectionHandlers();
  // Startup bypasses the list-model IPC handler and fills the same cache.
  await listCursorModels();
  jest.mocked(invalidateCursorModels).mockClear();
  const disconnect = mockHandlers.get(IPC_CHANNELS.cursorConnectionDisconnect);
  if (!disconnect) throw new Error('Missing disconnect handler');
  try {
    await disconnect(mockEvent);
    expect(invalidateCursorModels).toHaveBeenCalledTimes(1);
  } finally {
    jest.mocked(listCursorModels).mockClear();
    jest.mocked(broadcastModelRegistryUpdated).mockClear();
  }
});

test.each([
  IPC_CHANNELS.cursorConnectionModels,
  IPC_CHANNELS.cursorConnectionConnect,
  IPC_CHANNELS.cursorConnectionChangeAccount,
  IPC_CHANNELS.cursorConnectionAccount,
])('flag off rejects %s before lazy runtime work', async (channel) => {
  registerCursorConnectionHandlers();
  mockCursorFlagEnabled.mockReturnValue(false);
  try {
    const handler = mockHandlers.get(channel);
    if (!handler) throw new Error('Missing handler');
    await expect(handler(mockEvent)).rejects.toThrow(
      'This Cursor model is unavailable. Choose another Cursor model and try again.',
    );
    expect(listCursorModels).not.toHaveBeenCalled();
    expect(mockSender.listenerCount('destroyed')).toBe(0);
  } finally {
    mockCursorFlagEnabled.mockReturnValue(true);
  }
});

test('publishes successful discovery to the shared model registry', async () => {
  registerCursorConnectionHandlers();
  const handler = mockHandlers.get(IPC_CHANNELS.cursorConnectionModels);
  if (!handler) throw new Error('Missing model handler');
  const entries = [
    { id: 'cursor-default', rawModelId: 'default[]', label: 'Auto' },
  ];
  jest.mocked(listCursorModels).mockResolvedValueOnce(entries);
  await handler(mockEvent);
  expect(getCursorModelEntries()).toEqual(entries);
  expect(broadcastModelRegistryUpdated).toHaveBeenCalledTimes(1);
  initCursorModels([]);
  jest.mocked(listCursorModels).mockClear();
});

test('withdraws Cursor destinations after discovery fails', async () => {
  registerCursorConnectionHandlers();
  initCursorModels([
    { id: 'cursor:shared', rawModelId: 'shared', label: 'Shared' },
  ]);
  jest.mocked(broadcastModelRegistryUpdated).mockClear();
  jest
    .mocked(listCursorModels)
    .mockRejectedValueOnce(new CursorModelAuthenticationError());
  const handler = mockHandlers.get(IPC_CHANNELS.cursorConnectionModels);
  if (!handler) throw new Error('Missing model handler');
  await expect(handler(mockEvent)).rejects.toThrow('Reconnect Cursor');
  expect(getCursorModelEntries()).toEqual([]);
  expect(broadcastModelRegistryUpdated).toHaveBeenCalledTimes(1);
  jest.mocked(listCursorModels).mockClear();
});

test('retains the last successful catalog when a refresh fails transiently', async () => {
  registerCursorConnectionHandlers();
  const entries = [
    { id: 'cursor:shared', rawModelId: 'shared', label: 'Shared' },
  ];
  initCursorModels(entries);
  jest
    .mocked(listCursorModels)
    .mockRejectedValueOnce(new Error('Discovery timed out'));
  const handler = mockHandlers.get(IPC_CHANNELS.cursorConnectionModels);
  if (!handler) throw new Error('Missing model handler');
  try {
    await expect(handler(mockEvent)).rejects.toThrow('Discovery timed out');
    expect(getCursorModelEntries()).toEqual(entries);
  } finally {
    initCursorModels([]);
    jest.mocked(listCursorModels).mockClear();
  }
});

test('publishes models immediately after connecting without opening a picker', async () => {
  registerCursorConnectionHandlers();
  const handler = mockHandlers.get(IPC_CHANNELS.cursorConnectionConnect);
  if (!handler) throw new Error('Missing connect handler');
  const entries = [
    { id: 'cursor:shared', rawModelId: 'shared', label: 'Shared' },
  ];
  jest.mocked(listCursorModels).mockResolvedValueOnce(entries);
  await handler(mockEvent);
  expect(getCursorModelEntries()).toEqual(entries);
  initCursorModels([]);
  jest.mocked(listCursorModels).mockClear();
});

test('a second setup invoke in the same tick is refused, not silently adopted', async () => {
  // The single-flight guard is only atomic while nothing awaits between the
  // check and the claim. An await there let two invokes both pass, and the
  // second overwrote the first's abort handle — leaving a `logout`/`login`
  // run against the shared credential store with no cancel path.
  registerCursorConnectionHandlers();
  const connect = mockHandlers.get(IPC_CHANNELS.cursorConnectionConnect);
  if (!connect) throw new Error('Missing connect handler');
  const first = connect(mockEvent);
  const second = connect(mockEvent);
  await expect(second).rejects.toThrow('Cursor setup is already running.');
  await expect(first).resolves.toMatchObject({ phase: 'connected' });
  // The refusal must not have consumed the slot either.
  await expect(connect(mockEvent)).resolves.toMatchObject({
    phase: 'connected',
  });
  // Connecting republishes the catalog; the shutdown test that follows asserts
  // discovery never ran.
  jest.mocked(listCursorModels).mockClear();
  jest.mocked(broadcastModelRegistryUpdated).mockClear();
});

test('a refused probe leaves no listeners on the window', async () => {
  // The probe's guards run after a dynamic import, so attaching the window
  // listeners before them leaked three per refusal on a process-lifetime
  // WebContents. Refuse through the post-import flag re-check specifically:
  // the pre-import checks would not catch listeners reattached after it.
  registerCursorConnectionHandlers();
  const account = mockHandlers.get(IPC_CHANNELS.cursorConnectionAccount);
  if (!account) throw new Error('Missing account handler');
  mockCursorFlagEnabled.mockReturnValueOnce(true).mockReturnValueOnce(false);
  try {
    await expect(account(mockEvent)).rejects.toThrow(
      'This Cursor model is unavailable. Choose another Cursor model and try again.',
    );
    expect(mockSender.listenerCount('destroyed')).toBe(0);
    expect(mockSender.listenerCount('render-process-gone')).toBe(0);
    expect(mockSender.listenerCount('did-start-navigation')).toBe(0);
  } finally {
    mockCursorFlagEnabled.mockReturnValue(true);
  }
});

test('shutdown prevents a late lazy import from launching model discovery', async () => {
  registerCursorConnectionHandlers();
  const handler = mockHandlers.get(IPC_CHANNELS.cursorConnectionModels);
  if (!handler) throw new Error('Missing model handler');
  const request = handler(mockEvent);
  const stopped = shutdownCursorConnections();
  await expect(request).rejects.toThrow('unavailable');
  await stopped;
  expect(listCursorModels).not.toHaveBeenCalled();
  expect(mockSender.listenerCount('destroyed')).toBe(0);
});

test('an unrecognized account intent never reaches the sign-out branch', async () => {
  // The intent decides whether the shared credential store is signed out, so
  // an unknown value must be refused rather than defaulted into `change`.
  registerCursorConnectionHandlers();
  const handler = mockHandlers.get(IPC_CHANNELS.cursorConnectionChangeAccount);
  if (!handler) throw new Error('Missing change-account handler');
  for (const intent of [undefined, 'logout', '', 'CHANGE']) {
    await expect(handler(mockEvent, intent)).rejects.toThrow(
      'Unknown Cursor account operation.',
    );
  }
  expect(changeCursorAccount).not.toHaveBeenCalled();
  // Refused before the operation is owned, so the next caller is not blocked.
  expect(mockSender.listenerCount('destroyed')).toBe(0);
});

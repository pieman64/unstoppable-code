/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { EventEmitter } from 'node:events';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { registerOpenCodeConnectionHandlers } from '../ipc/opencode-connection';

type Handler = (event: IpcMainInvokeEvent, operationId?: unknown) => unknown;
const mockHandlers = new Map<string, Handler>();
const mockConnect = jest.fn<Promise<unknown>, [AbortSignal]>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler) =>
    mockHandlers.set(channel, handler),
}));
jest.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => ({}) },
}));
jest.mock('../lib/web-contents-send', () => ({ sendToWebContents: jest.fn() }));
jest.mock('../models/model-registry', () => ({
  broadcastModelRegistryUpdated: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => ({
  notifyPortalModelCatalogChanged: () => Promise.resolve(),
}));
jest.mock('../opencode/connection', () => ({
  connectOpenCode: (signal: AbortSignal) => mockConnect(signal),
  listOpenCodeModels: () => Promise.resolve([]),
}));
function eventFor(id: number): IpcMainInvokeEvent {
  const frame = {};
  const sender = Object.assign(new EventEmitter(), {
    id,
    mainFrame: frame,
    isDestroyed: () => false,
  });
  return { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
}
async function invoke(
  channel: string,
  event: IpcMainInvokeEvent,
  operationId?: unknown,
) {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error('Missing handler');
  return await handler(event, operationId);
}
beforeEach(() => {
  mockConnect.mockReset();
  registerOpenCodeConnectionHandlers();
});

it.each(['different request', 'different owner'])(
  'cancellation from a %s cannot stop another setup',
  async (kind) => {
    const owner = eventFor(10);
    let started: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: () => void = () => undefined;
    let activeSignal: AbortSignal | undefined;
    mockConnect.mockImplementation((signal: AbortSignal) => {
      activeSignal = signal;
      started();
      return new Promise((resolve, reject) => {
        finish = () => resolve({ phase: 'connected' });
        signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        });
      });
    });
    const connecting = invoke(
      IPC_CHANNELS.opencodeConnectionConnect,
      owner,
      'setup-a',
    );
    void connecting.catch(() => undefined);
    await ready;
    try {
      // The second connect was refused; cancelling that request must leave the first alone.
      await expect(
        invoke(IPC_CHANNELS.opencodeConnectionConnect, owner, 'setup-b'),
      ).rejects.toThrow('already running');
      await invoke(
        IPC_CHANNELS.opencodeConnectionCancel,
        kind === 'different owner' ? eventFor(11) : owner,
        kind === 'different owner' ? 'setup-a' : 'setup-b',
      );
      expect(activeSignal?.aborted).toBe(false);
    } finally {
      finish();
      await connecting.catch(() => undefined);
    }
  },
);

it.each([undefined, 'setup-a'])(
  'the owning caller can cancel and await teardown with id %s',
  async (operationId) => {
    const owner = eventFor(10);
    let started: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let teardownComplete = false;
    mockConnect.mockImplementation(async (signal: AbortSignal) => {
      started();
      try {
        await new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          ),
        );
      } finally {
        await Promise.resolve();
        teardownComplete = true;
      }
    });
    const connecting = invoke(
      IPC_CHANNELS.opencodeConnectionConnect,
      owner,
      'setup-a',
    );
    const rejected = expect(connecting).rejects.toThrow('cancelled');
    await ready;
    await invoke(IPC_CHANNELS.opencodeConnectionCancel, owner, operationId);
    expect(teardownComplete).toBe(true);
    await rejected;
  },
);

it.each(['', 42, {}, 'x'.repeat(201)])(
  'rejects malformed operation ids before starting setup: %p',
  async (operationId) => {
    await expect(
      invoke(IPC_CHANNELS.opencodeConnectionConnect, eventFor(10), operationId),
    ).rejects.toThrow('operation');
    expect(mockConnect).not.toHaveBeenCalled();
  },
);

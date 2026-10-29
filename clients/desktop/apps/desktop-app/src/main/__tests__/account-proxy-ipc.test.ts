import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

type CapturedHandler = (event: unknown, ...args: unknown[]) => unknown;

const handlers = new Map<string, CapturedHandler>();
const mockSetRoutingStrategy = jest.fn((strategy: string) =>
  Promise.resolve({ strategy }),
);

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: CapturedHandler): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): { onSnapshotChanged: jest.Mock } => ({
    onSnapshotChanged: jest.fn(),
  }),
}));
jest.mock('../account-proxy/service', () => ({
  setAccountProxyRoutingStrategy: (strategy: string): Promise<unknown> =>
    mockSetRoutingStrategy(strategy),
}));

import { registerAccountProxyHandlers } from '../ipc/account-proxy';

/** Mirrors `registerIpcHandler`: a synchronous throw rejects the invoke. */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return await handler({}, ...args);
}

beforeAll(() => {
  registerAccountProxyHandlers();
});

beforeEach(() => {
  mockSetRoutingStrategy.mockClear();
});

describe('account proxy IPC: account order', () => {
  it.each(['round-robin', 'weighted-round-robin', 'fill-first'])(
    'passes %s to the service',
    async (strategy) => {
      await expect(
        invoke(IPC_CHANNELS.accountProxySetRoutingStrategy, { strategy }),
      ).resolves.toEqual({ strategy });
      expect(mockSetRoutingStrategy).toHaveBeenCalledWith(strategy);
    },
  );

  it.each([
    undefined,
    null,
    'fill-first',
    { strategy: 'ff' },
    { strategy: 'Fill-First' },
    { strategy: 'bogus' },
    { strategy: 3 },
  ])('refuses %j without calling the service', async (request) => {
    await expect(
      invoke(IPC_CHANNELS.accountProxySetRoutingStrategy, request),
    ).rejects.toThrow('Invalid account proxy account order.');
    expect(mockSetRoutingStrategy).not.toHaveBeenCalled();
  });
});

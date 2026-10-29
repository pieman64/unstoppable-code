const saveDailyCreditDripMock = jest.fn();
const loadDailyCreditDripMock = jest.fn();
const clearAiCreditsRoutingContextCacheMock = jest.fn<void, []>();
const registerIpcHandlerMock = jest.fn();

jest.mock('../canopy-cloud/daily-credit-drip', () => ({
  saveDailyCreditDrip: (...args: unknown[]): unknown =>
    saveDailyCreditDripMock(...args),
  loadDailyCreditDrip: (...args: unknown[]): unknown =>
    loadDailyCreditDripMock(...args),
}));

jest.mock('../agents/ai-credits-routing', () => ({
  clearAiCreditsRoutingContextCache: (): void => {
    clearAiCreditsRoutingContextCacheMock();
  },
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (...args: unknown[]): unknown =>
    registerIpcHandlerMock(...args),
}));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  handleSaveDailyCreditDrip,
  registerDailyCreditDripHandlers,
} from '../ipc/daily-credit-drip';

const SAVED = {
  enabled: true,
  decidedAt: '2026-10-06T19:00:00.000Z',
  capCredits: 25,
  balanceCredits: 25,
  granted: 25,
};

describe('daily credit drip IPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    saveDailyCreditDripMock.mockResolvedValue(SAVED);
  });

  it('registers the load and save channels', () => {
    registerDailyCreditDripHandlers();

    const channels: unknown[] = registerIpcHandlerMock.mock.calls.map(
      (call: unknown[]): unknown => call[0],
    );
    expect(channels).toEqual([
      IPC_CHANNELS.settingsLoadDailyCreditDrip,
      IPC_CHANNELS.settingsSaveDailyCreditDrip,
    ]);
  });

  it.each([[true], [false]])(
    'saves enabled=%s and clears the routing cache',
    async (enabled) => {
      await expect(handleSaveDailyCreditDrip({ enabled })).resolves.toEqual(
        SAVED,
      );
      expect(saveDailyCreditDripMock).toHaveBeenCalledWith({ enabled });
      expect(clearAiCreditsRoutingContextCacheMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [{ enabled: 'true' }],
    [{ enabled: 1 }],
    [{}],
    [{ enabled: true, extra: 1 }],
    [null],
    ['enabled'],
  ])('rejects the invalid payload %j without saving', async (payload) => {
    await expect(handleSaveDailyCreditDrip(payload)).rejects.toThrow(
      'Invalid daily free credits payload',
    );
    expect(saveDailyCreditDripMock).not.toHaveBeenCalled();
  });

  it('still clears the routing cache when the save fails', async () => {
    saveDailyCreditDripMock.mockRejectedValue(new Error('offline'));

    await expect(handleSaveDailyCreditDrip({ enabled: true })).rejects.toThrow(
      'offline',
    );
    expect(clearAiCreditsRoutingContextCacheMock).toHaveBeenCalledTimes(1);
  });
});

import type { CopilotConnectionStatus } from '@canopy/desktop-shared/types';
import type { CopilotAccountUsage } from '@canopy/desktop-shared/types/copilot-connection';
const mockStatus = jest.fn<Promise<CopilotConnectionStatus>, []>();
const mockReadUsage = jest.fn<Promise<CopilotAccountUsage>, [AbortSignal]>();
jest.mock('../copilot/connection', () => ({
  copilotConnectionStatus: mockStatus,
  readCopilotAccountUsage: mockReadUsage,
}));
import { readCopilotUsageSummary } from '../copilot/account-usage';
const account = { host: 'https://github.com', login: 'usage-fixture' };
beforeEach(() => {
  mockStatus.mockResolvedValue({
    enabled: true,
    installed: true,
    supported: true,
    phase: 'connected',
    version: 'fixture',
    account,
  });
  mockReadUsage.mockReset();
});
test('preserves reported zero, reset dates, unlimited and unknown quotas without dollar estimates', async () => {
  mockReadUsage.mockResolvedValue({
    account,
    limits: [
      {
        id: 'premium_interactions',
        label: 'Premium requests',
        usedPercent: 0,
        resetsAt: '2026-11-01T00:00:00Z',
        unlimited: false,
      },
      { id: 'chat', label: 'Chat', usedPercent: 10, unlimited: true },
      { id: 'completions', label: 'Completions', unlimited: false },
    ],
  });
  const { lastUpdatedAt, ...summary } = await readCopilotUsageSummary(
    new AbortController().signal,
  );
  expect(lastUpdatedAt).toEqual(expect.any(String));
  expect(summary).toEqual({
    provider: 'copilot',
    authState: 'authenticated',
    accountLabel: 'usage-fixture',
    hasRemainingLimits: true,
    rateLimits: [
      {
        limitId: 'premium_interactions',
        limitName: 'Premium requests',
        primary: { usedPercent: 0, resetsAt: '2026-11-01T00:00:00Z' },
      },
      {
        limitId: 'chat',
        limitName: 'Chat',
        primary: {
          usedPercent: undefined,
          resetsAt: undefined,
          unlimited: true,
        },
      },
      {
        limitId: 'completions',
        limitName: 'Completions',
        primary: { usedPercent: undefined, resetsAt: undefined },
      },
    ],
  });
});
test('does not start a quota runtime for a disconnected account', async () => {
  mockStatus.mockResolvedValue({
    enabled: false,
    installed: true,
    supported: true,
    phase: 'idle',
    version: 'fixture',
    account: null,
  });
  expect(
    await readCopilotUsageSummary(new AbortController().signal),
  ).toMatchObject({ authState: 'unauthenticated', hasRemainingLimits: false });
  expect(mockReadUsage).not.toHaveBeenCalled();
});
test('publishes a curated error without leaking provider messages or stale limits', async () => {
  mockReadUsage.mockRejectedValue(new Error('secret provider response'));
  const summary = await readCopilotUsageSummary(new AbortController().signal);
  expect(summary).toMatchObject({
    provider: 'copilot',
    hasRemainingLimits: false,
    errorInfo: { kind: 'service' },
  });
  expect(JSON.stringify(summary)).not.toContain('secret provider response');
  expect(summary.rateLimits).toBeUndefined();
});

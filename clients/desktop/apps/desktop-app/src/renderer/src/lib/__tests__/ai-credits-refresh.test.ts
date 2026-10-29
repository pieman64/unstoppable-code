/**
 * @jest-environment jsdom
 */
import { refreshAiCreditsAfterDripChange } from '../ai-credits-refresh';
import {
  invalidateAiCreditsAvailabilityCache,
  readAiCreditsAvailabilityFresh,
} from '@/hooks/useAiCreditsAvailability';
import { invalidateAiCreditsUsageCache } from '@/hooks/useAiCreditsUsage';
import { invalidateSharedAiCreditsRead } from '../openBillingPage';

jest.mock('@/hooks/useAiCreditsUsage', () => ({
  invalidateAiCreditsUsageCache: jest.fn(),
}));
jest.mock('../openBillingPage', () => ({
  invalidateSharedAiCreditsRead: jest.fn(),
}));

const loadNativeAiCreditsAvailability = jest.fn();

function nativePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    personalEligible: false,
    inOrg: false,
    orgCreditPoolCovered: false,
    orgSpendable: false,
    pricingUrl: 'https://example.test/pricing',
    ...overrides,
  };
}

beforeEach(() => {
  loadNativeAiCreditsAvailability.mockReset();
  jest.mocked(invalidateAiCreditsUsageCache).mockClear();
  jest.mocked(invalidateSharedAiCreditsRead).mockClear();
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { loadNativeAiCreditsAvailability },
  });
  invalidateAiCreditsAvailabilityCache();
});

describe('refreshAiCreditsAfterDripChange', () => {
  it('invalidates the usage cache and resolves with the fresh availability read', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(
      nativePayload({ personalEligible: true, dailyDripEnabled: true }),
    );

    const result = await refreshAiCreditsAfterDripChange();

    expect(invalidateAiCreditsUsageCache).toHaveBeenCalledTimes(1);
    expect(invalidateSharedAiCreditsRead).toHaveBeenCalledTimes(1);
    expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      eligible: true,
      loading: false,
      inconclusive: false,
      dailyDripEnabled: true,
    });
  });

  it('shares one in-flight request between concurrent callers', async () => {
    let resolveRead: (value: unknown) => void = () => undefined;
    loadNativeAiCreditsAvailability.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    const first = refreshAiCreditsAfterDripChange();
    const second = readAiCreditsAvailabilityFresh();
    resolveRead(nativePayload({ personalEligible: true }));

    await expect(first).resolves.toMatchObject({ eligible: true });
    await expect(second).resolves.toMatchObject({ eligible: true });
    expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(1);
  });

  it('issues a new request once the previous fresh read settled', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(nativePayload());
    await refreshAiCreditsAfterDripChange();
    loadNativeAiCreditsAvailability.mockResolvedValue(
      nativePayload({ personalEligible: true }),
    );

    await expect(refreshAiCreditsAfterDripChange()).resolves.toMatchObject({
      eligible: true,
    });
    expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(2);
  });

  it('resolves as inconclusive instead of rejecting when the read fails', async () => {
    loadNativeAiCreditsAvailability.mockRejectedValue(new Error('offline'));

    await expect(refreshAiCreditsAfterDripChange()).resolves.toEqual({
      eligible: false,
      loading: false,
      inconclusive: true,
    });
  });

  it('leaves dailyDripEnabled undefined when the server omits it', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(nativePayload());

    const result = await refreshAiCreditsAfterDripChange();

    expect(result.dailyDripEnabled).toBeUndefined();
  });
});

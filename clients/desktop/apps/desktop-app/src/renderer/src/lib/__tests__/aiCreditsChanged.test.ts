/**
 * @jest-environment jsdom
 */
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { readCanopyCloudAccountChangeReason } from '@/lib/canopyCloudAccountChange';
import { announceAiCreditsChanged } from '../aiCreditsChanged';
import {
  announceAiCreditsChanged as compatibilityExport,
  invalidateSharedAiCreditsRead,
  readSharedAiCreditsAvailability,
} from '../openBillingPage';
import type * as AvailabilityModule from '@/hooks/useAiCreditsAvailability';

const mockInvalidate = jest.fn<void, []>();
jest.mock('@/hooks/useAiCreditsAvailability', () => {
  const actual = jest.requireActual<typeof AvailabilityModule>(
    '@/hooks/useAiCreditsAvailability',
  );
  return {
    ...actual,
    invalidateAiCreditsAvailabilityCache: (): void => {
      mockInvalidate();
      actual.invalidateAiCreditsAvailabilityCache();
    },
  };
});

describe('announceAiCreditsChanged (CAN-5026)', () => {
  beforeEach(() => {
    mockInvalidate.mockReset();
  });

  it('invalidates availability BEFORE dispatching one same-account refresh', () => {
    const order: string[] = [];
    mockInvalidate.mockImplementation(() => order.push('invalidate'));
    const record = (event: Event): void => {
      order.push(readCanopyCloudAccountChangeReason(event));
    };
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, record);
    try {
      announceAiCreditsChanged();
    } finally {
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, record);
    }
    expect(order).toEqual(['invalidate', 'same-account-refresh']);
  });

  it('keeps the billing-page export as the same helper', () => {
    expect(compatibilityExport).toBe(announceAiCreditsChanged);
  });
});

describe('announceAiCreditsChanged (CAN-4061)', () => {
  it('notifies account subscribers as a same-account refresh and opens a new episode', async () => {
    const load = jest.fn().mockResolvedValue({
      personalEligible: true,
      inOrg: false,
      orgCreditPoolCovered: false,
      orgSpendable: false,
      pricingUrl: 'https://cloud.example.com/pricing',
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { loadNativeAiCreditsAvailability: load },
    });
    invalidateSharedAiCreditsRead();
    await readSharedAiCreditsAvailability();
    const reasons: string[] = [];
    const record = (event: Event): void => {
      reasons.push(readCanopyCloudAccountChangeReason(event));
    };
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, record);

    announceAiCreditsChanged();
    await readSharedAiCreditsAvailability();

    window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, record);
    expect(reasons).toEqual(['same-account-refresh']);
    // Billing subscribers still see the change: the retained answer is gone.
    expect(load).toHaveBeenCalledTimes(2);
  });
});

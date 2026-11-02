/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CreditsBillingTarget } from '@canopy/protocol/billing';
import type { NativeAiCreditsAvailability } from '@canopy/desktop-shared/types';
import {
  useOrgCreditPoolBalance,
  type OrgCreditPoolBalance,
} from '../useOrgCreditPoolBalance';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ACME = 'abcdefab-1111-4111-8111-111111111111';
const ZEN = '22222222-2222-4222-8222-222222222222';

function availability(
  organizationId: string,
  balance: number | null | undefined,
): NativeAiCreditsAvailability {
  const result: NativeAiCreditsAvailability = {
    personalEligible: true,
    inOrg: true,
    orgCreditPoolCovered: true,
    orgSpendable: true,
    ownerOrganization: { id: organizationId, name: 'Pool' },
    pricingUrl: 'https://cloud.example.com/pricing',
  };
  // A wire null is outside the declared type; set it as parsed JSON would.
  if (balance !== undefined) {
    Reflect.set(result, 'ownerOrganizationBalanceCredits', balance);
  }
  return result;
}

interface Deferred {
  readonly resolve: (value: NativeAiCreditsAvailability) => void;
  readonly reject: (cause: Error) => void;
}

const organization = (organizationId: string): CreditsBillingTarget => ({
  kind: 'organization',
  organizationId,
});

describe('useOrgCreditPoolBalance', () => {
  let container: HTMLElement;
  let root: Root;
  let reads: Deferred[];
  let renders: OrgCreditPoolBalance[];

  function Probe({
    target,
    accountKey,
  }: {
    readonly target: CreditsBillingTarget;
    readonly accountKey: string | null;
  }): JSX.Element {
    renders.push(useOrgCreditPoolBalance(target, accountKey));
    return <span />;
  }

  const latest = (): OrgCreditPoolBalance | undefined => renders.at(-1);

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    reads = [];
    renders = [];
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadNativeAiCreditsAvailability: jest.fn(
          () =>
            new Promise<NativeAiCreditsAvailability>((resolve, reject) => {
              reads.push({ resolve, reject });
            }),
        ),
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, 'api');
  });

  function render(
    target: CreditsBillingTarget,
    accountKey: string | null = 'acct_1',
  ): void {
    act(() => root.render(<Probe target={target} accountKey={accountKey} />));
  }

  async function settle(
    index: number,
    outcome: NativeAiCreditsAvailability | Error,
  ): Promise<void> {
    await act(async () => {
      const read = reads[index];
      if (outcome instanceof Error) read?.reject(outcome);
      else read?.resolve(outcome);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
  }

  it('reads nothing for a personal target or while signed out', () => {
    render({ kind: 'personal' });
    render(organization(ACME), null);
    expect(reads).toHaveLength(0);
    expect(latest()?.balanceCredits).toBeNull();
    act(() => latest()?.refresh());
    expect(reads).toHaveLength(0);
  });

  it('reads on mount, matches the organization case-insensitively, and keeps refresh stable', async () => {
    render(organization(ACME));
    expect(reads).toHaveLength(1);
    await settle(0, availability(ACME.toUpperCase(), 412.5));
    expect(latest()?.balanceCredits).toBe(412.5);
    const refreshes = new Set(renders.map((entry) => entry.refresh));
    expect(refreshes.size).toBe(1);
  });

  it('keeps the known balance while the same target refreshes', async () => {
    render(organization(ACME));
    await settle(0, availability(ACME, 100));
    act(() => latest()?.refresh());
    expect(reads).toHaveLength(2);
    expect(latest()?.balanceCredits).toBe(100);
    await settle(1, availability(ACME, 90));
    expect(latest()?.balanceCredits).toBe(90);
  });

  it.each([undefined, null, NaN, Infinity])(
    'clears a known balance after a redacted or invalid read: %p',
    async (value) => {
      render(organization(ACME));
      await settle(0, availability(ACME, 0));
      expect(latest()?.balanceCredits).toBe(0);
      act(() => latest()?.refresh());
      await settle(1, availability(ACME, value));
      expect(latest()?.balanceCredits).toBeNull();
    },
  );

  it('fences departed reads across A to B to A and loss then restoration of eligibility', async () => {
    render(organization(ACME));
    render(organization(ZEN));
    render(organization(ACME));
    await settle(2, availability(ACME, 7));
    await settle(0, availability(ACME, 99));
    await settle(1, availability(ZEN, 88));
    expect(latest()?.balanceCredits).toBe(7);
    act(() => latest()?.refresh());
    render({ kind: 'personal' });
    render(organization(ACME));
    await settle(4, availability(ACME, 0));
    await settle(3, availability(ACME, 77));
    expect(latest()?.balanceCredits).toBe(0);
  });

  it('lets the latest read win across refresh and focus', async () => {
    render(organization(ACME));
    act(() => latest()?.refresh());
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(reads).toHaveLength(3);
    await settle(2, availability(ACME, 3));
    await settle(0, availability(ACME, 1));
    await settle(1, availability(ACME, 2));
    expect(latest()?.balanceCredits).toBe(3);
  });

  it('shows nothing for a new target, even before its read starts or when an old read lands', async () => {
    render(organization(ACME));
    await settle(0, availability(ACME, 100));
    render(organization(ZEN));
    // The first render for the new target already drops the old number.
    expect(renders.at(-2)?.balanceCredits ?? null).toBeNull();
    expect(latest()?.balanceCredits).toBeNull();
    act(() => latest()?.refresh());
    const pendingForZen = reads.length - 1;
    await settle(pendingForZen, availability(ACME, 100));
    expect(latest()?.balanceCredits).toBeNull();

    render(organization(ACME));
    expect(latest()?.balanceCredits).toBeNull();
  });

  it('drops a pending read when the account changes or signs out', async () => {
    render(organization(ACME), 'acct_1');
    render(organization(ACME), 'acct_2');
    await settle(0, availability(ACME, 100));
    expect(latest()?.balanceCredits).toBeNull();
    await settle(1, availability(ACME, 7));
    expect(latest()?.balanceCredits).toBe(7);

    render(organization(ACME), null);
    expect(latest()?.balanceCredits).toBeNull();
  });

  it('drops an old target read still pending during a switch and keeps the new billing target', async () => {
    render(organization(ACME));
    await settle(0, availability(ACME, 100));
    const refresh = latest()?.refresh;
    act(() => refresh?.());
    const firstNewRender = renders.length;
    render(organization(ZEN));
    expect(renders[firstNewRender]?.balanceCredits).toBeNull();
    expect(latest()?.refresh).toBe(refresh);
    await settle(2, availability(ZEN, 7));
    await settle(1, availability(ACME, 99));
    expect(latest()?.balanceCredits).toBe(7);
  });

  it('clears a previously known number when a refresh returns a different organization', async () => {
    render(organization(ACME));
    await settle(0, availability(ACME, 100));
    act(() => latest()?.refresh());
    await settle(1, availability(ZEN, 999));
    expect(latest()?.balanceCredits).toBeNull();
  });

  it('forgets the balance after a failed read or a pool with no number', async () => {
    render(organization(ACME));
    await settle(0, availability(ACME, 100));
    act(() => latest()?.refresh());
    await settle(1, new Error('offline'));
    expect(latest()?.balanceCredits).toBeNull();

    act(() => latest()?.refresh());
    await settle(2, availability(ACME, 50));
    act(() => latest()?.refresh());
    await settle(3, availability(ACME, null));
    expect(latest()?.balanceCredits).toBeNull();
  });

  it('rereads on window focus and stops after unmount', async () => {
    render(organization(ACME));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(reads).toHaveLength(2);
    const before = renders.length;
    act(() => root.unmount());
    await settle(1, availability(ACME, 100));
    window.dispatchEvent(new Event('focus'));
    expect(reads).toHaveLength(2);
    expect(renders).toHaveLength(before);
    root = createRoot(container);
  });
});

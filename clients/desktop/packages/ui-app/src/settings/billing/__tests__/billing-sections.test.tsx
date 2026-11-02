/**
 * @jest-environment jsdom
 */
import { act, useEffect, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SettingsPaymentOwner } from '@canopy/protocol/billing';
import type {
  BillingSummary,
  ChargePage,
  CreditsLedgerPage,
  CreditsSummary,
  InvoicePage,
} from '@canopy/protocol/settings/billing';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import type {
  SettingsPaymentHandoffIntent,
  SettingsPaymentHandoffResult,
} from '@canopy/protocol/settings/payment-handoff';
import { BillingSection } from '../account-billing-section';
import { TeamBillingSection } from '../team-billing-section';
import {
  BillingSettingsSlotsProvider,
  type AutoTopUpControlsSlotProps,
  type BillingIntentControllerSlotProps,
  type BillingSettingsIntentTarget,
  type BillingSettingsSlots,
  type CreditsTopUpSlotProps,
  type OrganizationPaymentMethodActionsSlotProps,
  type PersonalPaymentMethodActionsSlotProps,
  type PersonalPlanSubscribeCtaSlotProps,
  type OrganizationPlanSubscribeCtaSlotProps,
} from '../billing-settings-slots';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsClient,
  type FakeSettingsHandler,
} from '../../__tests__/helpers/test-settings-host';
import type { SettingsOperationName } from '@canopy/protocol/settings';
import { SettingsOperationError } from '@canopy/protocol/settings/errors';
import type { SettingsRouter } from '../../host';
import { SETTINGS_LOAD_ERROR_COPY } from '../../errors';

/** The load copy beside its own Try again, which the banner does not repeat. */
const LOAD_SHOWN = SETTINGS_LOAD_ERROR_COPY.replace(/ Try again\.$/, '');
import { INVOICES_LOAD_MORE_ERROR } from '../invoices-section';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

/* ---- Fixtures ------------------------------------------------------------ */

const TRIAL_ENDS_AT = new Date(Date.now() + 10 * 86_400_000).toISOString();
const CARD = { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 };

function makeSummary(overrides: Partial<BillingSummary> = {}): BillingSummary {
  return {
    plan: { key: 'individual', displayName: 'Pro', billingModel: 'FLAT' },
    status: 'TRIALING',
    trial: { active: true, endsAt: TRIAL_ENDS_AT },
    nextBillingDate: TRIAL_ENDS_AT,
    nextBillingAmountUsd: 20,
    upgradeChargeUsd: 19,
    seatCount: null,
    paymentMethod: null,
    walletBalanceUsd: 0,
    capabilities: [],
    coverageNotes: [],
    ...overrides,
  };
}

function makeOrgSummary(
  overrides: Partial<BillingSummary> = {},
): BillingSummary {
  return makeSummary({
    plan: {
      key: 'business',
      displayName: 'Business',
      billingModel: 'PER_SEAT',
    },
    seatCount: 3,
    nextBillingAmountUsd: 60,
    upgradeChargeUsd: null,
    trialEndedAt: null,
    lapseReason: null,
    ...overrides,
  });
}

function makeCredits(overrides: Partial<CreditsSummary> = {}): CreditsSummary {
  return {
    balanceCredits: 100,
    balanceUsd: 100,
    split: { dripCredits: '0', allotmentCredits: '80', purchasedCredits: '20' },
    allotmentTotalCredits: 200,
    dailyDripCapCredits: 0,
    nextRefillAt: null,
    nextAllotmentAt: null,
    autoTopUp: {
      enabled: true,
      amountUsd: 25,
      thresholdCredits: 10,
      maxMonthlyUsd: 500,
      disabledReason: null,
    },
    monthlySpentUsd: 50,
    usedThisCycleCredits: 0,
    usagePeriodStart: '2026-07-01T00:00:00.000Z',
    usagePeriodEnd: null,
    usagePeriodKind: 'calendar-month',
    monthlyResetAt: '2026-08-01T00:00:00.000Z',
    activeSource: 'canopy',
    udLinked: false,
    ...overrides,
  };
}

const EMPTY_HISTORY: ChargePage = { charges: [], nextCursor: null };
const EMPTY_INVOICES: InvoicePage = { invoices: [], nextCursor: null };
const EMPTY_LEDGER: CreditsLedgerPage = { email: 'a@example.com', entries: [] };

function detail(role: OrganizationDetail['viewerRole']): OrganizationDetail {
  return {
    id: 'org-1',
    name: 'Acme',
    viewerRole: role,
    members: [],
    subTeams: [],
    usageStatsMinRole: 'ADMIN',
    canViewUsageStats: true,
    logoUrl: null,
    githubConnection: { connected: false, accountLogin: null },
  };
}

function accountHandlers(
  summary: BillingSummary,
  credits: CreditsSummary = makeCredits(),
): Partial<Record<SettingsOperationName, FakeSettingsHandler>> {
  return {
    'account.billing.summary': () => summary,
    'account.billing.charges': () => EMPTY_HISTORY,
    'account.billing.invoices': () => EMPTY_INVOICES,
    'account.billing.credits': () => credits,
    'account.billing.creditsLedger': () => EMPTY_LEDGER,
  };
}

function organizationHandlers(
  summary: BillingSummary,
  credits: CreditsSummary = makeCredits({ balanceCredits: 500 }),
): Partial<Record<SettingsOperationName, FakeSettingsHandler>> {
  return {
    'organization.billing.summary': () => summary,
    'organization.billing.history': () => EMPTY_HISTORY,
    'organization.billing.invoices': () => EMPTY_INVOICES,
    'organization.billing.credits': () => credits,
    'organization.billing.credits.ledger': () => EMPTY_LEDGER,
  };
}

/* ---- Stub web slots ------------------------------------------------------ */

interface SlotRecord {
  intentController: BillingIntentControllerSlotProps[];
  personalPlan: PersonalPlanSubscribeCtaSlotProps[];
  organizationPlan: OrganizationPlanSubscribeCtaSlotProps[];
  personalPaymentMethod: PersonalPaymentMethodActionsSlotProps[];
  organizationPaymentMethod: Omit<
    OrganizationPaymentMethodActionsSlotProps,
    'children'
  >[];
  creditsTopUp: Omit<CreditsTopUpSlotProps, 'children'>[];
  autoTopUp: AutoTopUpControlsSlotProps[];
}

function last<T>(items: readonly T[]): T {
  const item = items[items.length - 1];
  if (item === undefined) throw new Error('Slot never rendered');
  return item;
}

/**
 * Stand-ins for the web billing slots: each renders a marker and records the
 * props the shared section passed, and the intent controller reports
 * `target` once the section says its data is ready.
 */
function createStubSlots(target: BillingSettingsIntentTarget | null): {
  slots: BillingSettingsSlots;
  record: SlotRecord;
} {
  const record: SlotRecord = {
    intentController: [],
    personalPlan: [],
    organizationPlan: [],
    personalPaymentMethod: [],
    organizationPaymentMethod: [],
    creditsTopUp: [],
    autoTopUp: [],
  };
  function IntentController(props: BillingIntentControllerSlotProps): null {
    record.intentController.push(props);
    const { dataReady, onTarget } = props;
    useEffect(() => {
      if (dataReady && target !== null) onTarget(target);
    }, [dataReady, onTarget]);
    return null;
  }
  const slots: BillingSettingsSlots = {
    publishableKey: 'pk_test_123',
    IntentController,
    CreditPoolSubscription: () => null,
    PersonalPlanSubscribeCta: (props) => {
      record.personalPlan.push(props);
      return <span data-testid="slot-personal-plan-cta" />;
    },
    OrganizationPlanSubscribeCta: (props) => {
      record.organizationPlan.push(props);
      return <span data-testid="slot-organization-plan-cta" />;
    },
    OrganizationPlanUpgradeCta: () => (
      <span data-testid="slot-organization-upgrade-cta" />
    ),
    SubscriptionActionsMenu: () => (
      <span data-testid="slot-subscription-actions" />
    ),
    PersonalPaymentMethodActions: (props) => {
      record.personalPaymentMethod.push(props);
      return <span data-testid="slot-personal-payment-method" />;
    },
    OrganizationPaymentMethodActions: ({ children, ...props }) => {
      record.organizationPaymentMethod.push(props);
      return (
        <>
          {children({
            actions: <span data-testid="slot-organization-payment-method" />,
            after: null,
          })}
        </>
      );
    },
    CreditsTopUp: ({ children, ...props }) => {
      record.creditsTopUp.push(props);
      return (
        <>
          {children({
            trigger: <span data-testid="slot-credits-top-up" />,
            dialog: null,
          })}
        </>
      );
    },
    AutoTopUpControls: (props) => {
      record.autoTopUp.push(props);
      return <span data-testid="slot-auto-top-up" />;
    },
  };
  return { slots, record };
}

/* ---- Harness ------------------------------------------------------------- */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

type Handoff = (
  owner: SettingsPaymentOwner,
  intent: SettingsPaymentHandoffIntent,
) => Promise<SettingsPaymentHandoffResult>;

interface MountOptions {
  readonly handlers: Partial<
    Record<SettingsOperationName, FakeSettingsHandler>
  >;
  /** Web composition with stub slots, or a host without inline checkout. */
  readonly slots?: BillingSettingsSlots;
  readonly available?: boolean | null;
  readonly handoff?: Handoff;
  readonly privacy?: { blockClassName: string; maskClassName: string };
  readonly router?: Partial<SettingsRouter>;
}

async function mount(
  element: JSX.Element,
  { handlers, slots, available = true, handoff, privacy, router }: MountOptions,
): Promise<FakeSettingsClient> {
  const client = createFakeSettingsClient(handlers);
  const { host } = createTestSettingsHost({
    client,
    inlineCheckout: slots !== undefined,
    paymentHandoffAvailable: available,
    privacy,
    router,
    navigation:
      handoff === undefined ? undefined : { openPaymentHandoff: handoff },
  });
  await act(async () => {
    await Promise.resolve();
    root.render(
      <TestSettingsHost host={host}>
        {slots === undefined ? (
          element
        ) : (
          <BillingSettingsSlotsProvider slots={slots}>
            {element}
          </BillingSettingsSlotsProvider>
        )}
      </TestSettingsHost>,
    );
  });
  await flush();
  return client;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function readCount(client: FakeSettingsClient, operation: string): number {
  return client.calls.filter((call) => call.operation === operation).length;
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function button(id: string): HTMLButtonElement {
  const element = byTestId(id);
  if (!(element instanceof HTMLButtonElement))
    throw new Error(`No button ${id}`);
  return element;
}

async function click(id: string): Promise<void> {
  await act(async () => {
    button(id).click();
    await Promise.resolve();
  });
}

/** Test ids of the web-only financial UI none of these hosts may render. */
const FINANCIAL_TEST_IDS = [
  'billing-upgrade-cta',
  'billing-add-card-button',
  'billing-edit-card-button',
  'billing-delete-card-button',
  'credits-top-up-button',
  'credits-adjust-limit',
  'subscription-actions-trigger',
  'team-billing-subscribe-cta',
  'team-billing-upgrade-cta',
  'team-billing-add-card',
  'team-billing-edit-card',
  'team-billing-delete-card',
  'team-credits-top-up-button',
  'team-credits-adjust-limit',
  'stripe-payment-element',
];

function expectNoFinancialUi(): void {
  for (const id of FINANCIAL_TEST_IDS) {
    expect(byTestId(id)).toBeNull();
  }
}

/* ---- Account: inline (web) composition ----------------------------------- */

describe('BillingSection with the web billing slots', () => {
  it('places each slot where the web page renders it', async () => {
    const { slots, record } = createStubSlots(null);
    await mount(<BillingSection />, {
      handlers: accountHandlers(makeSummary({ paymentMethod: CARD })),
      slots,
    });

    expect(
      byTestId('billing-plan-card')?.querySelector(
        '[data-testid="slot-personal-plan-cta"]',
      ),
    ).not.toBeNull();
    expect(
      byTestId('billing-plan-card')?.querySelector(
        '[data-testid="slot-subscription-actions"]',
      ),
    ).not.toBeNull();
    expect(
      byTestId('billing-ai-credits')?.querySelector(
        '[data-testid="slot-credits-top-up"]',
      ),
    ).not.toBeNull();
    expect(
      byTestId('billing-ai-credits')?.querySelector(
        '[data-testid="slot-auto-top-up"]',
      ),
    ).not.toBeNull();
    expect(
      byTestId('billing-payment-method')?.querySelector(
        '[data-testid="slot-personal-payment-method"]',
      ),
    ).not.toBeNull();
    // The web page reports no handoff notice.
    expect(byTestId('billing-payment-handoff')).toBeNull();
    expect(last(record.intentController)).toMatchObject({
      viewerId: 'account-1',
      owner: { kind: 'personal' },
      canManageBilling: true,
      dataReady: true,
    });
    expect(last(record.creditsTopUp)).toMatchObject({
      owner: { kind: 'personal' },
      intent: null,
      variant: 'secondary',
    });
    expect(last(record.autoTopUp)).toMatchObject({
      owner: { kind: 'personal' },
      canManage: true,
      openAdjustRequestId: null,
    });
  });

  it('opens the card modal for a payment-method intent, showing the card even with no history', async () => {
    const { slots, record } = createStubSlots({
      kind: 'payment-method',
      requestId: 'req_1',
    });
    await mount(<BillingSection />, {
      handlers: accountHandlers(makeSummary()),
      slots,
    });

    expect(byTestId('account-billing-history-card')).not.toBeNull();
    expect(last(record.personalPaymentMethod).openRequestId).toBe('req_1');
  });

  it('opens the automatic top-up editor for an auto-top-up intent', async () => {
    const { slots, record } = createStubSlots({
      kind: 'auto-top-up',
      requestId: 'req_2',
    });
    await mount(<BillingSection />, {
      handlers: accountHandlers(makeSummary()),
      slots,
    });

    expect(last(record.autoTopUp).openAdjustRequestId).toBe('req_2');
  });

  it('hands a top-up intent to the credit checkout', async () => {
    const intent = { reason: 'credits' as const, source: 'desktop' as const };
    const { slots, record } = createStubSlots({ kind: 'top-up', intent });
    await mount(<BillingSection />, {
      handlers: accountHandlers(makeSummary()),
      slots,
    });

    expect(last(record.creditsTopUp).intent).toBe(intent);
  });

  it('routes a subscription intent with a plan through the ?plan= checkout', async () => {
    const { slots, record } = createStubSlots({
      kind: 'subscription',
      requestId: 'req_3',
      plan: 'individual',
    });
    await mount(<BillingSection />, {
      handlers: accountHandlers(makeSummary()),
      slots,
    });

    expect(last(record.personalPlan).intentPlanKey).toBe('individual');
    // No card modal: the plan's own checkout handles it.
    expect(byTestId('account-billing-history-card')).toBeNull();
    expect(
      record.personalPaymentMethod.every(
        (props) => props.openRequestId === null,
      ),
    ).toBe(true);
  });

  it('opens the update-card modal for a subscription intent without a plan while a card is needed', async () => {
    const { slots, record } = createStubSlots({
      kind: 'subscription',
      requestId: 'req_4',
    });
    await mount(<BillingSection />, {
      handlers: accountHandlers(
        makeSummary({ status: 'PAST_DUE', trial: null }),
      ),
      slots,
    });

    expect(last(record.personalPaymentMethod).openRequestId).toBe('req_4');
  });

  it('only brings the plan card into view when the subscription needs no card', async () => {
    const scrollIntoView = jest.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const { slots, record } = createStubSlots({
      kind: 'subscription',
      requestId: 'req_5',
    });
    await mount(<BillingSection />, {
      handlers: accountHandlers(
        makeSummary({ status: 'ACTIVE', trial: null, paymentMethod: CARD }),
      ),
      slots,
    });

    expect(scrollIntoView).toHaveBeenCalled();
    expect(last(record.personalPaymentMethod).openRequestId).toBeNull();
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  });
});

/* ---- Account: handoff (desktop) ------------------------------------------ */

describe('BillingSection without inline checkout', () => {
  it('renders the handoff CTAs and none of the web financial UI', async () => {
    const handoff = jest.fn<ReturnType<Handoff>, Parameters<Handoff>>(() =>
      Promise.resolve({ ok: true }),
    );
    await mount(<BillingSection />, {
      handlers: accountHandlers(makeSummary({ paymentMethod: CARD })),
      handoff,
    });

    expectNoFinancialUi();
    // No status line until a handoff starts.
    expect(byTestId('billing-payment-handoff')).toBeNull();
    // The saved card's summary stays; its management happens on the web.
    expect(byTestId('billing-payment-method')?.textContent).toContain('4242');
    expect(button('billing-manage-payment-method').textContent).toBe(
      'Manage payment method',
    );
    expect(button('billing-buy-credits-handoff').textContent).toBe(
      'Buy credits',
    );
    // The automatic top-up summary stays read-only.
    expect(byTestId('credits-auto-top-up-summary')?.textContent).toContain(
      'Buys $25.00',
    );
    const toggle = byTestId('credits-auto-top-up-toggle');
    expect(toggle instanceof HTMLButtonElement && toggle.disabled).toBe(true);

    await click('billing-manage-auto-top-up');
    expect(handoff).toHaveBeenLastCalledWith(
      { kind: 'personal' },
      { kind: 'modal', modal: 'auto-top-up' },
    );
  });

  it('re-reads the personal wallet on a credit-pool signal from the settings client', async () => {
    const client = await mount(<BillingSection />, {
      handlers: accountHandlers(makeSummary({ paymentMethod: CARD })),
    });
    expect(client.subscriptions).toContainEqual({ kind: 'credit-pool' });
    const before = readCount(client, 'account.billing.credits');

    await act(async () => {
      client.emit({ type: 'credit.pool' });
      await Promise.resolve();
    });
    await flush();
    expect(readCount(client, 'account.billing.credits')).toBeGreaterThan(
      before,
    );

    // Another wallet's signal is not this page's.
    const after = readCount(client, 'account.billing.credits');
    await act(async () => {
      client.emit({ type: 'credit.pool', organizationId: 'org-1' });
      await Promise.resolve();
    });
    await flush();
    expect(readCount(client, 'account.billing.credits')).toBe(after);
  });

  it('offers "Manage billing on web" for a trial converting without a card', async () => {
    const handoff = jest.fn<ReturnType<Handoff>, Parameters<Handoff>>(() =>
      Promise.resolve({ ok: true }),
    );
    await mount(<BillingSection />, {
      handlers: accountHandlers(makeSummary()),
      handoff,
    });

    await click('billing-manage-billing-on-web');

    expect(handoff).toHaveBeenCalledWith(
      { kind: 'personal' },
      { kind: 'modal', modal: 'subscription', plan: 'individual' },
    );
    expect(byTestId('billing-payment-handoff-message')?.textContent).toBe(
      'Continue in your browser.',
    );
  });

  it('offers no subscription CTA for a healthy paid plan', async () => {
    await mount(<BillingSection />, {
      handlers: accountHandlers(
        makeSummary({ status: 'ACTIVE', trial: null, paymentMethod: CARD }),
      ),
    });

    expect(byTestId('billing-manage-billing-on-web')).toBeNull();
  });

  it('disables the CTAs up front while the handoff is unavailable', async () => {
    await mount(<BillingSection />, {
      handlers: accountHandlers(makeSummary({ paymentMethod: CARD })),
      available: false,
    });

    expect(button('billing-buy-credits-handoff').disabled).toBe(true);
    expect(button('billing-manage-payment-method').disabled).toBe(true);
    expect(byTestId('billing-payment-handoff-open-on-web')).not.toBeNull();
  });

  it('blocks the card label and covering organization names from session replay', async () => {
    await mount(
      <BillingSection
        orgs={[{ id: 'org-1', name: 'Acme', canManageBilling: false }]}
        orgCovered
      />,
      {
        handlers: accountHandlers(makeSummary({ paymentMethod: CARD })),
        privacy: {
          blockClassName: 'replay-block',
          maskClassName: 'replay-mask',
        },
      },
    );

    const label = Array.from(
      byTestId('billing-payment-method')?.querySelectorAll('p') ?? [],
    ).find((p) => p.textContent?.includes('4242'));
    expect(label?.className).toContain('replay-block');
    const coverage = Array.from(
      byTestId('billing-org-coverage')?.querySelectorAll('p') ?? [],
    ).find((p) => p.textContent?.includes('Acme'));
    expect(coverage?.className).toContain('replay-block');
  });
});

/* ---- Organization ------------------------------------------------------------ */

describe('TeamBillingSection with the web billing slots', () => {
  it('gives the owner the intent controller and opens the card modal for a payment-method intent', async () => {
    const { slots, record } = createStubSlots({
      kind: 'payment-method',
      requestId: 'req_1',
    });
    await mount(<TeamBillingSection detail={detail('OWNER')} />, {
      handlers: organizationHandlers(makeOrgSummary()),
      slots,
    });

    expect(last(record.intentController)).toMatchObject({
      owner: { kind: 'organization', organizationId: 'org-1' },
      canManageBilling: true,
      dataReady: true,
    });
    expect(byTestId('team-billing-history-card')).not.toBeNull();
    expect(last(record.organizationPaymentMethod).openRequestId).toBe('req_1');
    expect(last(record.organizationPlan).organizationId).toBe('org-1');
  });

  it('opens the automatic top-up editor for an auto-top-up intent', async () => {
    const { slots, record } = createStubSlots({
      kind: 'auto-top-up',
      requestId: 'req_2',
    });
    await mount(<TeamBillingSection detail={detail('OWNER')} />, {
      handlers: organizationHandlers(makeOrgSummary()),
      slots,
    });

    expect(last(record.autoTopUp)).toMatchObject({
      owner: { kind: 'organization', organizationId: 'org-1' },
      canManage: true,
      openAdjustRequestId: 'req_2',
    });
  });

  it('never opens owner modals for an admin', async () => {
    const { slots, record } = createStubSlots({
      kind: 'payment-method',
      requestId: 'req_1',
    });
    await mount(<TeamBillingSection detail={detail('ADMIN')} />, {
      handlers: organizationHandlers(makeOrgSummary({ paymentMethod: CARD })),
      slots,
    });

    expect(last(record.intentController).canManageBilling).toBe(false);
    expect(record.organizationPaymentMethod).toHaveLength(0);
    expect(byTestId('slot-credits-top-up')).toBeNull();
  });
});

describe('TeamBillingSection without inline checkout', () => {
  it('gives the owner handoff CTAs for the organization wallet', async () => {
    const handoff = jest.fn<ReturnType<Handoff>, Parameters<Handoff>>(() =>
      Promise.resolve({ ok: true }),
    );
    await mount(<TeamBillingSection detail={detail('OWNER')} />, {
      handlers: organizationHandlers(makeOrgSummary({ paymentMethod: CARD })),
      handoff,
    });

    expectNoFinancialUi();
    const owner = { kind: 'organization', organizationId: 'org-1' };
    await click('team-billing-buy-credits-handoff');
    expect(handoff).toHaveBeenLastCalledWith(owner, {
      kind: 'top-up',
      reason: 'credits',
    });
  });

  it('re-reads the organization wallet on its credit-pool signal', async () => {
    const client = await mount(
      <TeamBillingSection detail={detail('OWNER')} />,
      {
        handlers: organizationHandlers(makeOrgSummary({ paymentMethod: CARD })),
      },
    );
    expect(client.subscriptions).toContainEqual({
      kind: 'credit-pool',
      organizationId: 'org-1',
    });
    const before = readCount(client, 'organization.billing.credits');
    await act(async () => {
      client.emit({ type: 'reconnected', organizationId: 'org-1' });
      await Promise.resolve();
    });
    await flush();
    expect(readCount(client, 'organization.billing.credits')).toBeGreaterThan(
      before,
    );
  });

  it('offers the plan checkout for a trialing organization without a card', async () => {
    const handoff = jest.fn<ReturnType<Handoff>, Parameters<Handoff>>(() =>
      Promise.resolve({ ok: true }),
    );
    await mount(<TeamBillingSection detail={detail('OWNER')} />, {
      handlers: organizationHandlers(makeOrgSummary()),
      handoff,
    });

    await click('team-billing-manage-billing-on-web');
    expect(handoff).toHaveBeenLastCalledWith(
      { kind: 'organization', organizationId: 'org-1' },
      { kind: 'modal', modal: 'subscription', plan: 'business' },
    );
  });

  it('shows an admin the read-only summaries without CTAs or the handoff notice', async () => {
    await mount(<TeamBillingSection detail={detail('ADMIN')} />, {
      handlers: organizationHandlers(makeOrgSummary({ paymentMethod: CARD })),
    });

    expectNoFinancialUi();
    expect(byTestId('team-billing-payment-handoff')).toBeNull();
    expect(byTestId('team-billing-buy-credits-handoff')).toBeNull();
    expect(byTestId('team-billing-manage-auto-top-up')).toBeNull();
    expect(byTestId('team-billing-manage-payment-method')).toBeNull();
    expect(byTestId('team-billing-manage-billing-on-web')).toBeNull();
    expect(byTestId('team-billing-card-summary')?.textContent).toContain(
      '4242',
    );
    expect(byTestId('team-credits-auto-top-up-summary')).not.toBeNull();
  });
});

/* ---- First load ---------------------------------------------------------- */

describe('billing first load', () => {
  /** A read that never settles, so each card stays in its first load. */
  const pending = (): Promise<never> => new Promise<never>(() => undefined);

  it('holds the account plan and credit cards with skeletons, never loading copy', async () => {
    await mount(<BillingSection />, {
      handlers: {
        'account.billing.summary': pending,
        'account.billing.charges': pending,
        'account.billing.invoices': pending,
        'account.billing.credits': pending,
        'account.billing.creditsLedger': pending,
      },
    });

    for (const card of ['billing-plan-card', 'billing-ai-credits']) {
      expect(
        byTestId(card)
          ?.querySelector('[data-testid="settings-skeleton-card-body"]')
          ?.getAttribute('role'),
      ).toBe('status');
    }
    expect(container.textContent).not.toContain('Loading plan');
    expect(container.textContent).not.toContain('Loading AI credits');
  });

  it('holds the organization cards with skeletons, never loading copy', async () => {
    await mount(<TeamBillingSection detail={detail('OWNER')} />, {
      handlers: {
        'organization.billing.summary': pending,
        'organization.billing.history': pending,
        'organization.billing.invoices': pending,
        'organization.billing.credits': pending,
        'organization.billing.credits.ledger': pending,
      },
    });

    for (const card of ['team-billing-plan-card', 'team-billing-ai-credits']) {
      expect(
        byTestId(card)?.querySelector(
          '[data-testid="settings-skeleton-card-body"]',
        ),
      ).not.toBeNull();
    }
    expect(container.textContent).not.toMatch(
      /Loading (plan|AI credits|history)/,
    );
  });
});

describe('billing errors', () => {
  /** A server body the UI must never render. */
  const SENTINEL = 'SENTINEL-billing-server-body';
  const failure = (status: number): never => {
    throw new SettingsOperationError({
      code: 'failed',
      message: SENTINEL,
      status,
    });
  };

  function retryButton(): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Try again',
    );
    if (found === undefined) throw new Error('No Retry button');
    return found;
  }

  it('shows load copy, never the server body, and Retry reloads the organization summary', async () => {
    let fail = true;
    const handlers = organizationHandlers(makeOrgSummary());
    const client = await mount(
      <TeamBillingSection detail={detail('OWNER')} />,
      {
        handlers: {
          ...handlers,
          'organization.billing.summary': () =>
            fail ? failure(500) : makeOrgSummary(),
        },
      },
    );

    expect(container.textContent).toContain(LOAD_SHOWN);
    expect(container.innerHTML).not.toContain(SENTINEL);
    const before = readCount(client, 'organization.billing.summary');

    fail = false;
    act(() => {
      retryButton().click();
    });
    await flush();

    expect(readCount(client, 'organization.billing.summary')).toBe(before + 1);
    expect(container.textContent).not.toContain(LOAD_SHOWN);
  });

  it('sends an organization billing 403 through the access-lost refresh', async () => {
    const refresh = jest.fn();
    await mount(<TeamBillingSection detail={detail('OWNER')} />, {
      handlers: {
        ...organizationHandlers(makeOrgSummary()),
        'organization.billing.credits': () => failure(403),
      },
      router: { refresh },
    });

    expect(refresh).toHaveBeenCalled();
    expect(container.innerHTML).not.toContain(SENTINEL);
  });

  it('shows fixed copy when more invoices fail to load', async () => {
    let invoiceReads = 0;
    await mount(<TeamBillingSection detail={detail('OWNER')} />, {
      handlers: {
        ...organizationHandlers(makeOrgSummary({ paymentMethod: CARD })),
        'organization.billing.invoices': () => {
          invoiceReads += 1;
          if (invoiceReads > 1) return failure(500);
          const page: InvoicePage = {
            invoices: [
              {
                id: '2026-07-01',
                number: 'INV-20260701',
                issuedAt: '2026-07-01T00:00:00.000Z',
                periodStart: '2026-07-01T00:00:00.000Z',
                periodEnd: '2026-08-01T00:00:00.000Z',
                currency: 'usd',
                status: 'PAID',
                isCurrent: false,
                totalUsd: 20,
                amountPaidUsd: 20,
                lineItemCount: 1,
                cardBrand: 'visa',
                cardLast4: '4242',
              },
            ],
            nextCursor: 'cursor-2',
          };
          return page;
        },
      },
    });

    act(() => {
      button('team-billing-invoices-load-more').click();
    });
    await flush();

    expect(container.textContent).toContain(INVOICES_LOAD_MORE_ERROR);
    expect(container.innerHTML).not.toContain(SENTINEL);
  });

  it('shows load copy, never the server body, and Retry reloads the account summary', async () => {
    let fail = true;
    const summary = makeSummary();
    const client = await mount(<BillingSection />, {
      handlers: {
        ...accountHandlers(summary),
        'account.billing.summary': () => (fail ? failure(500) : summary),
      },
    });

    expect(container.textContent).toContain(LOAD_SHOWN);
    expect(container.innerHTML).not.toContain(SENTINEL);
    const before = readCount(client, 'account.billing.summary');

    fail = false;
    act(() => {
      retryButton().click();
    });
    await flush();

    expect(readCount(client, 'account.billing.summary')).toBe(before + 1);
    expect(container.textContent).not.toContain(LOAD_SHOWN);
  });
});

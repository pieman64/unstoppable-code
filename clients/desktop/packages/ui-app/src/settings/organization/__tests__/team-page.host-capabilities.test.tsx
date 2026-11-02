/**
 * @jest-environment jsdom
 */
// What the organization page shell does when a host cannot run a flow
// inline (desktop): paid per-seat invites and Personal-to-team promotion hand
// off to the web, and organization switching keeps the tab only when the
// destination offers it. Web supplies the slots, so its flows stay inline.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

import { act, type JSX, type ReactNode } from 'react';
import {
  SettingsStoreProvider,
  useSettingsStoreApi,
  type SettingsStore,
} from '@canopy/app-state/settings';
import { createRoot, type Root } from 'react-dom/client';
import {
  SettingsOperationError,
  type BillingSummary,
} from '@canopy/protocol/settings';
import {
  createFakeSettingsClient,
  type FakeSettingsClient,
  type FakeSettingsHandler,
} from '../../__tests__/helpers/test-settings-host';
import { inviteMayAddPaidSeat } from '../invite-seat-charge';
import type {
  OrganizationPromotionDialogProps,
  OrganizationSettingsSlots,
} from '../organization-settings-slots';
import { TeamPage, type TeamPageProps } from '../team-page';
import {
  buildOrganizationDetail,
  OrganizationTestHost,
  seatChargeSlot,
} from './helpers/members-section-harness';

function summary(overrides: Partial<BillingSummary> = {}): BillingSummary {
  return {
    plan: {
      key: 'business',
      displayName: 'Business',
      billingModel: 'PER_SEAT',
    },
    status: 'ACTIVE',
    trial: null,
    nextBillingDate: null,
    nextBillingAmountUsd: null,
    seatCount: 1,
    paymentMethod: null,
    walletBalanceUsd: 0,
    capabilities: [],
    coverageNotes: [],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let client: FakeSettingsClient;
const push = jest.fn();
const openExternal = jest.fn();
const selectOrganization = jest.fn();

function makeClient(
  handlers: Partial<Record<string, FakeSettingsHandler>> = {},
): FakeSettingsClient {
  return createFakeSettingsClient({
    'organization.invitations.list': () => ({ enabled: true, invites: [] }),
    ...handlers,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  client = makeClient();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderPage(
  overrides: Partial<TeamPageProps> = {},
  slots: OrganizationSettingsSlots = {},
  wrap: (page: ReactNode) => ReactNode = (page) => page,
): Promise<void> {
  const props: TeamPageProps = {
    initialDetail: buildOrganizationDetail(),
    viewerEmail: 'owner@example.com',
    billingEnabled: true,
    memoryEnabled: false,
    projectsEnabled: false,
    mobileBrowser: false,
    activeTab: 'members',
    ...overrides,
  };
  await act(async () => {
    root.render(
      <OrganizationTestHost
        client={client}
        slots={slots}
        host={{
          router: { push },
          navigation: { openExternal },
          selectOrganization,
        }}
      >
        {wrap(<TeamPage {...props} />)}
      </OrganizationTestHost>,
    );
    await Promise.resolve();
  });
  await flush();
}

function byTestId(testId: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function billingSummaryReads(): number {
  return client.calls.filter(
    (call) => call.operation === 'organization.billing.summary',
  ).length;
}

describe('inviteMayAddPaidSeat', () => {
  it.each<[string, Partial<BillingSummary>, boolean]>([
    ['an active per-seat plan', {}, true],
    [
      'a flat plan',
      {
        plan: { key: 'team', displayName: 'Team', billingModel: 'FLAT' },
      },
      false,
    ],
    ['a trialing subscription', { status: 'TRIALING' }, false],
    [
      'an active subscription still in its trial window',
      { trial: { active: true, endsAt: '2026-12-01T00:00:00.000Z' } },
      false,
    ],
    ['a past-due subscription', { status: 'PAST_DUE' }, false],
    ['no subscription', { plan: null, status: null }, false],
  ])('reports %s', (_name, overrides, expected) => {
    expect(inviteMayAddPaidSeat(summary(overrides))).toBe(expected);
  });
});

describe('Members invite without the seat-charge slot', () => {
  it('hands a paid per-seat invite to the web instead of inviting here', async () => {
    client = makeClient({ 'organization.billing.summary': () => summary() });
    await renderPage({ inviteOnLoad: true });

    expect(byTestId('team-add-member')).toBeNull();
    // `?invite=1` never opens a dialog that could charge a seat unconfirmed.
    expect(byTestId('add-member-dialog')).toBeNull();
    // Only the button sits in the header row; the reason is a line below
    // the header, so the header keeps one height.
    const button = byTestId('team-invite-on-web');
    expect(button?.textContent).toContain('Invite on the web');
    expect(byTestId('page-header-actions')?.contains(button ?? null)).toBe(
      true,
    );
    const handoff = byTestId('team-invite-web-handoff');
    expect(handoff?.textContent).toBe(
      'Inviting can add a paid seat. Continue in your browser.',
    );
    expect(byTestId('page-header')?.contains(handoff)).toBe(false);
    expect(
      byTestId('page-header')?.compareDocumentPosition(handoff ?? document) ??
        0,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await act(async () => {
      byTestId('team-invite-on-web')?.click();
      await Promise.resolve();
    });
    expect(openExternal).toHaveBeenCalledWith(
      'https://canopy.test/organization/org-1/members?invite=1',
    );
  });

  it('invites inline when the plan cannot charge a seat', async () => {
    client = makeClient({
      'organization.billing.summary': () =>
        summary({
          plan: { key: 'team', displayName: 'Team', billingModel: 'FLAT' },
        }),
    });
    await renderPage({ inviteOnLoad: true });

    expect(byTestId('team-invite-web-handoff')).toBeNull();
    const add = byTestId('team-add-member');
    expect(add instanceof HTMLButtonElement && add.disabled).toBe(false);
    // The inline dialog has no quote to wait on and no card step.
    expect(byTestId('add-member-dialog')).not.toBeNull();
    expect(byTestId('seat-charge-loading')).toBeNull();
    expect(byTestId('seat-charge-notice')).toBeNull();
  });

  it.each([
    ['billing is off for the viewer', { billingEnabled: false }],
    ['free access is on', { freeAccess: true }],
  ])(
    'invites inline without reading billing when %s',
    async (_name, overrides) => {
      await renderPage(overrides);
      expect(billingSummaryReads()).toBe(0);
      expect(byTestId('team-add-member')).not.toBeNull();
      expect(byTestId('team-invite-web-handoff')).toBeNull();
    },
  );

  it.each([403, 404])(
    'treats an unreadable billing summary (%s) as no charge',
    async (status) => {
      client = makeClient({
        'organization.billing.summary': () => {
          throw new SettingsOperationError({ code: 'forbidden', status });
        },
      });
      await renderPage();
      expect(byTestId('team-add-member')).not.toBeNull();
      expect(byTestId('team-invite-web-handoff')).toBeNull();
    },
  );

  it('hands off when billing cannot be confirmed', async () => {
    client = makeClient({
      'organization.billing.summary': () => {
        throw new SettingsOperationError({ code: 'failed', status: 500 });
      },
    });
    await renderPage();
    expect(byTestId('team-add-member')).toBeNull();
    expect(byTestId('team-invite-web-handoff')).not.toBeNull();
  });

  it('blocks an inline invite when the plan became chargeable since the page loaded', async () => {
    let chargeable = false;
    client = makeClient({
      'organization.billing.summary': () =>
        chargeable
          ? summary()
          : summary({
              plan: { key: 'team', displayName: 'Team', billingModel: 'FLAT' },
            }),
      'organization.members.invite': () => {
        throw new Error('must not invite');
      },
    });
    await renderPage({ inviteOnLoad: true });
    chargeable = true;

    const email = byTestId('add-member-email');
    if (!(email instanceof HTMLInputElement)) throw new Error('No email input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(email, 'new@example.com');
      email.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      email.form?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await flush();

    expect(
      client.calls.some(
        (call) => call.operation === 'organization.members.invite',
      ),
    ).toBe(false);
    expect(byTestId('add-member-dialog')?.textContent).toContain(
      'Inviting can add a paid seat. Continue in your browser.',
    );
    // The header now offers the handoff the error points at.
    expect(byTestId('team-invite-web-handoff')).not.toBeNull();
  });

  it('sends an inline invite after re-confirming no seat can be charged', async () => {
    const flat = summary({
      plan: { key: 'team', displayName: 'Team', billingModel: 'FLAT' },
    });
    client = makeClient({
      'organization.billing.summary': () => flat,
      'organization.members.invite': () => ({
        id: 'invite-1',
        code: 'code-1',
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationTeamName: null,
        role: 'MEMBER',
        invitedEmail: 'new@example.com',
        seatPaymentState: 'READY',
        emailQueued: true,
        emailSuppressed: false,
        emailDeferred: false,
      }),
    });
    await renderPage({ inviteOnLoad: true });

    const email = byTestId('add-member-email');
    if (!(email instanceof HTMLInputElement)) throw new Error('No email input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(email, 'new@example.com');
      email.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      email.form?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await flush();

    // Once on load and once immediately before sending.
    expect(billingSummaryReads()).toBe(2);
    expect(
      client.calls.find(
        (call) => call.operation === 'organization.members.invite',
      )?.input,
    ).toEqual({
      organizationId: 'org-1',
      email: 'new@example.com',
      role: 'MEMBER',
    });
    expect(byTestId('add-member-success')?.textContent).toContain(
      'Invitation sent',
    );
  });

  it('keeps the inline seat-quoting invite when the host supplies the slot', async () => {
    await renderPage(
      {},
      {
        seatCharge: seatChargeSlot(() => new Promise<never>(() => {})),
      },
    );
    expect(billingSummaryReads()).toBe(0);
    expect(byTestId('team-add-member')).not.toBeNull();
    expect(byTestId('team-invite-web-handoff')).toBeNull();
  });
});

describe('Members invite seat-charge cache (settings store)', () => {
  let store: SettingsStore | null = null;

  function StoreProbe(): null {
    store = useSettingsStoreApi();
    return null;
  }

  /** The desktop shape: a settings store above the page, kept across visits. */
  function withStore(page: ReactNode): ReactNode {
    return (
      <SettingsStoreProvider client={client} accountId="account-1">
        <StoreProbe />
        {page}
      </SettingsStoreProvider>
    );
  }

  async function visitMembers(): Promise<void> {
    await renderPage({ activeTab: 'members' }, {}, withStore);
  }

  async function leaveMembers(): Promise<void> {
    await renderPage({ activeTab: 'feed' }, {}, withStore);
  }

  async function sendInvite(): Promise<void> {
    await act(async () => {
      byTestId('team-add-member')?.click();
      await Promise.resolve();
    });
    const email = byTestId('add-member-email');
    if (!(email instanceof HTMLInputElement)) throw new Error('No email input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(email, 'new@example.com');
      email.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      email.form?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await flush();
  }

  beforeEach(() => {
    store = null;
  });

  it('reuses the check on a second Members visit, with no swap and no read', async () => {
    client = makeClient({ 'organization.billing.summary': () => summary() });
    await visitMembers();
    expect(billingSummaryReads()).toBe(1);
    expect(byTestId('team-invite-on-web')).not.toBeNull();

    // A fresh page under the same store, as a return visit on desktop.
    // The first render of the return visit already shows the handoff.
    act(() => {
      root.render(
        <OrganizationTestHost
          client={client}
          slots={{}}
          host={{ router: { push }, navigation: { openExternal } }}
        >
          {withStore(
            <TeamPage
              key="return-visit"
              initialDetail={buildOrganizationDetail()}
              viewerEmail="owner@example.com"
              billingEnabled
              memoryEnabled={false}
              projectsEnabled={false}
              mobileBrowser={false}
              activeTab="members"
            />,
          )}
        </OrganizationTestHost>,
      );
    });
    expect(byTestId('team-invite-on-web')).not.toBeNull();
    expect(byTestId('team-add-member')).toBeNull();
    await flush();
    expect(billingSummaryReads()).toBe(1);
  });

  it('reads billing again on the next visit after an invite', async () => {
    const flat = summary({
      plan: { key: 'team', displayName: 'Team', billingModel: 'FLAT' },
    });
    client = makeClient({
      'organization.billing.summary': () => flat,
      'organization.members.invite': () => ({
        id: 'invite-1',
        code: 'code-1',
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationTeamName: null,
        role: 'MEMBER',
        invitedEmail: 'new@example.com',
        seatPaymentState: 'READY',
        emailQueued: true,
        emailSuppressed: false,
        emailDeferred: false,
      }),
    });
    await visitMembers();
    expect(store?.getState().seatCharges['org-1']).toBe('inline');

    await sendInvite();
    expect(byTestId('add-member-success')).not.toBeNull();
    // The page keeps its action; only the cache is cleared.
    expect(store?.getState().seatCharges['org-1']).toBeUndefined();
    const readsAfterInvite = billingSummaryReads();

    await leaveMembers();
    await visitMembers();
    expect(billingSummaryReads()).toBe(readsAfterInvite + 1);
  });

  it('is cleared by a settings refresh', async () => {
    client = makeClient({ 'organization.billing.summary': () => summary() });
    await visitMembers();
    expect(store?.getState().seatCharges['org-1']).toBe('handoff');
    await act(async () => {
      await store?.getState().refresh();
    });
    expect(store?.getState().seatCharges).toEqual({});
  });
});

describe('Personal-to-team promotion', () => {
  const personal = buildOrganizationDetail({
    id: 'personal-1',
    name: 'Personal',
    isPersonal: true,
  });

  it('opens the host promotion dialog when the host supplies one', async () => {
    const opened = jest.fn();
    function PromotionDialog(
      props: OrganizationPromotionDialogProps,
    ): JSX.Element {
      opened(props);
      return <div data-testid="promotion-dialog" />;
    }
    await renderPage(
      { initialDetail: personal, activeTab: 'feed' },
      { PromotionDialog },
    );
    await act(async () => {
      byTestId('team-personal-invite')?.click();
      await Promise.resolve();
    });

    expect(byTestId('promotion-dialog')).not.toBeNull();
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({
        accountKey: 'account-1',
        personalOrganizationId: 'personal-1',
        inviteRequired: true,
      }),
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('continues on the web Personal page without a host promotion dialog', async () => {
    await renderPage({ initialDetail: personal, activeTab: 'feed' });
    await act(async () => {
      byTestId('team-personal-invite')?.click();
      await Promise.resolve();
    });

    expect(byTestId('promotion-dialog')).toBeNull();
    expect(openExternal).toHaveBeenCalledWith(
      'https://canopy.test/organization/personal-1',
    );
  });
});

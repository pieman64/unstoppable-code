/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ComponentProps, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import {
  createTestSettingsHost,
  TestSettingsHost,
} from '../../../__tests__/helpers/test-settings-host';
import type { SettingsUiHost } from '../../../host';
import {
  OrganizationSettingsSubtabSlotsProvider,
  type OrganizationSettingsSubtabSlots,
} from '../organization-settings-subtab-slots';

// The Billing subtab renders the billing area's section. Its own suites cover
// its contents; here it only has to mount on the right subtab and receive the
// free-access mode, so a stub records what it was handed.
const mockBillingProps = jest.fn();
jest.mock('../../../billing/team-billing-section', () => ({
  TeamBillingSection: (props: { freeAccess?: boolean }): JSX.Element => {
    mockBillingProps(props);
    return (
      <section data-testid="team-billing-section">
        {props.freeAccess === true ? null : (
          <div data-testid="team-billing-plan-card" />
        )}
      </section>
    );
  },
}));

// Stateful host router: the active subtab lives in the URL, so `replace`
// mutates a shared URLSearchParams that `useSettingsSearchParams` reads back.
const mockReplace = jest.fn<void, [string, { scroll?: boolean }?]>();
// On web, tab switches mirror into the URL with the native history call
// (Next keeps `useSearchParams` in step with it), not with a router round
// trip. The suite supplies the same slot web does.
let replaceState: jest.SpyInstance;
const mockPush = jest.fn();
const mockSearchParams = new URLSearchParams();
const WEB_SUBTAB_SLOTS: OrganizationSettingsSubtabSlots = {
  replaceSubtabHref: (href) => window.history.replaceState(null, '', href),
  // Web fills this with its External agents card; its own suite covers it.
  renderExternalAgentsPolicy: () => (
    <section data-testid="team-external-agents" />
  ),
};

function setMockParams(queryString: string): void {
  for (const key of Array.from(mockSearchParams.keys())) {
    mockSearchParams.delete(key);
  }
  new URLSearchParams(queryString).forEach((value, key) => {
    mockSearchParams.set(key, value);
  });
}

/**
 * Every card loads its own config/pricing/entitlement on mount. Keep those
 * requests pending so the cards render their initial state without async
 * churn — this suite is about which cards mount, not their contents.
 */
const PENDING_CLIENT: AccountOrganizationSettingsClient = {
  read: () => new Promise<never>(() => {}),
  write: () => new Promise<never>(() => {}),
  subscribe: () => () => {},
};

function buildHost(): SettingsUiHost {
  const { host } = createTestSettingsHost({
    client: PENDING_CLIENT,
    pathname: '/organization/org-1/settings',
    router: {
      push: (url: string, opts?: { scroll?: boolean }): void => {
        mockPush(url, opts);
      },
      replace: (url: string, opts?: { scroll?: boolean }): void => {
        mockReplace(url, opts);
        setMockParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
      },
    },
  });
  return { ...host, useSearchParams: () => mockSearchParams };
}

import { TeamSettingsSection } from '../team-settings-section';

type LapsedInfo = ComponentProps<typeof TeamSettingsSection>['lapsed'];

const LAPSED: NonNullable<LapsedInfo> = {
  trialEndedAt: '2026-05-01T00:00:00.000Z',
  lapseReason: 'trial_ended',
  requiredPlanName: 'Business',
};

function buildDetail(
  overrides: Partial<OrganizationDetail> = {},
): OrganizationDetail {
  return {
    id: 'org-1',
    name: 'Acme',
    viewerRole: 'OWNER',
    members: [],
    subTeams: [],
    usageStatsMinRole: 'ADMIN',
    canViewUsageStats: true,
    logoUrl: null,
    githubConnection: { connected: false, accountLogin: null },
    ...overrides,
  };
}

describe('TeamSettingsSection subtabs', () => {
  let container: HTMLElement;
  let root: Root;
  const host = buildHost();

  beforeEach(() => {
    setMockParams('');
    mockReplace.mockClear();
    replaceState = jest
      .spyOn(window.history, 'replaceState')
      .mockImplementation((): void => {});
    mockPush.mockClear();
    mockBillingProps.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    replaceState.mockRestore();
  });

  function render(
    initialQuery = '',
    overrides: {
      detail?: OrganizationDetail;
      memoryEnabled?: boolean;
      billingEnabled?: boolean;
      billingNeedsAttention?: boolean;
      freeAccess?: boolean;
      lapsed?: LapsedInfo;
      externalAgentsEnabled?: boolean;
      slots?: OrganizationSettingsSubtabSlots;
    } = {},
  ): void {
    setMockParams(initialQuery);
    act(() => {
      root.render(
        <TestSettingsHost host={host}>
          <OrganizationSettingsSubtabSlotsProvider
            slots={overrides.slots ?? WEB_SUBTAB_SLOTS}
          >
            <TeamSettingsSection
              detail={overrides.detail ?? buildDetail()}
              onDetailChange={() => {}}
              memoryEnabled={overrides.memoryEnabled ?? true}
              billingEnabled={overrides.billingEnabled ?? true}
              billingNeedsAttention={overrides.billingNeedsAttention ?? false}
              freeAccess={overrides.freeAccess}
              lapsed={overrides.lapsed ?? null}
              onDeleted={() => {}}
              externalAgentsEnabled={overrides.externalAgentsEnabled}
            />
          </OrganizationSettingsSubtabSlotsProvider>
        </TestSettingsHost>,
      );
    });
  }

  function has(testId: string): boolean {
    return container.querySelector(`[data-testid="${testId}"]`) !== null;
  }

  function tab(key: string): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>(
      `[data-testid="team-settings-tab-${key}"]`,
    );
    if (!el) {
      throw new Error(`tab ${key} not found`);
    }
    return el;
  }

  function tabKeys(): string[] {
    const nav = container.querySelector('[data-testid="team-settings-tabs"]');
    return nav
      ? Array.from(nav.children).map(
          (child) =>
            child
              .getAttribute('data-testid')
              ?.replace('team-settings-tab-', '') ?? '',
        )
      : [];
  }

  async function click(el: HTMLElement): Promise<void> {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
  }

  it('lands an owner on General and shows only General cards', () => {
    render();

    expect(tabKeys()).toEqual([
      'general',
      'policies',
      'integrations',
      'usage',
      'billing',
    ]);
    expect(tab('general').getAttribute('aria-pressed')).toBe('true');
    expect(has('team-branding-settings-section')).toBe(true);
    expect(has('team-danger-zone')).toBe(true);

    // Nothing from the other subtabs leaks into the default view.
    expect(has('team-enforced-settings-section')).toBe(false);
    expect(has('team-model-policy-section')).toBe(false);
    expect(has('team-memory-settings-section')).toBe(false);
    expect(has('team-usage-settings-section')).toBe(false);
    expect(has('team-subscription-pricing-section')).toBe(false);
    expect(has('team-github-connection-section')).toBe(false);
    expect(has('team-billing-section')).toBe(false);
  });

  it('writes ?tab=policies and swaps the rendered cards when Policies is clicked', async () => {
    render();
    await click(tab('policies'));

    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/organization/org-1/settings?tab=policies',
    );
    expect(mockReplace).not.toHaveBeenCalled();
    // The panel swaps on the click itself, before any URL round trip.
    expect(tab('policies').getAttribute('aria-pressed')).toBe('true');
    expect(has('team-enforced-settings-section')).toBe(true);

    // And it stays put once the URL reflects the switch.
    render('tab=policies');
    expect(tab('policies').getAttribute('aria-pressed')).toBe('true');
    expect(has('team-enforced-settings-section')).toBe(true);
    expect(has('team-model-policy-section')).toBe(true);
    expect(has('team-memory-settings-section')).toBe(true);
    expect(has('team-branding-settings-section')).toBe(false);
    expect(has('team-danger-zone')).toBe(false);
  });

  it('follows a later navigation back to the query it switched from', async () => {
    render();
    await click(tab('policies'));
    // Next syncs `useSearchParams` to the replaced URL...
    render('tab=policies');
    expect(tab('policies').getAttribute('aria-pressed')).toBe('true');

    // ...then a link (or the router) goes back to the bare settings URL.
    render('');
    expect(tab('general').getAttribute('aria-pressed')).toBe('true');
    expect(has('team-branding-settings-section')).toBe(true);
    expect(has('team-enforced-settings-section')).toBe(false);
  });

  it('drops the one-shot ?github= flag when switching away from Integrations', async () => {
    render('tab=integrations&github=connected');
    await click(tab('policies'));

    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/organization/org-1/settings?tab=policies',
    );
  });

  it('drops the one-shot ?github= flag when returning to General', async () => {
    render('tab=integrations&github=connected');
    await click(tab('general'));

    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/organization/org-1/settings',
    );
  });

  it('renders the Usage subtab cards from ?tab=usage', () => {
    render('tab=usage');

    expect(has('team-usage-settings-section')).toBe(true);
    expect(has('team-subscription-pricing-section')).toBe(true);
    expect(has('team-branding-settings-section')).toBe(false);
  });

  it('renders the GitHub card on the Integrations subtab', () => {
    render('tab=integrations');

    expect(has('team-github-connection-section')).toBe(true);
    expect(has('team-branding-settings-section')).toBe(false);
  });

  it('collapses back to a clean URL when returning to General', async () => {
    render('tab=policies');
    await click(tab('general'));

    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/organization/org-1/settings',
    );
  });

  it('falls back to the first visible tab for an unknown ?tab= value', () => {
    render('tab=nope');

    expect(tab('general').getAttribute('aria-pressed')).toBe('true');
    expect(has('team-branding-settings-section')).toBe(true);
    // A stale deep link must not rewrite the URL on load.
    expect(mockReplace).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('falls back to the first visible tab when ?tab= names a hidden one', () => {
    // Policies is hidden while lapsed, so the deep link resolves to General
    // rather than rendering an empty page.
    render('tab=policies', { lapsed: LAPSED });

    expect(
      container.querySelector('[data-testid="team-settings-tab-policies"]'),
    ).toBeNull();
    expect(tab('general').getAttribute('aria-pressed')).toBe('true');
    expect(has('team-branding-settings-section')).toBe(true);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('shows a stats-viewing MEMBER no subtab bar and only the pricing card', () => {
    render('', {
      detail: buildDetail({ viewerRole: 'MEMBER', canViewUsageStats: true }),
    });

    // Every other card self-gates to null for a MEMBER, so a bar advertising
    // four tabs would be three dead ends.
    expect(container.querySelector('[data-testid="team-settings-tabs"]')).toBe(
      null,
    );
    expect(has('team-subscription-pricing-section')).toBe(true);
    expect(has('team-branding-settings-section')).toBe(false);
    expect(has('team-danger-zone')).toBe(false);
  });

  it('hides Policies for a lapsed org and keeps General, Usage, and Billing', () => {
    // Integrations drops too when there is no connection to revoke: its only
    // live control would be a Connect button whose save 403s. Billing is the
    // deliberate exception to the `healthy` gate — it is the surface that
    // undoes the lapse.
    render('', { lapsed: LAPSED });

    expect(tabKeys()).toEqual(['general', 'usage', 'billing']);
    expect(has('team-branding-settings-section')).toBe(true);
    expect(has('team-danger-zone')).toBe(true);
    expect(has('team-model-policy-section')).toBe(false);
  });

  it('keeps Integrations for a lapsed org that still has a connection to revoke', () => {
    render('tab=integrations', {
      lapsed: LAPSED,
      detail: buildDetail({
        githubConnection: { connected: true, accountLogin: 'acme' },
      }),
    });

    expect(tabKeys()).toEqual(['general', 'integrations', 'usage', 'billing']);
    expect(has('team-github-connection-section')).toBe(true);
  });

  it('drops the statistics-visibility card from Usage while lapsed', () => {
    // `updateOrganizationConfig` is gated, so the card would offer a control
    // whose every save 403s; the read-only pricing card stays.
    render('tab=usage', { lapsed: LAPSED });

    expect(has('team-usage-settings-section')).toBe(false);
    expect(has('team-subscription-pricing-section')).toBe(true);
  });

  describe('External agents card', () => {
    it('shows an OWNER the card in Policies while the flag is on', () => {
      render('tab=policies', { externalAgentsEnabled: true });

      expect(tab('policies').getAttribute('aria-pressed')).toBe('true');
      expect(has('team-external-agents')).toBe(true);
      // It joins the member policies rather than replacing them.
      expect(has('team-enforced-settings-section')).toBe(true);
      expect(has('team-model-policy-section')).toBe(true);
    });

    it('stays off the default General view', () => {
      render('', { externalAgentsEnabled: true });

      expect(has('team-external-agents')).toBe(false);
    });

    it.each(['ADMIN', 'MEMBER'] as const)(
      'is hidden from an %s',
      (viewerRole) => {
        render('tab=policies', {
          externalAgentsEnabled: true,
          detail: buildDetail({ viewerRole }),
        });

        expect(has('team-external-agents')).toBe(false);
      },
    );

    it('is hidden for a Personal organization', () => {
      render('tab=policies', {
        externalAgentsEnabled: true,
        detail: buildDetail({ isPersonal: true }),
      });

      expect(has('team-external-agents')).toBe(false);
    });

    it('is hidden while the flag is off', () => {
      render('tab=policies', { externalAgentsEnabled: false });

      expect(has('team-external-agents')).toBe(false);
      expect(has('team-enforced-settings-section')).toBe(true);
    });

    it('keeps Policies for a lapsed OWNER with only the External agents card', () => {
      render('tab=policies', { lapsed: LAPSED, externalAgentsEnabled: true });

      expect(tabKeys()).toEqual(['general', 'policies', 'usage', 'billing']);
      expect(tab('policies').getAttribute('aria-pressed')).toBe('true');
      expect(has('team-external-agents')).toBe(true);
      // The config cards route through the gated config update, so a lapsed
      // owner reaching Policies must not see them.
      expect(has('team-enforced-settings-section')).toBe(false);
      expect(has('team-model-policy-section')).toBe(false);
      expect(has('team-model-gateway-section')).toBe(false);
      expect(has('team-memory-settings-section')).toBe(false);
    });

    it('does not bring Policies back for a lapsed ADMIN', () => {
      render('tab=policies', {
        lapsed: LAPSED,
        externalAgentsEnabled: true,
        detail: buildDetail({ viewerRole: 'ADMIN' }),
      });

      expect(tabKeys()).toEqual(['general', 'usage', 'billing']);
      expect(has('team-external-agents')).toBe(false);
    });

    it('is hidden, and keeps Policies closed while lapsed, without the host slot', () => {
      render('tab=policies', {
        lapsed: LAPSED,
        externalAgentsEnabled: true,
        slots: {
          replaceSubtabHref: WEB_SUBTAB_SLOTS.replaceSubtabHref,
        },
      });

      expect(tabKeys()).toEqual(['general', 'usage', 'billing']);
      expect(has('team-external-agents')).toBe(false);
    });
  });

  describe('Billing subtab', () => {
    it('renders the billing card from ?tab=billing and nothing else', () => {
      render('tab=billing');

      expect(tab('billing').getAttribute('aria-pressed')).toBe('true');
      expect(has('team-billing-section')).toBe(true);
      expect(has('team-branding-settings-section')).toBe(false);
      expect(has('team-danger-zone')).toBe(false);
    });

    it('sits last in the bar, directly after Usage', () => {
      // The commercial surfaces stay adjacent and at the tail, the way GitHub,
      // Linear, and Notion order theirs. Usage carries provider pricing, so
      // slotting anything between the two splits one subject in half.
      render();

      const keys = tabKeys();
      expect(keys[keys.length - 1]).toBe('billing');
      expect(keys[keys.length - 2]).toBe('usage');
    });

    it('hides Billing from a MEMBER, who has no billing action to take', () => {
      render('tab=billing', {
        detail: buildDetail({ viewerRole: 'MEMBER', canViewUsageStats: true }),
      });

      expect(
        container.querySelector('[data-testid="team-settings-tab-billing"]'),
      ).toBeNull();
      // The deep link falls back rather than rendering billing UI they cannot
      // use — the coverage the deleted `/billing` route's `notFound()` carried.
      expect(has('team-billing-section')).toBe(false);
    });

    it('hides Billing when the billing flag is off for this viewer', () => {
      render('tab=billing', { billingEnabled: false });

      expect(
        container.querySelector('[data-testid="team-settings-tab-billing"]'),
      ).toBeNull();
      expect(has('team-billing-section')).toBe(false);
      // Falls back to General rather than an empty panel, without rewriting
      // the URL on load.
      expect(tab('general').getAttribute('aria-pressed')).toBe('true');
      expect(mockReplace).not.toHaveBeenCalled();
      expect(replaceState).not.toHaveBeenCalled();
    });

    it('stays visible and renderable for an OWNER of a LAPSED org', () => {
      // Deliberately not gated on `healthy`: this is the one surface that
      // undoes the lapse, so blocking it would leave the owner with CTAs and
      // nowhere for them to lead.
      render('tab=billing', { lapsed: LAPSED });

      expect(tab('billing').getAttribute('aria-pressed')).toBe('true');
      expect(has('team-billing-section')).toBe(true);
    });

    it('renders the attention dot on the Billing subtab when billing needs action', () => {
      render('', { billingNeedsAttention: true });

      const dot = tab('billing').querySelector(
        '[data-testid="team-settings-tab-billing-attention-dot"]',
      );
      expect(dot).not.toBeNull();
      expect(dot?.getAttribute('aria-label')).toBe('Billing needs attention');
    });

    it('is named "AI Credits" with free access on, keeping the billing key and URL', () => {
      render('tab=billing', { freeAccess: true });

      const billing = tab('billing');
      expect(billing.textContent).toBe('AI Credits');
      expect(billing.getAttribute('aria-pressed')).toBe('true');
      expect(has('team-billing-section')).toBe(true);
      // The plan card is the billing section's free-access concern; the
      // subtab only has to hand the mode down.
      expect(has('team-billing-plan-card')).toBe(false);
      expect(mockBillingProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ freeAccess: true }),
      );
      expect(container.textContent).not.toContain('Billing');
    });

    it('keeps the "Billing" name with free access off', () => {
      render('tab=billing', { freeAccess: false });

      expect(tab('billing').textContent).toBe('Billing');
      expect(has('team-billing-plan-card')).toBe(true);
      expect(mockBillingProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ freeAccess: false }),
      );
    });

    it('names the attention dot after the renamed subtab', () => {
      render('', { freeAccess: true, billingNeedsAttention: true });

      const dot = tab('billing').querySelector(
        '[data-testid="team-settings-tab-billing-attention-dot"]',
      );
      expect(dot?.getAttribute('aria-label')).toBe(
        'AI Credits needs attention',
      );
    });

    it('renders no attention dot when billing needs nothing', () => {
      render();

      expect(
        container.querySelector(
          '[data-testid="team-settings-tab-billing-attention-dot"]',
        ),
      ).toBeNull();
    });

    it('drops the one-shot ?plan= intent when switching away from Billing', async () => {
      // `?plan=` is forwarded by `/subscribe` and read by the billing card. If
      // it rode along to Policies it would re-fire against an unrelated subtab.
      render('tab=billing&plan=business');
      await click(tab('policies'));

      expect(replaceState).toHaveBeenCalledWith(
        null,
        '',
        '/organization/org-1/settings?tab=policies',
      );
    });

    it('drops ?plan= when returning to General too', async () => {
      render('tab=billing&plan=business');
      await click(tab('general'));

      expect(replaceState).toHaveBeenCalledWith(
        null,
        '',
        '/organization/org-1/settings',
      );
    });

    it('switches subtabs without pushing a history entry', async () => {
      // Pins the replace-vs-push choice rather than leaving it to a comment.
      // Billing used to be a top-level `Link`, which pushed; as a subtab it
      // deliberately does NOT, so Back leaves the settings page instead of
      // walking back through every subtab the user clicked. Flipping this to
      // `push` is a user-visible change and should fail here first.
      render('');
      await click(tab('billing'));

      expect(replaceState).toHaveBeenCalledWith(
        null,
        '',
        '/organization/org-1/settings?tab=billing',
      );
      expect(mockPush).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });

  describe('without a host subtab slot', () => {
    it('replaces the host route with the merged query and never pushes', async () => {
      // A host that does not own the browser URL (desktop) replaces its own
      // route instead; the subtab still makes no history entry.
      render('', { slots: {} });
      await click(tab('policies'));

      expect(mockReplace).toHaveBeenCalledWith(
        '/organization/org-1/settings?tab=policies',
        { scroll: false },
      );
      expect(mockPush).not.toHaveBeenCalled();
      expect(replaceState).not.toHaveBeenCalled();
      expect(tab('policies').getAttribute('aria-pressed')).toBe('true');
      expect(has('team-enforced-settings-section')).toBe(true);
    });

    it('preserves unrelated query parameters across a switch', async () => {
      render('tab=usage&ref=digest&utm_source=email', { slots: {} });
      await click(tab('integrations'));

      expect(mockReplace).toHaveBeenCalledTimes(1);
      const [href] = mockReplace.mock.calls[0];
      const url = new URL(String(href), 'https://canopy.test');
      expect(url.pathname).toBe('/organization/org-1/settings');
      expect(url.searchParams.get('tab')).toBe('integrations');
      expect(url.searchParams.get('ref')).toBe('digest');
      expect(url.searchParams.get('utm_source')).toBe('email');
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('still drops the one-shot flags and collapses General to a bare path', async () => {
      render('tab=billing&plan=business&github=connected&ref=digest', {
        slots: {},
      });
      await click(tab('general'));

      expect(mockReplace).toHaveBeenCalledWith(
        '/organization/org-1/settings?ref=digest',
        { scroll: false },
      );
    });

    it('keeps the switched tab once the host reflects the replaced query', async () => {
      render('', { slots: {} });
      await click(tab('usage'));
      // The stateful router already rewrote the shared params.
      render('tab=usage', { slots: {} });

      expect(tab('usage').getAttribute('aria-pressed')).toBe('true');
      expect(has('team-subscription-pricing-section')).toBe(true);
    });
  });
});

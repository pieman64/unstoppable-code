/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsStoreProvider } from '@canopy/app-state/settings';
import type {
  SettingsBootstrap,
  SettingsOrganizationBootstrap,
  SettingsRoute,
} from '@canopy/protocol/settings';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
  type FakeSettingsClient,
} from '@canopy/ui-app/settings/__tests__/helpers/test-settings-host';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import type { HostedSettingsAccount } from '../desktop-settings-host-context';
import { HostedSettingsNav } from '../HostedSettingsNav';
import {
  parsePersistedSettingsNavModel,
  persistedSettingsNavModelFrom,
  SETTINGS_NAV_MODEL_STORAGE_PREFIX,
  type PersistedSettingsNavModel,
} from '../hosted-settings-model';

const OWNER_ORG = 'a0000000-0000-4000-8000-000000000002';

let mockAccount: HostedSettingsAccount = {
  status: 'signed_in',
  accountId: 'acct-1',
};
// As the desktop host does: the account's entry in renderer storage.
jest.mock('../desktop-settings-host-context', () => ({
  useHostedSettingsAccount: (): HostedSettingsAccount => mockAccount,
  useHostedSettingsPersistedNavModel: (): PersistedSettingsNavModel | null =>
    mockAccount.status === 'signed_in'
      ? parsePersistedSettingsNavModel(
          window.localStorage.getItem(
            `${SETTINGS_NAV_MODEL_STORAGE_PREFIX}${mockAccount.accountId}`,
          ),
          mockAccount.accountId,
        )
      : null,
}));

function organizationBootstrap(
  visibleTabs: SettingsOrganizationBootstrap['visibleTabs'],
): SettingsOrganizationBootstrap {
  return {
    id: OWNER_ORG,
    name: 'Northwind',
    viewerRole: 'OWNER',
    isPersonal: false,
    visibleTabs,
    disabledTabs: [],
    billingNeedsAttention: false,
    billingEnabled: true,
    memoryEnabled: true,
    digestsEnabled: true,
    projectsEnabled: true,
    canViewUsageStats: true,
    freeAccess: false,
    lapse: null,
  };
}

function bootstrap(
  overrides: Partial<SettingsBootstrap['account']> = {},
  organization: SettingsOrganizationBootstrap | null = null,
): SettingsBootstrap {
  return {
    version: 1,
    viewer: { id: 'acct-1', email: 'viewer@example.test', name: 'Viewer' },
    account: {
      billingEnabled: true,
      digestsEnabled: true,
      integrationsEnabled: false,
      freeAccess: false,
      ...overrides,
    },
    organizations: [
      { id: OWNER_ORG, name: 'Northwind', role: 'OWNER', isPersonal: false },
    ],
    organization,
  };
}

function persist(accountId: string, value: unknown): void {
  window.localStorage.setItem(
    `${SETTINGS_NAV_MODEL_STORAGE_PREFIX}${accountId}`,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

/** A bootstrap read that resolves when the test says so. */
function pendingBootstrap(): {
  readonly handler: () => Promise<SettingsBootstrap>;
  resolve(value: SettingsBootstrap): void;
} {
  const waiting: Array<(value: SettingsBootstrap) => void> = [];
  return {
    handler: () =>
      new Promise<SettingsBootstrap>((resolve) => {
        waiting.push(resolve);
      }),
    resolve(value): void {
      waiting.splice(0).forEach((resolve) => resolve(value));
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let client: FakeSettingsClient;

async function render(
  options: {
    readonly initialBootstraps?: Readonly<Record<string, SettingsBootstrap>>;
    readonly initialRoute?: SettingsRoute | null;
  } = {},
): Promise<void> {
  const { host } = createTestSettingsHost({
    client,
    privacy: { blockClassName: 'ph-no-capture', maskClassName: 'ph-mask' },
  });
  act(() => {
    root.render(
      <TestSettingsHost host={host}>
        <SettingsStoreProvider
          client={client}
          accountId="acct-1"
          initialBootstraps={options.initialBootstraps}
          initialRoute={options.initialRoute}
        >
          <nav>
            <HostedSettingsNav
              open
              appGroup={<div data-testid="app-group" />}
              trailingGroups={<div data-testid="trailing-groups" />}
            />
          </nav>
        </SettingsStoreProvider>
      </TestSettingsHost>,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function railOrder(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-testid^="settings-nav-group-"], [data-testid="app-group"], [data-testid="trailing-groups"]',
    ),
  ).map((element) => element.dataset.testid ?? '');
}

/** Every hosted rail row id, in order. */
function hostedRowIds(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-testid^="settings-nav-group-"] [data-sidebar-nav-row]',
    ),
  ).map((row) => row.dataset.testid ?? '');
}

/** Records the hosted row ids after every change to the rail. */
function recordRowIds(): { readonly seen: string[][]; stop(): void } {
  const seen: string[][] = [hostedRowIds()];
  const observer = new MutationObserver(() => {
    const ids = hostedRowIds();
    if (JSON.stringify(ids) !== JSON.stringify(seen.at(-1))) seen.push(ids);
  });
  observer.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
  });
  return { seen, stop: () => observer.disconnect() };
}

const ROWS_WITH_BILLING_AND_DIGESTS = [
  'settings-nav-account-account',
  'settings-nav-account-profile',
  'settings-nav-account-digests',
  'settings-nav-account-notifications',
  'settings-nav-account-integrations',
  'settings-nav-account-security',
  'settings-nav-account-billing',
];

const ROWS_WITHOUT_FLAGGED = [
  'settings-nav-account-account',
  'settings-nav-account-profile',
  'settings-nav-account-notifications',
  'settings-nav-account-integrations',
  'settings-nav-account-security',
];

function selectedRows(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[aria-current="page"]'),
  ).map((row) => row.dataset.testid ?? '');
}

const realIsEnabled = useFeatureFlagsStore.getState().isEnabled;
let enabledFlags = new Set<string>();

beforeEach(() => {
  mockAccount = { status: 'signed_in', accountId: 'acct-1' };
  window.localStorage.clear();
  enabledFlags = new Set();
  useFeatureFlagsStore.setState({
    isEnabled: (key) => enabledFlags.has(key),
  });
  client = createFakeSettingsClient({
    'settings.bootstrap': () => bootstrap(),
  });
  useNavigationStore.getState().closeSettings();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useFeatureFlagsStore.setState({ isEnabled: realIsEnabled });
});

describe('HostedSettingsNav', () => {
  it('renders the scope picker and its account rows, then the app group, then the trailing groups', async () => {
    await render();
    expect(railOrder()).toEqual([
      'settings-nav-group-account',
      'app-group',
      'trailing-groups',
    ]);
    const picker = container.querySelector(
      '[data-testid="settings-nav-scope-picker"]',
    );
    expect(picker).toBeInstanceOf(HTMLElement);
    expect(
      picker?.compareDocumentPosition(
        container.querySelector('[data-testid="settings-nav-group-account"]') ??
          document,
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      container.querySelector('[data-testid="settings-nav-scope-title"]')
        ?.textContent,
    ).toBe('Viewer');
    // The account scope shows a person's name: replay blocks it, and no
    // title attribute repeats it.
    const title = container.querySelector(
      '[data-testid="settings-nav-scope-title"]',
    );
    expect(title?.classList.contains('ph-no-capture')).toBe(true);
    expect(title?.classList.contains('ph-mask')).toBe(false);
    expect(title?.hasAttribute('title')).toBe(false);
  });

  it('fetches the bootstrap once for both group lists', async () => {
    await render();
    expect(
      client.calls.filter((call) => call.operation === 'settings.bootstrap'),
    ).toHaveLength(1);
  });

  it('lists Integrations even when the server reports it disabled', async () => {
    await render();
    expect(
      container.querySelector(
        '[data-testid="settings-nav-account-integrations"]',
      ),
    ).not.toBeNull();
  });

  it('selects the current row in the Account group', async () => {
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'account', page: 'security' });
    await render();
    expect(selectedRows()).toEqual(['settings-nav-account-security']);
  });

  it('selects no row on the Organizations list, which the scope menu opens', async () => {
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'organizations' });
    await render();
    expect(selectedRows()).toEqual([]);
  });

  it('fetches nothing while signed out', async () => {
    mockAccount = { status: 'signed_out' };
    await render();
    expect(client.calls).toEqual([]);
    expect(railOrder()).toEqual([
      'settings-nav-group-account',
      'app-group',
      'trailing-groups',
    ]);
    // No account or organization to switch between.
    expect(
      container.querySelector('[data-testid="settings-nav-scope-picker"]'),
    ).toBeNull();
  });

  describe('before the bootstrap resolves', () => {
    it('draws the rows from an earlier open, then reads the bootstrap again', async () => {
      const pending = pendingBootstrap();
      client = createFakeSettingsClient({
        'settings.bootstrap': pending.handler,
      });
      await render({ initialBootstraps: { '': bootstrap() } });
      expect(hostedRowIds()).toEqual(ROWS_WITH_BILLING_AND_DIGESTS);
      expect(
        client.calls.filter((call) => call.operation === 'settings.bootstrap'),
      ).toHaveLength(1);
      await act(async () => {
        pending.resolve(bootstrap());
        await Promise.resolve();
      });
      expect(hostedRowIds()).toEqual(ROWS_WITH_BILLING_AND_DIGESTS);
    });

    it('draws the persisted rows', async () => {
      persist(
        'acct-1',
        persistedSettingsNavModelFrom('acct-1', bootstrap(), null),
      );
      client = createFakeSettingsClient({
        'settings.bootstrap': pendingBootstrap().handler,
      });
      await render();
      expect(hostedRowIds()).toEqual(ROWS_WITH_BILLING_AND_DIGESTS);
    });

    it('draws the flag snapshot when nothing is remembered', async () => {
      enabledFlags = new Set([
        'canopy-billing-enabled',
        'canopy-digests-enabled',
        'canopy-free-access-enabled',
      ]);
      client = createFakeSettingsClient({
        'settings.bootstrap': pendingBootstrap().handler,
      });
      await render();
      expect(hostedRowIds()).toEqual(ROWS_WITH_BILLING_AND_DIGESTS);
      // Free access names Billing "AI Credits" from the first paint.
      expect(
        container.querySelector('[data-testid="settings-nav-account-billing"]')
          ?.textContent,
      ).toBe('AI Credits');
    });

    it('ignores a corrupt entry and draws the flag snapshot', async () => {
      persist('acct-1', '{"accountId":"acct-1","account":');
      client = createFakeSettingsClient({
        'settings.bootstrap': pendingBootstrap().handler,
      });
      await render();
      expect(hostedRowIds()).toEqual(ROWS_WITHOUT_FLAGGED);
    });

    it("ignores another account's entry", async () => {
      persist(
        'acct-1',
        persistedSettingsNavModelFrom('acct-2', bootstrap(), null),
      );
      client = createFakeSettingsClient({
        'settings.bootstrap': pendingBootstrap().handler,
      });
      await render();
      expect(hostedRowIds()).toEqual(ROWS_WITHOUT_FLAGGED);
    });

    it('replaces the remembered rows with the server\u2019s in one step', async () => {
      persist(
        'acct-1',
        persistedSettingsNavModelFrom('acct-1', bootstrap(), null),
      );
      const pending = pendingBootstrap();
      client = createFakeSettingsClient({
        'settings.bootstrap': pending.handler,
      });
      await render();
      const recording = recordRowIds();
      await act(async () => {
        pending.resolve(
          bootstrap({ billingEnabled: false, digestsEnabled: false }),
        );
        await Promise.resolve();
      });
      recording.stop();
      expect(recording.seen).toEqual([
        ROWS_WITH_BILLING_AND_DIGESTS,
        ROWS_WITHOUT_FLAGGED,
      ]);
    });

    it('draws a deep-linked organization from its persisted tabs, with one organization read', async () => {
      persist(
        'acct-1',
        persistedSettingsNavModelFrom(
          'acct-1',
          bootstrap({}, organizationBootstrap(['feed', 'members', 'settings'])),
          null,
        ),
      );
      const pending = pendingBootstrap();
      client = createFakeSettingsClient({
        'settings.bootstrap': pending.handler,
      });
      const route: SettingsRoute = {
        scope: 'organization',
        organizationId: OWNER_ORG,
        page: 'members',
      };
      useNavigationStore.getState().openAccountOrganizationSettings(route);
      await render({ initialRoute: route });
      // The organization scope: its Settings pages split around Members,
      // then its activity.
      const organizationRows = [
        'settings-nav-organization-settings-general',
        'settings-nav-organization-members',
        'settings-nav-organization-settings-policies',
        'settings-nav-organization-settings-integrations',
        'settings-nav-organization-settings-usage',
        'settings-nav-organization-settings-billing',
        'settings-nav-organization-feed',
      ];
      expect(hostedRowIds()).toEqual(organizationRows);
      expect(
        client.calls
          .filter((call) => call.operation === 'settings.bootstrap')
          .map((call) => call.input),
      ).toEqual([{ organizationId: OWNER_ORG }]);
      await act(async () => {
        pending.resolve(
          bootstrap({}, organizationBootstrap(['feed', 'members', 'settings'])),
        );
        await Promise.resolve();
      });
      expect(hostedRowIds()).toEqual(organizationRows);
      const title = container.querySelector(
        '[data-testid="settings-nav-scope-title"]',
      );
      expect(title?.textContent).toBe('Northwind');
      // Organization names are user-authored: replay masks them.
      expect(title?.classList.contains('ph-mask')).toBe(true);
      expect(title?.classList.contains('ph-no-capture')).toBe(false);
    });

    it('shows app-wide settings only in Personal', async () => {
      client = createFakeSettingsClient({
        'settings.bootstrap': () =>
          Promise.resolve(
            bootstrap({}, organizationBootstrap(['members', 'settings'])),
          ),
      });
      const route: SettingsRoute = {
        scope: 'organization',
        organizationId: OWNER_ORG,
        page: 'members',
      };
      useNavigationStore.getState().openAccountOrganizationSettings(route);
      await render({ initialRoute: route });
      expect(container.querySelector('[data-testid="app-group"]')).toBeNull();
      expect(
        container.querySelector('[data-testid="trailing-groups"]'),
      ).toBeNull();
      act(() => useNavigationStore.getState().openSettings('display'));
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="app-group"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="trailing-groups"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="settings-nav-scope-picker"]')
          ?.textContent,
      ).not.toContain('Northwind');
    });

    it('shows no organization group on a plain open', async () => {
      persist(
        'acct-1',
        persistedSettingsNavModelFrom(
          'acct-1',
          bootstrap({}, organizationBootstrap(['feed'])),
          null,
        ),
      );
      client = createFakeSettingsClient({
        'settings.bootstrap': pendingBootstrap().handler,
      });
      await render();
      expect(
        container.querySelector(
          '[data-testid="settings-nav-group-organization"]',
        ),
      ).toBeNull();
    });

    it('draws no skeleton rows', async () => {
      client = createFakeSettingsClient({
        'settings.bootstrap': pendingBootstrap().handler,
      });
      await render();
      expect(
        container.querySelector(
          '[data-testid*="skeleton"], [aria-busy="true"]',
        ),
      ).toBeNull();
    });
  });
});

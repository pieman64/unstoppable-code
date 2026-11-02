/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, useEffect, useState, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  SettingsOperationError,
  settingsRouteToPath,
  type SettingsBootstrap,
  type SettingsOrganizationBootstrap,
  type SettingsRoute,
} from '@canopy/protocol/settings';
import type * as ProtocolSettingsModule from '@canopy/protocol/settings';
import type * as HostedPagesModule from '@canopy/ui-app/settings/pages';
import type * as SettingsPageNoticeModule from '@canopy/ui-app/settings/layout/settings-page-notice';
import type * as SettingsHostModule from '@canopy/ui-app/settings/host';
import type * as AppStateModule from '@canopy/app-state';
import type * as ZustandModule from 'zustand';
import type * as OrganizationSettingsSlotsModule from '@canopy/ui-app/settings/organization/organization-settings-slots';
import {
  createFakeSettingsClient,
  type FakeSettingsClient,
} from '@canopy/ui-app/settings/__tests__/helpers/test-settings-host';
import { brandText } from '@/lib/brand';
import { useNavigationStore } from '@/stores/navigationStore';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { SettingsOverlay } from '../SettingsOverlay';

const ACCOUNT_ID = 'acct-hosted-1';
const OTHER_ACCOUNT_ID = 'acct-hosted-2';
const WEB_ORIGIN = 'https://app.example.test';
const OWNER_ORG = 'a0000000-0000-4000-8000-000000000002';
const STRANGER_ORG = 'a0000000-0000-4000-8000-000000000009';

let mockClient: FakeSettingsClient | null = null;
jest.mock('@/client/hosted-settings-client-registry', () => ({
  registeredHostedSettingsClient: (): FakeSettingsClient | null => mockClient,
  registerHostedSettingsCanopyClient: (): void => undefined,
}));

// The app renders Settings inside its client provider; the hosted host only
// reads the org projects store for the Projects page's local setup slot.
jest.mock('@canopy/app-state', () => {
  const actual = jest.requireActual<typeof AppStateModule>('@canopy/app-state');
  const zustand = jest.requireActual<typeof ZustandModule>('zustand');
  const orgProjectsStore = zustand.create(() => ({ setupProgress: {} }));
  return {
    ...actual,
    useOrgProjectsStoreApi: (): typeof orgProjectsStore => orgProjectsStore,
  };
});

// The shared pages are other modules' concern; a stub shows which route the
// overlay asked for and exercises the host's link through `SettingsLink`.
jest.mock('@canopy/ui-app/settings/pages', (): typeof HostedPagesModule => {
  const actual: typeof HostedPagesModule = jest.requireActual(
    '@canopy/ui-app/settings/pages',
  );
  const host: typeof SettingsHostModule = jest.requireActual(
    '@canopy/ui-app/settings/host',
  );
  const organizationSlots: typeof OrganizationSettingsSlotsModule =
    jest.requireActual(
      '@canopy/ui-app/settings/organization/organization-settings-slots',
    );
  const pageNotice: typeof SettingsPageNoticeModule = jest.requireActual(
    '@canopy/ui-app/settings/layout/settings-page-notice',
  );
  const HostedPageStub = ({
    route,
    accountFrameAfter,
    renderFrame,
  }: {
    route: SettingsRoute;
    accountFrameAfter?: ReactNode;
    renderFrame?: (route: SettingsRoute, content: ReactNode) => ReactNode;
  }): JSX.Element => {
    const { settingsRouteToPath: toPath } = jest.requireActual<
      typeof ProtocolSettingsModule
    >('@canopy/protocol/settings');
    const { PromotionDialog } =
      organizationSlots.useOrganizationSettingsSlots();
    const page = (
      <div
        data-testid="hosted-page-stub"
        data-path={toPath(route)}
        data-promotion-dialog={String(PromotionDialog !== undefined)}
      >
        <host.SettingsLink
          href="/account/security?tab=keys#api"
          data-testid="stub-internal-link"
        >
          Security
        </host.SettingsLink>
        <host.SettingsLink href="/pricing" data-testid="stub-web-link">
          Pricing
        </host.SettingsLink>
        {/* Pages render the host's notice below their header. */}
        <pageNotice.SettingsPageNotice />
        {accountFrameAfter}
      </div>
    );
    // The host's frame wraps the page it shows, as the shared page does.
    return <>{renderFrame === undefined ? page : renderFrame(route, page)}</>;
  };
  return {
    ...actual,
    HostedSettingsPage: HostedPageStub,
    HostedSettingsPageContent: HostedPageStub,
  };
});

jest.mock('../CanopyTab', () => ({
  CanopyTab: (): JSX.Element => <div data-testid="canopy-tab" />,
}));
jest.mock('../GitTab', () => ({
  GitTab: (): JSX.Element => <div data-testid="git-tab" />,
}));
jest.mock('../AccountTab', () => ({
  AccountTab: (): JSX.Element => <div data-testid="account-tab" />,
}));
jest.mock('../NotificationsTab', () => ({
  NotificationsTab: (): JSX.Element => <div data-testid="notifications-tab" />,
}));

/**
 * The device sections read `window.api` and have their own suite; the stub
 * marks where they mount. Integrations mounts its Linear field late, like
 * the real row under still-loading shared content.
 */
function DeviceSettingsStub({ page }: { page: string }): JSX.Element {
  const [linearMounted, setLinearMounted] = useState(false);
  useEffect(() => {
    if (page !== 'integrations') return undefined;
    const timer = window.setTimeout(() => setLinearMounted(true), 200);
    return (): void => window.clearTimeout(timer);
  }, [page]);
  return (
    <section data-testid={`account-device-settings-${page}`}>
      {linearMounted ? (
        <input data-testid="settings-linear-token-input" />
      ) : null}
    </section>
  );
}
jest.mock('../hosted/AccountDeviceSettings', () => ({
  AccountDeviceSettings: ({ page }: { page: string }): JSX.Element | null =>
    ['account', 'profile', 'notifications', 'integrations'].includes(page) ? (
      <DeviceSettingsStub page={page} />
    ) : null,
}));
jest.mock('@/hooks/useCodeGraphExperimentEnabled', () => ({
  useCodeGraphExperimentEnabled: (): boolean => true,
}));
jest.mock('@/lib/claude-settings-availability', () => ({
  useClaudeSettingsAvailable: (): boolean => true,
}));
// Only the hosted settings rollout flag is on, plus free access when a test
// turns it on.
let mockFreeAccessFlag = false;
jest.mock('@/stores/featureFlagsStore', () => {
  const state = {
    isEnabled: (key: string): boolean =>
      key === 'canopy-desktop-hosted-settings' ||
      (key === 'canopy-free-access-enabled' && mockFreeAccessFlag),
  };
  return {
    useFeatureFlagsStore: Object.assign(
      (selector: (current: typeof state) => boolean): boolean =>
        selector(state),
      { getState: (): typeof state => state },
    ),
  };
});

function organizationBootstrap(): SettingsOrganizationBootstrap {
  return {
    id: OWNER_ORG,
    name: 'Northwind Labs',
    viewerRole: 'OWNER',
    isPersonal: false,
    visibleTabs: ['feed', 'members', 'groups', 'projects', 'settings'],
    disabledTabs: [],
    billingNeedsAttention: false,
    billingEnabled: true,
    memoryEnabled: false,
    digestsEnabled: false,
    projectsEnabled: true,
    canViewUsageStats: false,
    freeAccess: false,
    lapse: null,
  };
}

let integrationsEnabled = true;
let bootstrapFreeAccess = false;

function bootstrapFor(input: unknown): SettingsBootstrap {
  const organizationId =
    typeof input === 'object' && input !== null && 'organizationId' in input
      ? input.organizationId
      : undefined;
  return {
    version: 1,
    viewer: { id: ACCOUNT_ID, email: 'viewer@example.test', name: 'Viewer' },
    account: {
      billingEnabled: true,
      digestsEnabled: true,
      integrationsEnabled,
      freeAccess: bootstrapFreeAccess,
    },
    organizations: [
      {
        id: OWNER_ORG,
        name: 'Northwind Labs',
        role: 'OWNER',
        isPersonal: false,
      },
    ],
    organization: organizationId === OWNER_ORG ? organizationBootstrap() : null,
  };
}

let accountId: string | null = ACCOUNT_ID;
let guest = false;
/** When set, account reads wait for it, as right after an app launch. */
let accountReadGate: Promise<void> | null = null;
let openRequestListener: ((route: SettingsRoute) => void) | null = null;
const openExternal = jest.fn((): Promise<void> => Promise.resolve());
const openAuthenticatedPortalPage = jest.fn(
  (): Promise<unknown> => Promise.resolve({ ok: true }),
);

function installApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadCanopyCloudAccount: (): Promise<unknown> =>
        (accountReadGate ?? Promise.resolve()).then(() =>
          accountId === null
            ? { hasApiKey: false, read: 'ok' }
            : {
                hasApiKey: true,
                read: 'ok',
                ...(guest
                  ? { credentialSource: 'guest', authMode: 'guest' }
                  : {}),
                account: {
                  id: accountId,
                  email: 'viewer@example.test',
                  name: 'Viewer',
                },
              },
        ),
      getCanopyCloudBaseUrl: (): Promise<string> =>
        Promise.resolve(`${WEB_ORIGIN}/`),
      openAuthenticatedPortalPage,
      browser: { openExternal },
      accountOrganizationSettings: {
        onOpenRequest: (
          listener: (route: SettingsRoute) => void,
        ): (() => void) => {
          openRequestListener = listener;
          return (): void => {
            openRequestListener = null;
          };
        },
        paymentHandoffAvailability: (): Promise<unknown> =>
          Promise.resolve({ available: false }),
      },
    },
  });
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function render(open = true): void {
  act(() => {
    root.render(
      <SettingsOverlay
        open={open}
        onClose={jest.fn()}
        initialSection={useNavigationStore.getState().settingsInitialSection}
      />,
    );
  });
}

function query(testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function selectedRows(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-sidebar-nav-row]'),
  )
    .filter((row) => row.className.split(/\s+/).includes('bg-muted'))
    .map((row) => row.dataset.testid ?? '');
}

function click(testId: string): void {
  act(() => {
    query(testId)?.click();
  });
}

beforeEach(() => {
  accountId = ACCOUNT_ID;
  guest = false;
  accountReadGate = null;
  integrationsEnabled = true;
  bootstrapFreeAccess = false;
  mockFreeAccessFlag = false;
  openExternal.mockClear();
  openAuthenticatedPortalPage.mockClear();
  // Each test starts without a remembered rail.
  window.localStorage.clear();
  mockClient = createFakeSettingsClient({
    'settings.bootstrap': bootstrapFor,
  });
  installApi();
  useRemoteControlStore.setState({ context: { mode: 'local' } });
  useNavigationStore.getState().closeSettings();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, 'api');
});

describe('SettingsOverlay hosted account and organization settings', () => {
  it('renders the scope picker and Account, then the app group, then the local groups', async () => {
    useNavigationStore.getState().openSettings();
    render();
    await flush();

    const groups = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid^="settings-nav-group-"]',
      ),
    ).map((group) => group.dataset.testid);
    expect(groups).toEqual([
      'settings-nav-group-account',
      'settings-nav-group-personal',
      'settings-nav-group-agents',
      'settings-nav-group-integrations',
      'settings-nav-group-workflow',
      'settings-nav-group-advanced',
    ]);
    const personal = query('settings-nav-group-personal');
    const personalHeading = personal?.getAttribute('aria-labelledby');
    expect(
      personalHeading
        ? container.querySelector(`[id="${personalHeading}"]`)?.textContent
        : null,
    ).toBe(brandText.appName);
    expect(query('settings-nav-account-account')).not.toBeNull();
    expect(query('settings-nav-scope-picker')).toBeInstanceOf(HTMLElement);
    expect(query('settings-nav-organizations-list')).toBeNull();
    // Local rows keep their ids; Accounts is Providers, first in Agents.
    expect(query('settings-nav-account')?.textContent).toBe('Providers');
    expect(
      query('settings-nav-group-agents')
        ?.querySelector('[data-sidebar-nav-row]')
        ?.getAttribute('data-testid'),
    ).toBe('settings-nav-account');
    expect(query('settings-nav-notifications')).toBeNull();
    expect(query('settings-nav-canopy')).not.toBeNull();
    expect(query('canopy-tab')).not.toBeNull();
    expect(selectedRows()).toEqual(['settings-nav-canopy']);
  });

  it('does not preselect the workspace-context organization', async () => {
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'organization', organizationId: OWNER_ORG },
        revision: 1,
        organizations: [],
      },
    });
    useNavigationStore.getState().openSettings();
    render();
    await flush();
    expect(query('settings-nav-group-organization')).toBeNull();
  });

  it('shows the organization scope after picking it and selects exactly one row', async () => {
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'organizations' });
    render();
    await flush();
    // The list is opened from the scope menu; no rail row stands for it.
    expect(selectedRows()).toEqual([]);
    expect(query('settings-nav-group-organization')).toBeNull();

    act(() => {
      useNavigationStore.getState().openAccountOrganizationSettings({
        scope: 'organization',
        organizationId: OWNER_ORG,
        page: 'feed',
      });
    });
    await flush();
    // The scope picker names the organization; its name is user-authored,
    // so replay masks it.
    const scopeTitle = query('settings-nav-scope-title');
    expect(scopeTitle?.textContent).toBe('Northwind Labs');
    expect(scopeTitle?.classList.contains(POSTHOG_REPLAY_MASK_CLASS)).toBe(
      true,
    );
    expect(query('settings-nav-group-organization')).toBeInstanceOf(
      HTMLElement,
    );
    expect(query('settings-nav-account-account')).toBeNull();
    expect(query('settings-nav-organization-members')).not.toBeNull();
    expect(query('settings-nav-organization-statistics')).toBeNull();
    expect(selectedRows()).toEqual(['settings-nav-organization-feed']);
    expect(query('hosted-page-stub')?.dataset.path).toBe(
      `/organization/${OWNER_ORG}`,
    );
    // The feed is blocked whole in session replay; the rail stays recorded.
    expect(
      query('hosted-settings-content')?.classList.contains(
        POSTHOG_REPLAY_BLOCK_CLASS,
      ),
    ).toBe(true);
    expect(
      query('settings-nav-group-organization')?.closest(
        `.${POSTHOG_REPLAY_BLOCK_CLASS}`,
      ),
    ).toBeNull();

    // App-wide pages only appear after returning to Personal.
    expect(query('settings-nav-git')).toBeNull();
    click('settings-nav-scope-picker');
    // The menu portals to the document body.
    act(() => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="settings-nav-scope-option-account"]',
        )
        ?.click();
    });
    await flush();
    expect(useNavigationStore.getState().settingsHostedLocation?.route).toEqual(
      { scope: 'account', page: 'account' },
    );
    expect(selectedRows()).toEqual(['settings-nav-account-account']);

    click('settings-nav-git');
    await flush();
    expect(useNavigationStore.getState().settingsHostedLocation).toBeNull();
    expect(selectedRows()).toEqual(['settings-nav-git']);
    expect(query('git-tab')).not.toBeNull();
    expect(query('settings-nav-group-organization')).toBeNull();

    // A hosted row navigates inside the overlay.
    click('settings-nav-account-security');
    await flush();
    expect(useNavigationStore.getState().settingsHostedLocation?.route).toEqual(
      { scope: 'account', page: 'security' },
    );
    expect(selectedRows()).toEqual(['settings-nav-account-security']);
  });

  it('keeps settings links inside Settings and opens other web paths signed in', async () => {
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'account', page: 'account' });
    render();
    await flush();

    expect(
      query('hosted-settings-content')?.classList.contains(
        POSTHOG_REPLAY_BLOCK_CLASS,
      ),
    ).toBe(false);
    click('stub-internal-link');
    expect(useNavigationStore.getState().settingsHostedLocation).toEqual({
      route: { scope: 'account', page: 'security' },
      search: 'tab=keys',
      hash: 'api',
    });
    expect(openExternal).not.toHaveBeenCalled();

    await flush();
    click('stub-web-link');
    await flush();
    // CAN-4693: a same-origin web page opens through the strict signed-in
    // request, never as a bare signed-out browser page.
    expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith({
      requireAuthentication: true,
      kind: 'signed-in',
      path: '/pricing',
      accountId: ACCOUNT_ID,
      webOrigin: WEB_ORIGIN,
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().settingsHostedLocation?.route).toEqual(
      { scope: 'account', page: 'security' },
    );
  });

  it('supplies the in-place Personal-to-team promotion to the shared pages', async () => {
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'organizations' });
    render();
    await flush();
    expect(
      query('hosted-page-stub')?.getAttribute('data-promotion-dialog'),
    ).toBe('true');
  });

  it('opens the Organizations list with the access-lost notice for a non-member deep link', async () => {
    useNavigationStore.getState().openAccountOrganizationSettings({
      scope: 'organization',
      organizationId: STRANGER_ORG,
      page: 'feed',
    });
    render();
    await flush();
    expect(useNavigationStore.getState().settingsHostedLocation).toEqual({
      route: { scope: 'organizations' },
      search: '',
      hash: '',
      notice: 'access-lost',
    });
    expect(query('hosted-settings-access-lost')).not.toBeNull();
    expect(query('settings-nav-group-organization')).toBeNull();
    expect(query('hosted-page-stub')?.dataset.path).toBe(
      settingsRouteToPath({ scope: 'organizations' }),
    );
  });

  it('shows the unsupported-server state while local panels keep working', async () => {
    mockClient = createFakeSettingsClient({
      'settings.bootstrap': () => {
        throw new SettingsOperationError({ code: 'unsupported_server' });
      },
    });
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'account', page: 'account' });
    render();
    await flush();
    expect(query('hosted-settings-unsupported')).not.toBeNull();
    expect(query('hosted-page-stub')).toBeNull();
    // This computer's sections stay usable under the blocking error.
    expect(query('hosted-settings-frame')?.dataset.hostedSettingsState).toBe(
      'error',
    );
    expect(
      query('hosted-settings-frame')?.contains(
        query('account-device-settings-account'),
      ),
    ).toBe(true);
    // The rail still renders, and local panels still open.
    expect(query('settings-nav-group-account')).not.toBeNull();
    click('settings-nav-canopy');
    await flush();
    expect(query('canopy-tab')).not.toBeNull();
  });

  it('shows only the device sign-in on Account while signed out', async () => {
    accountId = null;
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'account', page: 'account' });
    render();
    await flush();
    const frame = query('hosted-settings-frame');
    expect(frame?.dataset.hostedSettingsState).toBe('signed_out');
    expect(frame?.querySelector('main')).not.toBeNull();
    expect(
      frame?.querySelector('[data-testid="account-device-settings-account"]'),
    ).not.toBeNull();
    // The device card is the sign-in; no second sign-in prompt.
    expect(query('hosted-settings-signed-out')).toBeNull();
    expect(query('hosted-settings-content')).toBeNull();
    expect(query('settings-nav-group-account')).not.toBeNull();
    expect(query('settings-nav-scope-picker')).toBeNull();
    expect(mockClient?.calls).toEqual([]);
  });

  it.each(['notifications', 'integrations'] as const)(
    'shows only the device sections on %s while signed out',
    async (page) => {
      accountId = null;
      useNavigationStore
        .getState()
        .openAccountOrganizationSettings({ scope: 'account', page });
      render();
      await flush();
      expect(query('hosted-settings-frame')?.dataset.hostedSettingsState).toBe(
        'signed_out',
      );
      expect(query(`account-device-settings-${page}`)).not.toBeNull();
      // This computer's sections lead the page; no sign-in prompt above them.
      expect(query('hosted-settings-signed-out')).toBeNull();
      expect(mockClient?.calls).toEqual([]);
    },
  );

  it('shows the signed-out state on Security, which has no device sections', async () => {
    accountId = null;
    useNavigationStore.getState().openAccountOrganizationSettings({
      scope: 'account',
      page: 'security',
    });
    render();
    await flush();
    expect(query('hosted-settings-frame')?.dataset.hostedSettingsState).toBe(
      'signed_out',
    );
    expect(query('hosted-settings-signed-out')).not.toBeNull();
    expect(query('account-device-settings-security')).toBeNull();
    expect(mockClient?.calls).toEqual([]);

    // Sign in goes to the device sign-in card, never out of the app.
    const signIn = query('hosted-settings-signed-out')?.querySelector('button');
    act(() => {
      signIn?.click();
    });
    await flush();
    expect(useNavigationStore.getState().settingsHostedLocation?.route).toEqual(
      { scope: 'account', page: 'account' },
    );
    expect(openExternal).not.toHaveBeenCalled();
    expect(query('account-device-settings-account')).not.toBeNull();
  });

  it('treats a guest as signed out: the device sign-in, no settings calls', async () => {
    // The web settings API refuses guests, so a guest gets the device card
    // rather than shared pages it could not load.
    guest = true;
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'account', page: 'account' });
    render();
    await flush();
    expect(query('hosted-settings-frame')?.dataset.hostedSettingsState).toBe(
      'signed_out',
    );
    expect(query('account-device-settings-account')).not.toBeNull();
    expect(query('hosted-settings-content')).toBeNull();
    expect(mockClient?.calls).toEqual([]);
  });

  it('renders the shared page with the device sections when ready', async () => {
    useNavigationStore.getState().openAccountOrganizationSettings({
      scope: 'account',
      page: 'notifications',
    });
    render();
    await flush();
    const content = query('hosted-settings-content');
    expect(content?.dataset.hostedSettingsPage).toBe('account/notifications');
    // One account frame holds the shared page with this computer's sections
    // after it, as it did while the page loaded.
    const main = content?.querySelector('main');
    expect(main?.contains(query('hosted-page-stub'))).toBe(true);
    expect(main?.contains(query('account-device-settings-notifications'))).toBe(
      true,
    );
    expect(query('hosted-settings-frame')).toBeNull();
  });

  it('keeps one account frame and header from loading to ready', async () => {
    // Free access comes from the flag snapshot until the bootstrap says, so
    // the Billing page's title never flips to "AI Credits" on load.
    mockFreeAccessFlag = true;
    bootstrapFreeAccess = true;
    let resolveBootstrap: () => void = () => {};
    mockClient = createFakeSettingsClient({
      'settings.bootstrap': (input: unknown) =>
        new Promise<SettingsBootstrap>((resolve) => {
          resolveBootstrap = (): void => resolve(bootstrapFor(input));
        }),
    });
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'account', page: 'billing' });
    render();
    await flush();

    const frame = query('hosted-settings-frame');
    expect(frame?.dataset.hostedSettingsState).toBe('loading');
    const main = frame?.querySelector('main');
    const title = query('page-header-title');
    expect(title?.textContent).toBe('AI Credits');
    // The body is the page's skeleton, never loading copy.
    expect(
      main?.querySelector(
        '[data-testid="account-settings-body"] [data-testid="settings-skeleton-cards"]',
      ),
    ).not.toBeNull();
    expect(frame?.textContent).not.toContain('Loading account settings');

    resolveBootstrap();
    await flush();

    const content = query('hosted-settings-content');
    expect(content).toBe(frame);
    expect(content?.dataset.hostedSettingsState).toBeUndefined();
    expect(content?.querySelector('main')).toBe(main);
    expect(query('page-header-title')).toBe(title);
    expect(title?.textContent).toBe('AI Credits');
    expect(main?.contains(query('hosted-page-stub'))).toBe(true);
    expect(query('settings-skeleton-cards')).toBeNull();
  });

  describe('the rail before the bootstrap resolves', () => {
    const NAV_MODEL_KEY = `canopy:settings:nav-model:${ACCOUNT_ID}`;

    function hostedRowIds(): string[] {
      return Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-testid^="settings-nav-group-"] [data-sidebar-nav-row]',
        ),
      )
        .map((row) => row.dataset.testid ?? '')
        .filter(
          (id) =>
            id.startsWith('settings-nav-account-') ||
            id.startsWith('settings-nav-organization'),
        );
    }

    /** Bootstrap reads that wait while `held` is set. */
    function holdableClient(): {
      hold(): void;
      release(): void;
    } {
      let held = false;
      const waiting: Array<() => void> = [];
      mockClient = createFakeSettingsClient({
        'settings.bootstrap': (input: unknown) =>
          held
            ? new Promise<SettingsBootstrap>((resolve) => {
                waiting.push(() => resolve(bootstrapFor(input)));
              })
            : Promise.resolve(bootstrapFor(input)),
      });
      return {
        hold: (): void => {
          held = true;
        },
        release: (): void => {
          held = false;
          waiting.splice(0).forEach((resolve) => resolve());
        },
      };
    }

    function bootstrapReads(): number {
      return (mockClient?.calls ?? []).filter(
        (call) => call.operation === 'settings.bootstrap',
      ).length;
    }

    it('draws the last-known rows on reopen and reads the bootstrap again', async () => {
      const reads = holdableClient();
      useNavigationStore.getState().openSettings();
      render();
      await flush();
      const ready = hostedRowIds();
      expect(ready).toContain('settings-nav-account-billing');

      render(false);
      await flush();
      reads.hold();
      const before = bootstrapReads();
      render(true);
      expect(hostedRowIds()).toEqual(ready);
      await flush();
      expect(bootstrapReads()).toBe(before + 1);

      reads.release();
      await flush();
      expect(hostedRowIds()).toEqual(ready);
    });

    it('remembers the rows for the next app start, replacing an unreadable entry', async () => {
      window.localStorage.setItem(NAV_MODEL_KEY, '{not json');
      const reads = holdableClient();
      useNavigationStore.getState().openSettings();
      render();
      await flush();
      const ready = hostedRowIds();
      const stored = window.localStorage.getItem(NAV_MODEL_KEY);
      expect(stored === null ? null : JSON.parse(stored)).toEqual({
        accountId: ACCOUNT_ID,
        account: {
          billingEnabled: true,
          digestsEnabled: true,
          freeAccess: false,
        },
        organizations: {},
      });

      // A restart: a fresh renderer with only storage left. The overlay
      // mounts closed with the app and opens later.
      act(() => root.unmount());
      root = createRoot(container);
      reads.hold();
      render(false);
      await flush();
      useNavigationStore.getState().openSettings();
      render(true);
      expect(hostedRowIds()).toEqual(ready);
      reads.release();
      await flush();
      expect(hostedRowIds()).toEqual(ready);
    });

    it('draws the last account’s rows when Settings opens before the account is read', async () => {
      const reads = holdableClient();
      useNavigationStore.getState().openSettings();
      render();
      await flush();
      const ready = hostedRowIds();
      expect(ready).toContain('settings-nav-account-billing');
      expect(ready).toContain('settings-nav-account-digests');

      // A restart that opens Settings at once: the renderer has not read the
      // account yet, so only the last account's stored rows can be drawn.
      act(() => root.unmount());
      root = createRoot(container);
      let releaseAccount: () => void = () => undefined;
      accountReadGate = new Promise<void>((resolve) => {
        releaseAccount = resolve;
      });
      reads.hold();
      render(true);
      expect(hostedRowIds()).toEqual(ready);

      releaseAccount();
      await flush();
      expect(hostedRowIds()).toEqual(ready);
      reads.release();
      await flush();
      expect(hostedRowIds()).toEqual(ready);
    });

    it('draws no remembered rows before the account is read after a sign-out', async () => {
      const reads = holdableClient();
      useNavigationStore.getState().openSettings();
      render();
      await flush();
      expect(hostedRowIds()).toContain('settings-nav-account-billing');

      // Signing out forgets whose rows were drawn last.
      accountId = null;
      act(() => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      });
      await flush();

      act(() => root.unmount());
      root = createRoot(container);
      accountReadGate = new Promise<void>(() => undefined);
      reads.hold();
      render(true);
      expect(hostedRowIds()).not.toContain('settings-nav-account-billing');
      expect(hostedRowIds()).not.toContain('settings-nav-account-digests');
    });

    it('draws a deep-linked organization at first paint after a restart', async () => {
      const reads = holdableClient();
      const route: SettingsRoute = {
        scope: 'organization',
        organizationId: OWNER_ORG,
        page: 'members',
      };
      useNavigationStore.getState().openAccountOrganizationSettings(route);
      render();
      await flush();
      const ready = hostedRowIds();
      expect(ready).toContain('settings-nav-organization-members');

      act(() => root.unmount());
      root = createRoot(container);
      useNavigationStore.getState().closeSettings();
      reads.hold();
      render(false);
      await flush();
      const before = bootstrapReads();
      useNavigationStore.getState().openAccountOrganizationSettings(route);
      render(true);
      expect(hostedRowIds()).toEqual(ready);
      await flush();
      // The rail and the page share one organization read; no account read.
      expect(
        (mockClient?.calls ?? [])
          .filter((call) => call.operation === 'settings.bootstrap')
          .slice(before)
          .map((call) => call.input),
      ).toEqual([{ organizationId: OWNER_ORG }]);
      reads.release();
      await flush();
      expect(hostedRowIds()).toEqual(ready);
    });
  });

  it('reads a rail row’s page ahead after a short hover or focus, once', async () => {
    mockClient = createFakeSettingsClient({
      'settings.bootstrap': bootstrapFor,
      'settings.pageData': () => new Promise<never>(() => {}),
    });
    useNavigationStore.getState().openAccountOrganizationSettings({
      scope: 'organization',
      organizationId: OWNER_ORG,
      page: 'feed',
    });
    render();
    await flush();
    const membersReads = (): number =>
      (mockClient?.calls ?? []).filter(
        (call) =>
          call.operation === 'settings.pageData' &&
          JSON.stringify(call.input).includes('"page":"members"'),
      ).length;
    const row = query('settings-nav-organization-members');
    if (row === null) throw new Error('No Members row');

    // Passing over the row reads nothing.
    act(() => row.focus());
    act(() => row.blur());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(membersReads()).toBe(0);

    // Resting on it reads the page once, however often it is revisited.
    act(() => row.focus());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(membersReads()).toBe(1);
    act(() => row.blur());
    act(() => row.focus());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(membersReads()).toBe(1);
  });

  it('shows the access-lost notice inside the page, below its header', async () => {
    useNavigationStore.getState().openAccountOrganizationSettings({
      scope: 'organization',
      organizationId: STRANGER_ORG,
      page: 'feed',
    });
    render();
    await flush();
    const content = query('hosted-settings-content');
    const notice = query('hosted-settings-access-lost');
    expect(query('hosted-page-stub')?.contains(notice)).toBe(true);
    // The page's own content leads; the notice is not above the page.
    expect(content?.firstElementChild).toBe(query('hosted-page-stub'));
  });

  it('shows only the device sections on Integrations when the server has it off', async () => {
    integrationsEnabled = false;
    useNavigationStore.getState().openAccountOrganizationSettings({
      scope: 'account',
      page: 'integrations',
    });
    render();
    await flush();
    expect(query('hosted-settings-frame')?.dataset.hostedSettingsState).toBe(
      'unavailable',
    );
    expect(query('account-device-settings-integrations')).not.toBeNull();
    expect(query('hosted-page-stub')).toBeNull();
    expect(query('hosted-settings-access-lost')).toBeNull();
    // The row stays in the rail for this computer's GitHub and Linear.
    expect(selectedRows()).toEqual(['settings-nav-account-integrations']);
  });

  it('scrolls to a device row that mounts after the page opens', async () => {
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings(
        { scope: 'account', page: 'integrations' },
        { scrollTo: 'settings-linear-token-input' },
      );
    render();
    await flush();
    expect(query('settings-linear-token-input')).toBeNull();

    // The scroll target retries for a bounded window while the row mounts.
    for (
      let waited = 0;
      waited < 2500 &&
      query('settings-linear-token-input')?.classList.contains(
        'workspace-highlight-pulse',
      ) !== true;
      waited += 100
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
    }
    const input = query('settings-linear-token-input');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input?.classList.contains('workspace-highlight-pulse')).toBe(true);
  });

  it('keeps an account page when the account changes', async () => {
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'account', page: 'profile' });
    render();
    await flush();
    expect(query('hosted-page-stub')).not.toBeNull();

    accountId = OTHER_ACCOUNT_ID;
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await flush();
    expect(useNavigationStore.getState().settingsHostedLocation?.route).toEqual(
      { scope: 'account', page: 'profile' },
    );
    expect(query('account-device-settings-profile')).not.toBeNull();
    expect(query('canopy-tab')).toBeNull();
  });

  it("drops the previous account's hosted history when the account changes", async () => {
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'organizations' });
    render();
    await flush();
    act(() => {
      useNavigationStore
        .getState()
        .openAccountOrganizationSettings({ scope: 'account', page: 'profile' });
    });
    await flush();
    expect(useNavigationStore.getState().settingsHostedHistory).toHaveLength(1);

    accountId = OTHER_ACCOUNT_ID;
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await flush();
    const navigation = useNavigationStore.getState();
    expect(navigation.settingsHostedLocation?.route).toEqual({
      scope: 'account',
      page: 'profile',
    });
    expect(navigation.settingsHostedHistory).toEqual([]);
  });

  it('stays on Account and shows the sign-in when the account disconnects', async () => {
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'account', page: 'account' });
    render();
    await flush();
    expect(query('hosted-page-stub')).not.toBeNull();

    accountId = null;
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await flush();
    expect(useNavigationStore.getState().settingsHostedLocation?.route).toEqual(
      { scope: 'account', page: 'account' },
    );
    expect(query('hosted-settings-frame')?.dataset.hostedSettingsState).toBe(
      'signed_out',
    );
    expect(query('account-device-settings-account')).not.toBeNull();
  });

  it('leaves an organization page when the account changes', async () => {
    useNavigationStore.getState().openAccountOrganizationSettings({
      scope: 'organization',
      organizationId: OWNER_ORG,
      page: 'feed',
    });
    render();
    await flush();
    expect(query('hosted-page-stub')).not.toBeNull();

    accountId = OTHER_ACCOUNT_ID;
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await flush();
    expect(useNavigationStore.getState().settingsHostedLocation).toBeNull();
    expect(query('hosted-page-stub')).toBeNull();
    expect(query('canopy-tab')).not.toBeNull();
  });

  it('opens hosted Notifications for a Notifications request on open', async () => {
    useNavigationStore
      .getState()
      .openSettings('notifications', { scrollTo: 'notifications-row' });
    render();
    await flush();
    const navigation = useNavigationStore.getState();
    expect(navigation.settingsHostedLocation?.route).toEqual({
      scope: 'account',
      page: 'notifications',
    });
    expect(navigation.settingsHostedHistory).toEqual([]);
    expect(query('account-device-settings-notifications')).not.toBeNull();
    expect(query('notifications-tab')).toBeNull();
    expect(query('canopy-tab')).toBeNull();
    expect(selectedRows()).toEqual(['settings-nav-account-notifications']);
    // The local section underneath is General, not Notifications.
    expect(navigation.settingsActiveSection).toBe('canopy');
  });

  it('keeps the scroll target through the Notifications alias', () => {
    useNavigationStore
      .getState()
      .openSettings('notifications', { scrollTo: 'notifications-row' });
    const seen: (string | undefined)[] = [];
    const stop = useNavigationStore.subscribe((state) => {
      if (state.settingsHostedLocation !== null)
        seen.push(state.settingsScrollTarget);
    });
    render();
    stop();
    expect(seen[0]).toBe('notifications-row');
  });

  it('opens hosted Notifications for a Notifications request while open', async () => {
    useNavigationStore.getState().openSettings('git');
    render();
    await flush();
    expect(query('git-tab')).not.toBeNull();

    const seen: (string | undefined)[] = [];
    const stop = useNavigationStore.subscribe((state) => {
      if (state.settingsHostedLocation !== null)
        seen.push(state.settingsScrollTarget);
    });
    act(() => {
      useNavigationStore
        .getState()
        .openSettings('notifications', { scrollTo: 'notifications-row' });
    });
    render();
    stop();
    await flush();
    expect(seen[0]).toBe('notifications-row');
    expect(useNavigationStore.getState().settingsHostedLocation?.route).toEqual(
      { scope: 'account', page: 'notifications' },
    );
    expect(query('account-device-settings-notifications')).not.toBeNull();
    expect(query('notifications-tab')).toBeNull();
    expect(query('git-tab')).toBeNull();
  });

  it('opens hosted Notifications again after leaving it for another hosted page', async () => {
    useNavigationStore.getState().openSettings('notifications');
    render();
    await flush();
    act(() => {
      useNavigationStore
        .getState()
        .openAccountOrganizationSettings({ scope: 'account', page: 'account' });
    });
    await flush();
    expect(useNavigationStore.getState().settingsHostedLocation?.route).toEqual(
      { scope: 'account', page: 'account' },
    );

    act(() => {
      useNavigationStore.getState().openSettings('notifications');
    });
    render();
    await flush();
    expect(useNavigationStore.getState().settingsHostedLocation?.route).toEqual(
      { scope: 'account', page: 'notifications' },
    );
    expect(query('account-device-settings-notifications')).not.toBeNull();
    expect(query('canopy-tab')).toBeNull();
  });

  it('opens the local Notifications tab without a hosted client', async () => {
    mockClient = null;
    useNavigationStore.getState().openSettings('notifications');
    render();
    await flush();
    expect(useNavigationStore.getState().settingsHostedLocation).toBeNull();
    expect(query('notifications-tab')).not.toBeNull();
    expect(query('settings-nav-notifications')).not.toBeNull();
    expect(query('settings-nav-group-account')).toBeNull();
  });

  it('falls back to the local section and rail when the hosted client goes away', async () => {
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'account', page: 'security' });
    render();
    await flush();
    expect(query('hosted-page-stub')).not.toBeNull();

    mockClient = null;
    render();
    await flush();
    expect(query('hosted-page-stub')).toBeNull();
    expect(query('hosted-settings-content')).toBeNull();
    expect(query('canopy-tab')).not.toBeNull();
    expect(query('settings-nav-group-account')).toBeNull();
    expect(query('settings-nav-account')?.textContent).toBe('Accounts');
    expect(query('settings-nav-notifications')).not.toBeNull();
    expect(selectedRows()).toEqual(['settings-nav-canopy']);
  });

  it('opens a hosted route main asks for (settings.open)', async () => {
    render(false);
    await flush();
    expect(openRequestListener).not.toBeNull();
    act(() => {
      openRequestListener?.({ scope: 'account', page: 'notifications' });
    });
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
    expect(useNavigationStore.getState().settingsHostedLocation?.route).toEqual(
      { scope: 'account', page: 'notifications' },
    );
  });

  it('renders no hosted groups in a remote-control window', async () => {
    useRemoteControlStore.setState({
      context: {
        mode: 'remote',
        deviceId: 'device-1',
        name: 'Studio desktop',
        platform: 'linux',
      },
    });
    useNavigationStore.getState().openSettings();
    render();
    await flush();
    expect(query('settings-nav-group-account')).toBeNull();
    expect(query('settings-nav-group-personal')).not.toBeNull();
  });
});

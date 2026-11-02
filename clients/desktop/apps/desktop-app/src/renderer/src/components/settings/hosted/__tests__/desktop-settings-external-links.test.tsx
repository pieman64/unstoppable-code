/** @jest-environment jsdom */
import type { AuthenticatedPortalRequest } from '@canopy/desktop-shared/types';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { SettingsHostProvider } from '@canopy/ui-app/settings/host';
import { createTestSettingsHost } from '@canopy/ui-app/settings/__tests__/helpers/test-settings-host';
import { BillingTogglePanel } from '@canopy/ui-app/settings/billing/billing-toggle-panel';
import { ProfileHeader } from '@canopy/ui-app/settings/organization/profile/ProfileHeader';
import {
  DesktopSettingsAnchorBoundary,
  DesktopSettingsLink,
} from '../DesktopSettingsHost';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  DesktopSettingsHostContext,
  followHostedSettingsHref,
  openHostedSettingsExternalUrl,
} from '../desktop-settings-host-context';
import { useGitHubStore } from '@/stores/githubStore';

const context = {
  account: { status: 'signed_in', accountId: 'acct_1' },
  webOrigin: 'http://localhost:3000',
  location: {
    route: { scope: 'account', page: 'billing' },
    search: 'range=7d',
    hash: '',
  },
} as const;
const openAuthenticatedPortalPage = jest.fn<
  Promise<unknown>,
  [AuthenticatedPortalRequest]
>();
const openExternal = jest.fn();
const navigate = useNavigationStore.getState().openAccountOrganizationSettings;
const sharedHost = {
  ...createTestSettingsHost().host,
  Link: DesktopSettingsLink,
};

beforeEach(() => {
  useNavigationStore.setState({ openAccountOrganizationSettings: navigate });
  openAuthenticatedPortalPage.mockReset().mockResolvedValue({ ok: true });
  openExternal.mockReset().mockResolvedValue(undefined);
  useGitHubStore.setState({ toasts: [] });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      openAuthenticatedPortalPage,
      browser: { openExternal },
    },
  });
});

it.each([
  ['/account/billing?b=2&a=1#card', 'payment', '/account/billing?b=2&a=1#card'],
  ['/integrations', 'signed-in', '/integrations'],
  ['?topUp=1', 'payment', '/account/billing?topUp=1'],
  ['#card', 'payment', '/account/billing?range=7d#card'],
])(
  'opens %s using a strict authenticated request',
  async (href, kind, path) => {
    const result = await openHostedSettingsExternalUrl(href, context);
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith({
      requireAuthentication: true,
      kind,
      path,
      accountId: 'acct_1',
      webOrigin: context.webOrigin,
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(result).toBe(true);
  },
);

it('reports one failure without opening a bare destination', async () => {
  openAuthenticatedPortalPage.mockResolvedValue(true);
  await expect(
    openHostedSettingsExternalUrl('/integrations', context),
  ).resolves.toBe(false);
  expect(openExternal).not.toHaveBeenCalled();
  expect(useGitHubStore.getState().toasts).toHaveLength(1);
});

it.each([
  'https://elsewhere.test/path',
  'http://localhost:3001/path',
  'http://localhost.evil.test/path',
  'mailto:help@example.test',
])('guards off-origin opening: %s', async (href) => {
  await expect(openHostedSettingsExternalUrl(href, context)).resolves.toBe(
    true,
  );
  expect(openExternal).toHaveBeenCalledWith({ url: href });
  expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
});

it.each([
  ' /integrations',
  '/integrations\t',
  '/foo\\bar',
  'javascript:alert(1)',
  'file:///etc/passwd',
  'https://name:secret@localhost:3000/account',
  'http://@localhost:3000/account',
  'https://[invalid',
  '/x' + 'a'.repeat(2048),
  '',
])('rejects unsafe destinations: %j', async (href) => {
  await expect(openHostedSettingsExternalUrl(href, context)).resolves.toBe(
    false,
  );
  expect(openExternal).not.toHaveBeenCalled();
  expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
  expect(useGitHubStore.getState().toasts).toHaveLength(1);
});

it.each([{ status: 'signed_out' }, { status: 'loading' }] as const)(
  'does not authenticate a %j account',
  async (account) => {
    await expect(
      openHostedSettingsExternalUrl('/integrations', { ...context, account }),
    ).resolves.toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
  },
);

it('fails closed without an origin, but permits independent mailto', async () => {
  const unresolved = { ...context, webOrigin: '' };
  await expect(
    openHostedSettingsExternalUrl('https://elsewhere.test/path', unresolved),
  ).resolves.toBe(false);
  await expect(
    openHostedSettingsExternalUrl('mailto:help@example.test', unresolved),
  ).resolves.toBe(true);
});

it.each([
  true,
  false,
  {},
  { ok: false, reason: 'unknown' },
  { ok: true, extra: true },
  { ok: false, reason: 'failed' },
])('never downgrades a malformed/failed reply: %j', async (reply) => {
  openAuthenticatedPortalPage.mockResolvedValue(reply);
  await expect(
    openHostedSettingsExternalUrl('/account/billing', context),
  ).resolves.toBe(false);
  expect(openExternal).not.toHaveBeenCalled();
  expect(useGitHubStore.getState().toasts).toHaveLength(1);
});

it('uses payment and known browser-launch error copy', async () => {
  openAuthenticatedPortalPage.mockResolvedValue({
    ok: false,
    reason: 'failed',
  });
  await openHostedSettingsExternalUrl('/account/billing', context);
  expect(useGitHubStore.getState().toasts[0].message).toBe(
    "Couldn't open this payment page. Try again.",
  );
  openAuthenticatedPortalPage.mockResolvedValue({
    ok: false,
    reason: 'browser_failed',
  });
  await openHostedSettingsExternalUrl('/integrations', context);
  expect(useGitHubStore.getState().toasts[1].message).toBe(
    "Couldn't open your browser. Try again.",
  );
});

it('handles a missing bridge or rejected invoke with one notice', async () => {
  openAuthenticatedPortalPage.mockRejectedValue(
    new Error('secret server text'),
  );
  await expect(
    openHostedSettingsExternalUrl('/integrations', context),
  ).resolves.toBe(false);
  expect(useGitHubStore.getState().toasts).toHaveLength(1);
  expect(useGitHubStore.getState().toasts[0].message).not.toContain('secret');
  Object.defineProperty(window, 'api', { configurable: true, value: {} });
  useGitHubStore.setState({ toasts: [] });
  await expect(
    openHostedSettingsExternalUrl('/integrations', context),
  ).resolves.toBe(false);
  expect(useGitHubStore.getState().toasts).toHaveLength(1);
});

it('keeps internal routing, query/fragment state and replacement without external availability', () => {
  const navigate = jest.spyOn(
    useNavigationStore.getState(),
    'openAccountOrganizationSettings',
  );
  followHostedSettingsHref(
    '#card',
    { ...context, account: { status: 'signed_out' }, webOrigin: '' },
    { replace: true },
  );
  expect(navigate).toHaveBeenCalledWith(
    { scope: 'account', page: 'billing' },
    { search: 'range=7d', hash: 'card', replace: true },
  );
  expect(openExternal).not.toHaveBeenCalled();
  expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
  navigate.mockRestore();
});

let root: Root | undefined;
let container: HTMLDivElement;
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
function mount(children: ReactNode): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useNavigationStore.setState({ settingsHostedLocation: context.location });
  act(() =>
    root?.render(
      <DesktopSettingsHostContext.Provider
        value={{
          ...context,
          scrollElementRef: { current: null },
          settingsApi: null,
          persistedNavModel: null,
        }}
      >
        <DesktopSettingsAnchorBoundary>
          <SettingsHostProvider host={sharedHost}>
            {children}
          </SettingsHostProvider>
        </DesktopSettingsAnchorBoundary>
      </DesktopSettingsHostContext.Provider>,
    ),
  );
}
async function activate(
  selector: string,
  type = 'click',
  options: MouseEventInit = {},
): Promise<MouseEvent> {
  const target = document.querySelector(selector);
  if (!target) throw new Error(`Missing anchor target ${selector}`);
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    ...options,
  });
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
});

it.each([
  ['click', {}],
  ['click', { ctrlKey: true }],
  ['click', { metaKey: true }],
  ['click', { shiftKey: true }],
  ['click', { altKey: true }],
  ['auxclick', { button: 1 }],
])(
  'intercepts a nested raw anchor exactly once: %s %j',
  async (type, options) => {
    mount(
      <a href="/runs/run_1?x=1#result">
        <span id="nested">Run</span>
      </a>,
    );
    const event = await activate('#nested', type, options);
    expect(event.defaultPrevented).toBe(true);
    expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
    expect(openAuthenticatedPortalPage.mock.calls[0][0]).toMatchObject({
      path: '/runs/run_1?x=1#result',
      kind: 'signed-in',
    });
  },
);

it.each(['_blank', '_parent', '_top'])(
  'opens targeted internal settings externally: %s',
  async (target) => {
    mount(
      <a href="/account/billing" target={target} id="link">
        Billing
      </a>,
    );
    await activate('#link');
    expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
  },
);

it('routes an unmodified primary/keyboard click internally', async () => {
  mount(
    <a href="/account/billing?topUp=1#card" id="link">
      Billing
    </a>,
  );
  await activate('#link', 'click', { detail: 0 });
  expect(useNavigationStore.getState().settingsHostedLocation).toMatchObject({
    search: 'topUp=1',
    hash: 'card',
  });
  expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
});

it('also intercepts React portal anchors', async () => {
  mount(
    createPortal(
      <a href="/runs/run_1" id="portal-link">
        Run
      </a>,
      document.body,
    ),
  );
  await activate('#portal-link');
  expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
});

it('leaves prevented child events and right-clicks alone; empty href is inert', async () => {
  mount(
    <>
      <a
        href="/runs/run_1"
        id="prevented"
        onClick={(event) => event.preventDefault()}
      >
        Handled
      </a>
      <a href="" id="empty">
        Empty
      </a>
      <a id="missing">No href</a>
    </>,
  );
  await activate('#prevented');
  await activate('#prevented', 'auxclick', { button: 2 });
  expect((await activate('#empty')).defaultPrevented).toBe(true);
  expect((await activate('#missing')).defaultPrevented).toBe(false);
  expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
  expect(useGitHubStore.getState().toasts).toHaveLength(0);
});

it('prevents native navigation for unsafe raw hrefs and shows only one notice', async () => {
  mount(
    <a href="javascript:alert(1)" id="link">
      Unsafe
    </a>,
  );
  expect((await activate('#link')).defaultPrevented).toBe(true);
  expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
  expect(useGitHubStore.getState().toasts).toHaveLength(1);
});

it.each([
  ['click', { ctrlKey: true }],
  ['auxclick', { button: 1 }],
])('host Link suppresses duplicate bubbling for %s', async (type, options) => {
  mount(
    <DesktopSettingsLink href="/account/billing" id="link">
      Billing
    </DesktopSettingsLink>,
  );
  expect((await activate('#link', type, options)).defaultPrevented).toBe(true);
  expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
  expect(openExternal).not.toHaveBeenCalled();
});

it('host Link preserves explicit external targets and intentionally prevented children', async () => {
  mount(
    <>
      <DesktopSettingsLink
        href="/account/billing"
        target="_blank"
        id="external"
      >
        Billing
      </DesktopSettingsLink>
      <DesktopSettingsLink
        href="/integrations"
        id="handled"
        onAuxClick={(event) => event.preventDefault()}
      >
        Handled
      </DesktopSettingsLink>
    </>,
  );
  await activate('#external');
  await activate('#handled', 'auxclick', { button: 1 });
  expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
});

it('preserves raw repeated route queries and escapes on fragment-only external links', async () => {
  await openHostedSettingsExternalUrl('#card', {
    ...context,
    location: {
      route: {
        scope: 'organization',
        organizationId: '55555555-5555-4555-8555-111111111111',
        page: 'settings',
        subtab: 'general',
      },
      search: 'tab=general&tab=billing&label=one%20two',
      hash: '',
    },
  });
  expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'payment',
      path: '/organization/55555555-5555-4555-8555-111111111111/settings?tab=general&tab=billing&label=one%20two#card',
    }),
  );
});

it.each([
  ['/account/billing?tab=general&tab=billing#credits', 'payment'],
  ['/integrations?from=billing#connect', 'signed-in'],
])(
  'authenticates the real shared Learn more anchor: %s',
  async (href, kind) => {
    mount(
      <BillingTogglePanel
        testId="billing-panel"
        toggleTestId="billing-toggle"
        title="Credits"
        description="Credits settings"
        learnMoreHref={href}
        checked={false}
        ariaLabel="Enable credits"
        disabled={false}
        onToggle={() => undefined}
        error={null}
      />,
    );
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(
      (await activate('[data-testid="billing-panel"] a')).defaultPrevented,
    ).toBe(true);
    expect(openAuthenticatedPortalPage.mock.calls).toEqual([
      [
        {
          requireAuthentication: true,
          kind,
          path: href,
          accountId: 'acct_1',
          webOrigin: context.webOrigin,
        },
      ],
    ]);
    expect(openExternal).not.toHaveBeenCalled();
  },
);

it.each([
  '/runs/profile-run?view=full#summary',
  'https://example.test/profile',
])(
  'routes the real shared profile anchor once per deliberate activation: %s',
  async (href) => {
    mount(
      <ProfileHeader
        member={{
          id: 'member-1',
          name: 'Fixture Member',
          email: 'member@example.test',
          image: null,
          role: 'OWNER',
          memberSinceIso: '2024-01-15T00:00:00.000Z',
          links: [{ label: 'Profile link', url: href }],
        }}
      />,
    );
    for (const type of ['click', 'auxclick']) {
      expect(
        (
          await activate('[data-testid="profile-header"] a', type, {
            button: type === 'auxclick' ? 1 : 0,
          })
        ).defaultPrevented,
      ).toBe(true);
    }
    if (href.startsWith('/')) {
      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(2);
      expect(openAuthenticatedPortalPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: href, kind: 'signed-in' }),
      );
      expect(openExternal).not.toHaveBeenCalled();
    } else {
      expect(openExternal.mock.calls).toEqual([
        [{ url: href }],
        [{ url: href }],
      ]);
      expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    }
  },
);

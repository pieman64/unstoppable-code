/** @jest-environment ./packages/ui-app/src/settings/github/__tests__/helpers/web-fetch-jsdom-environment.ts */
/* eslint-disable @typescript-eslint/require-await -- act() callbacks stay async so React flushes the settled promises they trigger. */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WEB_BRANDS } from '@canopy/brand/web';
import type { SettingsNavigationPort } from '@canopy/app-core/settings';
import type { SettingsBrand } from '../../host';
import type { GitHubCloudConnectionDto } from '@canopy/protocol/settings/account-github';
import { GITHUB_CLOUD_ERROR_COPY } from '@canopy/protocol/settings/github-cloud-errors';
import { AccountIntegrationsPage } from '../AccountIntegrationsPage';
import { GitHubCloudSettings } from '../GitHubCloudSettings';
import {
  GITHUB_CLOUD_CONTINUE_IN_BROWSER_COPY,
  GITHUB_CLOUD_LINK_MARKER_KEY,
} from '../use-github-cloud-connection';
import {
  createFetchBackedGitHubPorts,
  createFetchBackedSettingsClient,
  GitHubTestHost,
  type TestBackendFetch,
  type TestLinkSocial,
} from './helpers/github-test-host';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const canopyBrand: SettingsBrand = ((): SettingsBrand => {
  const brand = WEB_BRANDS.find((entry) => entry.id === 'canopy');
  if (!brand) throw new Error('WEB_BRANDS does not include the canopy brand');
  return {
    id: brand.id,
    displayName: brand.displayName,
    internalName: brand.internalName,
  };
})();

const CONNECTION = '/cloud/github/connection';
const VERIFY = '/cloud/github/connection/install-verify';

const STORED_ACTIVE: GitHubCloudConnectionDto = {
  state: 'ACTIVE',
  githubLogin: 'octocat',
  verifiedAt: '2026-10-01T10:00:00.000Z',
  readyForProjects: true,
  targets: [
    {
      id: '6f1c2c1e-0000-4000-8000-000000000001',
      installationId: '1001',
      accountLogin: 'octocat',
      accountType: 'User',
      repositorySelection: 'all',
      state: 'ACTIVE',
    },
  ],
};
const LIVE_ACTIVE: GitHubCloudConnectionDto = {
  ...STORED_ACTIVE,
  verifiedAt: '2026-10-05T10:00:00.000Z',
};
const DISCONNECTED: GitHubCloudConnectionDto = {
  state: 'DISCONNECTED',
  githubLogin: null,
  verifiedAt: null,
  readyForProjects: false,
  targets: [],
};

// ---------------------------------------------------------------------------
// Real promise ordering: every request stays pending until the test answers.
// ---------------------------------------------------------------------------

interface PendingRequest {
  readonly method: string;
  readonly path: string;
  respond(status: number, body: unknown): Promise<void>;
}

// The backend (paths after `/api`) behind the settings client.
const fetchMock = jest.fn<
  ReturnType<TestBackendFetch>,
  Parameters<TestBackendFetch>
>();
const linkSocial = jest.fn<
  ReturnType<TestLinkSocial>,
  Parameters<TestLinkSocial>
>();
const client = createFetchBackedSettingsClient(fetchMock);
const github = createFetchBackedGitHubPorts(fetchMock, linkSocial);
const openExternal = jest.fn<void, [string]>();
const navigation: Partial<SettingsNavigationPort> = { openExternal };
let requests: PendingRequest[] = [];
let taken = new Set<PendingRequest>();

function installFetch(): void {
  fetchMock.mockImplementation((path, init) => {
    let resolve: (response: Response) => void = () => undefined;
    const promise = new Promise<Response>((res) => {
      resolve = res;
    });
    requests.push({
      method: init?.method ?? 'GET',
      path,
      respond: (status, body) =>
        act(async () => {
          resolve(Response.json(body, { status }));
        }),
    });
    return promise;
  });
}

function calls(method: string, path: string): PendingRequest[] {
  return requests.filter(
    (request) => request.method === method && request.path === path,
  );
}

function take(method: string, path: string): PendingRequest {
  const request = calls(method, path).find((entry) => !taken.has(entry));
  if (!request) throw new Error(`no pending ${method} ${path}`);
  taken.add(request);
  return request;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let root: Root;
let container: HTMLDivElement;

/**
 * `inline` mounts the GitHub host (web); `browser` mounts none, so the views
 * get the browser handoff (desktop).
 */
async function mount(
  strict = false,
  mode: 'inline' | 'browser' = 'inline',
): Promise<void> {
  const tree = (
    <GitHubTestHost
      client={client}
      github={mode === 'inline' ? github : null}
      brand={canopyBrand}
      navigation={navigation}
    >
      <GitHubCloudSettings userId="user-1" />
    </GitHubTestHost>
  );
  await act(async () => {
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
}

function find(testId: string, scope: ParentNode = container): HTMLElement {
  const element = scope.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`missing [data-testid="${testId}"]`);
  return element;
}

function has(testId: string, scope: ParentNode = container): boolean {
  return scope.querySelector(`[data-testid="${testId}"]`) !== null;
}

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(
    '[data-testid="github-cloud-disconnect-confirm"]',
  );
}

function openDialog(): HTMLElement {
  const opened = dialog();
  if (!opened) throw new Error('dialog is not open');
  return opened;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

beforeEach(() => {
  requests = [];
  taken = new Set();
  openExternal.mockReset();
  linkSocial.mockReset();
  installFetch();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/account/integrations');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

/** Mounts and settles on a live, ready connection. */
async function mountConnected(): Promise<void> {
  await mount();
  await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
  await take('POST', VERIFY).respond(200, LIVE_ACTIVE);
}

describe('GitHubCloudSettings', () => {
  it('mounts one controller: one read, then one live check, even under Strict Mode', async () => {
    await mount(true);

    expect(
      find(
        'centered-loading-spinner',
        find('github-cloud-loading'),
      ).getAttribute('role'),
    ).toBe('status');
    expect(find('github-cloud-status').textContent).toBe('');
    expect(calls('GET', CONNECTION)).toHaveLength(1);

    await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
    expect(has('github-cloud-loading')).toBe(false);
    expect(find('github-cloud-status').textContent).toBe(
      'Checking with GitHub…',
    );
    expect(calls('POST', VERIFY)).toHaveLength(1);

    await take('POST', VERIFY).respond(200, LIVE_ACTIVE);
    expect(find('github-cloud-status').textContent).toContain('Connected');
    expect(requests).toHaveLength(2);
    expect(findAllTargets()).toHaveLength(1);
  });

  it('does not verify or reconnect a disconnected account, and offers Connect GitHub', async () => {
    await mount();
    await take('GET', CONNECTION).respond(200, DISCONNECTED);

    expect(find('github-cloud-status').textContent).toContain('Not connected');
    expect(find('github-cloud-connect').textContent).toBe('Connect GitHub');
    expect(calls('POST', VERIFY)).toHaveLength(0);
    expect(requests).toHaveLength(1);
  });

  it('retries a failed first read with Try again', async () => {
    await mount();
    await take('GET', CONNECTION).respond(502, {
      error: 'ignored provider text',
      code: 'github-unavailable',
    });

    expect(find('github-cloud-error').textContent).toContain(
      GITHUB_CLOUD_ERROR_COPY['github-unavailable'],
    );
    expect(find('github-cloud-error').textContent).not.toContain(
      'ignored provider text',
    );

    const retry = find('github-cloud-retry');
    retry.focus();
    await click(retry);
    expect(has('github-cloud-loading')).toBe(true);
    expect(find('github-cloud-status').textContent).toBe('');
    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    expect(find('github-cloud-status').textContent).toContain('Not connected');
    expect(has('github-cloud-error')).toBe(false);
    // Try again took its own notice with it: focus lands on the card heading,
    // never on <body>.
    expect(retry.isConnected).toBe(false);
    expect(document.activeElement).toBe(container.querySelector('h2'));
  });

  it('keeps focus on the card when a retried first read fails again', async () => {
    await mount();
    await take('GET', CONNECTION).respond(502, {
      error: 'x',
      code: 'github-unavailable',
    });
    const retry = find('github-cloud-retry');
    retry.focus();
    await click(retry);
    await take('GET', CONNECTION).respond(502, {
      error: 'x',
      code: 'github-unavailable',
    });

    expect(find('github-cloud-error').textContent).toContain(
      GITHUB_CLOUD_ERROR_COPY['github-unavailable'],
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(container.querySelector('h2'));
  });

  it('Check again runs a live check, with a busy focusable button while it runs', async () => {
    await mountConnected();
    const check = find('github-cloud-check-again');
    check.focus();

    await click(check);
    expect(calls('POST', VERIFY)).toHaveLength(2);
    expect(find('github-cloud-status').textContent).toBe(
      'Checking with GitHub…',
    );
    const busy = find('github-cloud-check-again');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(busy);

    // A second press while checking does not start a second request.
    await click(busy);
    expect(calls('POST', VERIFY)).toHaveLength(2);

    await take('POST', VERIFY).respond(200, LIVE_ACTIVE);
    expect(find('github-cloud-check-again').textContent).toBe('Check again');
    expect(document.activeElement).toBe(find('github-cloud-check-again'));
  });

  it('keeps the last known accounts and shows a distinct rate limit, then recovers on retry', async () => {
    await mountConnected();

    await click(find('github-cloud-check-again'));
    await take('POST', VERIFY).respond(429, {
      error: 'ignored provider text',
      code: 'github-rate-limited',
    });

    const limited = find('github-cloud-rate-limit');
    expect(limited.textContent).toContain(
      GITHUB_CLOUD_ERROR_COPY['github-rate-limited'],
    );
    expect(limited.textContent).not.toContain('ignored provider text');
    expect(has('github-cloud-error')).toBe(false);
    expect(findAllTargets()).toHaveLength(1);

    await click(find('github-cloud-check-again'));
    await take('POST', VERIFY).respond(200, LIVE_ACTIVE);
    expect(has('github-cloud-rate-limit')).toBe(false);
    expect(find('github-cloud-status').textContent).toContain('Connected');
  });

  it('shows a finishing-setup account with Check again after a live check', async () => {
    await mount();
    await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
    await take('POST', VERIFY).respond(200, {
      ...LIVE_ACTIVE,
      readyForProjects: false,
      targets: [{ ...STORED_ACTIVE.targets[0], state: 'PENDING_ADOPTION' }],
    });

    expect(find('github-cloud-status').textContent).toContain(
      'Finishing setup',
    );
    expect(find('github-cloud-check-again').className).toContain('bg-accent');
    expect(container.textContent).not.toMatch(/reinstall/i);
  });

  describe('Disconnect', () => {
    it('disconnects after confirmation, closes the dialog, and returns focus to the heading', async () => {
      await mountConnected();
      const trigger = find('github-cloud-disconnect');
      trigger.focus();
      await click(trigger);

      await click(find('confirm-dialog-confirm', openDialog()));
      const confirm = find('confirm-dialog-confirm', openDialog());
      expect(confirm.textContent).toBe('Disconnecting…');
      expect(confirm.hasAttribute('disabled')).toBe(true);
      expect(calls('DELETE', CONNECTION)).toHaveLength(1);

      await take('DELETE', CONNECTION).respond(200, DISCONNECTED);

      expect(dialog()).toBeNull();
      expect(find('github-cloud-status').textContent).toContain(
        'Not connected',
      );
      expect(has('github-cloud-disconnect')).toBe(false);
      // The trigger is gone, so focus lands on the stable card heading.
      expect(document.activeElement).toBe(container.querySelector('h2'));
    });

    it('keeps the dialog open with the error when the disconnect fails, and succeeds on retry', async () => {
      await mountConnected();
      await click(find('github-cloud-disconnect'));
      await click(find('confirm-dialog-confirm', openDialog()));

      await take('DELETE', CONNECTION).respond(502, {
        error: 'ignored provider text',
        code: 'github-unavailable',
      });

      const still = openDialog();
      const inline = find('github-cloud-disconnect-error', still);
      expect(inline.textContent).toContain(
        GITHUB_CLOUD_ERROR_COPY['github-unavailable'],
      );
      expect(inline.textContent).not.toContain('ignored provider text');
      expect(has('github-cloud-error')).toBe(false);
      // The connection is retained and the confirm button is usable again.
      expect(find('github-cloud-status').textContent).toContain('Connected');
      const confirm = find('confirm-dialog-confirm', still);
      expect(confirm.hasAttribute('disabled')).toBe(false);

      await click(confirm);
      expect(calls('DELETE', CONNECTION)).toHaveLength(2);
      expect(has('github-cloud-disconnect-error', openDialog())).toBe(false);
      await take('DELETE', CONNECTION).respond(200, DISCONNECTED);

      expect(dialog()).toBeNull();
      expect(find('github-cloud-status').textContent).toContain(
        'Not connected',
      );
    });

    it('drops a failed disconnect error when the dialog is cancelled', async () => {
      await mountConnected();
      await click(find('github-cloud-disconnect'));
      await click(find('confirm-dialog-confirm', openDialog()));
      await take('DELETE', CONNECTION).respond(502, {
        error: 'x',
        code: 'github-unavailable',
      });

      await click(find('confirm-dialog-cancel', openDialog()));

      expect(dialog()).toBeNull();
      expect(has('github-cloud-error')).toBe(false);
      expect(find('github-cloud-status').textContent).toContain('Connected');
    });
  });
});

function findAllTargets(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-testid="github-cloud-target"]',
    ),
  );
}

describe('AccountIntegrationsPage', () => {
  it('renders the GitHub for cloud settings for the page data user', async () => {
    await act(async () => {
      root.render(
        <GitHubTestHost client={client} github={github} brand={canopyBrand}>
          <AccountIntegrationsPage
            route={{ scope: 'account', page: 'integrations' }}
            page={{
              kind: 'account.integrations',
              data: { userId: 'user-1' },
            }}
          />
        </GitHubTestHost>,
      );
    });

    expect(has('github-cloud-card')).toBe(true);
    expect(calls('GET', CONNECTION)).toHaveLength(1);
    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    expect(find('github-cloud-connect').textContent).toBe('Connect GitHub');
  });
});

describe('without a GitHub host (browser handoff)', () => {
  const HANDOFF_URL = 'https://canopy.test/account/integrations';

  it('reads and verifies through the settings client as on web', async () => {
    await mount(false, 'browser');
    await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
    await take('POST', VERIFY).respond(200, LIVE_ACTIVE);

    expect(find('github-cloud-status').textContent).toContain('Connected');
    const identity = find('github-cloud-identity-login');
    expect(identity.textContent).toBe('octocat');
  });

  it('opens the web Integrations page for Connect and says to continue there', async () => {
    await mount(false, 'browser');
    await take('GET', CONNECTION).respond(200, DISCONNECTED);

    await click(find('github-cloud-connect'));

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(HANDOFF_URL);
    // Nothing is started here: no Connect request, link, or link marker.
    expect(calls('POST', '/cloud/github/connection/connect')).toHaveLength(0);
    expect(linkSocial).not.toHaveBeenCalled();
    expect(
      window.sessionStorage.getItem(GITHUB_CLOUD_LINK_MARKER_KEY),
    ).toBeNull();
    const notice = find('github-cloud-notice');
    expect(notice.textContent).toContain(GITHUB_CLOUD_CONTINUE_IN_BROWSER_COPY);
    expect(notice.getAttribute('data-notice-kind')).toBe('handoff');
    expect(find('github-cloud-connect').getAttribute('aria-busy')).toBeNull();
  });

  it('hands Install GitHub app and Add account to the browser too', async () => {
    await mount(false, 'browser');
    await take('GET', CONNECTION).respond(200, {
      ...STORED_ACTIVE,
      state: 'NEEDS_INSTALL',
      readyForProjects: false,
      targets: [],
    });
    await take('POST', VERIFY).respond(200, {
      ...LIVE_ACTIVE,
      state: 'NEEDS_INSTALL',
      readyForProjects: false,
      targets: [],
    });

    await click(find('github-cloud-install'));
    expect(openExternal).toHaveBeenLastCalledWith(HANDOFF_URL);
    expect(find('github-cloud-notice').textContent).toContain(
      GITHUB_CLOUD_CONTINUE_IN_BROWSER_COPY,
    );
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    await mount(false, 'browser');
    await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
    await take('POST', VERIFY).respond(200, LIVE_ACTIVE);
    await click(find('github-cloud-add-account'));

    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenLastCalledWith(HANDOFF_URL);
    // The handoff started no request of its own.
    expect(requests).toHaveLength(4);
    expect(calls('POST', '/cloud/github/connection/connect')).toHaveLength(0);
  });

  it('Check again in the notice reads the connection again, and the notice goes once it is ready', async () => {
    await mount(false, 'browser');
    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    await click(find('github-cloud-connect'));

    await click(find('github-cloud-handoff-check-again'));
    expect(calls('GET', CONNECTION)).toHaveLength(2);
    // Still not connected in the browser: the handoff stays on screen.
    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    expect(find('github-cloud-notice').textContent).toContain(
      GITHUB_CLOUD_CONTINUE_IN_BROWSER_COPY,
    );

    await click(find('github-cloud-handoff-check-again'));
    await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
    await take('POST', VERIFY).respond(200, LIVE_ACTIVE);

    expect(find('github-cloud-status').textContent).toContain('Connected');
    expect(has('github-cloud-notice')).toBe(false);
  });

  it('disconnects in place through the settings client', async () => {
    await mount(false, 'browser');
    await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
    await take('POST', VERIFY).respond(200, LIVE_ACTIVE);

    await click(find('github-cloud-disconnect'));
    await click(find('confirm-dialog-confirm', openDialog()));
    await take('DELETE', CONNECTION).respond(200, DISCONNECTED);

    expect(dialog()).toBeNull();
    expect(find('github-cloud-status').textContent).toContain('Not connected');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('never reads or rewrites the page address or a link marker', async () => {
    window.history.replaceState(
      null,
      '',
      '/account/integrations?github_cloud=linked',
    );
    window.sessionStorage.setItem(
      GITHUB_CLOUD_LINK_MARKER_KEY,
      JSON.stringify({
        userId: 'user-1',
        intent: 'connect',
        continuationGeneration: 17,
      }),
    );

    await mount(false, 'browser');
    await take('GET', CONNECTION).respond(200, DISCONNECTED);

    expect(window.location.search).toBe('?github_cloud=linked');
    expect(
      window.sessionStorage.getItem(GITHUB_CLOUD_LINK_MARKER_KEY),
    ).not.toBeNull();
    expect(calls('POST', '/cloud/github/connection/connect')).toHaveLength(0);
    expect(linkSocial).not.toHaveBeenCalled();
  });
});

describe('replay privacy', () => {
  it('blocks the GitHub login and account names from session replay', async () => {
    await act(async () => {
      root.render(
        <GitHubTestHost
          client={client}
          github={github}
          brand={canopyBrand}
          privacy={{
            blockClassName: 'replay-block',
            maskClassName: 'replay-mask',
          }}
        >
          <GitHubCloudSettings userId="user-1" />
        </GitHubTestHost>,
      );
    });
    await take('GET', CONNECTION).respond(200, {
      ...STORED_ACTIVE,
      state: 'NEEDS_INSTALL',
      readyForProjects: false,
      targets: [{ ...STORED_ACTIVE.targets[0], state: 'SUSPENDED' }],
    });

    expect(find('github-cloud-identity-login').classList).toContain(
      'replay-block',
    );
    expect(find('github-cloud-target-login').classList).toContain(
      'replay-block',
    );
  });

  it('adds no class token where the host records no replay', async () => {
    await mount();
    await take('GET', CONNECTION).respond(200, {
      ...STORED_ACTIVE,
      state: 'NEEDS_INSTALL',
      readyForProjects: false,
      targets: [{ ...STORED_ACTIVE.targets[0], state: 'SUSPENDED' }],
    });

    expect(find('github-cloud-identity-login').className).toBe(
      'min-w-0 truncate',
    );
    expect(find('github-cloud-target-login').className).toBe(
      'min-w-0 truncate text-s font-medium fg-primary',
    );
  });
});

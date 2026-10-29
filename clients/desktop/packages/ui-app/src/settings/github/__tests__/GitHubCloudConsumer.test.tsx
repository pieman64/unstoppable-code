/** @jest-environment ./packages/ui-app/src/settings/github/__tests__/helpers/web-fetch-jsdom-environment.ts */
/* eslint-disable @typescript-eslint/require-await -- act() callbacks stay async so React flushes the settled promises they trigger. */
import { act, StrictMode, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WEB_BRANDS } from '@canopy/brand/web';
import type { SettingsBrand } from '../../host';
import type {
  GitHubCloudConnectionDto,
  GitHubCloudTargetDto,
} from '@canopy/protocol/settings/account-github';
import { GitHubCloudConnectStep } from '../GitHubCloudConnectStep';
import type { GitHubCloudSelectedAccount } from '../github-cloud-readiness';
import { GitHubCloudReauthNotice } from '../GitHubCloudReauthNotice';
import { useGitHubCloudConnection } from '../use-github-cloud-connection';
import {
  createFetchBackedGitHubPorts,
  createFetchBackedSettingsClient,
  GitHubTestHost,
  type TestBackendFetch,
  type TestLinkSocial,
} from './helpers/github-test-host';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

// ---------------------------------------------------------------------------
// A consuming wrapper, as REG-3021/3022/3025 will write it: the Cloud Git flag
// gates the whole subtree, the page mounts ONE controller, and the notice and
// the step both render from it. Test-only: nothing here is mounted in product.
// ---------------------------------------------------------------------------

type ConsumerProps = {
  readonly cloudGitEnabled: boolean;
  readonly onReady: () => void;
} & GitHubCloudSelectedAccount;

function EnabledConsumer(props: ConsumerProps): JSX.Element {
  const controller = useGitHubCloudConnection({ userId: 'user-1' });
  const needsReauth = controller.connection?.state === 'NEEDS_REAUTH';
  return (
    <>
      {needsReauth ? (
        <GitHubCloudReauthNotice
          onReconnect={() => void controller.connect()}
          busy={controller.busy === 'connect'}
        />
      ) : null}
      <GitHubCloudConnectStep {...props} controller={controller} />
    </>
  );
}

function Consumer(props: ConsumerProps): JSX.Element | null {
  if (!props.cloudGitEnabled) return null;
  return <EnabledConsumer {...props} />;
}

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
const CONNECT = '/cloud/github/connection/connect';
const VERIFY = '/cloud/github/connection/install-verify';

function target(
  overrides: Partial<GitHubCloudTargetDto> = {},
): GitHubCloudTargetDto {
  return {
    id: '6f1c2c1e-0000-4000-8000-000000000001',
    installationId: '1001',
    accountLogin: 'octocat',
    accountType: 'User',
    repositorySelection: 'all',
    state: 'ACTIVE',
    ...overrides,
  };
}

const READY: GitHubCloudConnectionDto = {
  state: 'ACTIVE',
  githubLogin: 'octocat',
  verifiedAt: '2026-10-05T10:00:00.000Z',
  readyForProjects: true,
  targets: [target()],
};
const PENDING: GitHubCloudConnectionDto = {
  ...READY,
  readyForProjects: false,
  targets: [target({ state: 'PENDING_ADOPTION' })],
};
const NEEDS_REAUTH: GitHubCloudConnectionDto = {
  ...READY,
  state: 'NEEDS_REAUTH',
  readyForProjects: false,
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
const client = createFetchBackedSettingsClient(fetchMock);
const github = createFetchBackedGitHubPorts(
  fetchMock,
  jest.fn<ReturnType<TestLinkSocial>, Parameters<TestLinkSocial>>(),
);
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

async function mount(
  selected: GitHubCloudSelectedAccount = {},
  strict = false,
): Promise<jest.Mock> {
  const onReady = jest.fn();
  await rerender({ onReady, ...selected }, strict);
  return onReady;
}

async function rerender(
  props: { readonly onReady: () => void } & GitHubCloudSelectedAccount,
  strict = false,
): Promise<void> {
  const tree = (
    <GitHubTestHost client={client} github={github} brand={canopyBrand}>
      <Consumer cloudGitEnabled {...props} />
    </GitHubTestHost>
  );
  await act(async () => {
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
}

function find(testId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!element) throw new Error(`missing [data-testid="${testId}"]`);
  return element;
}

function has(testId: string): boolean {
  return container.querySelector(`[data-testid="${testId}"]`) !== null;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

beforeEach(() => {
  requests = [];
  taken = new Set();
  installFetch();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/chat');
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

describe('a consuming wrapper around the Connect step and reauth notice', () => {
  describe('flag off', () => {
    it('renders nothing and sends no request, even though the backend would answer ready', async () => {
      const onReady = jest.fn();
      await act(async () => {
        root.render(
          <GitHubTestHost client={client} github={github} brand={canopyBrand}>
            <Consumer cloudGitEnabled={false} onReady={onReady} />
          </GitHubTestHost>,
        );
      });

      expect(container.innerHTML).toBe('');
      expect(requests).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(onReady).not.toHaveBeenCalled();
    });

    it('stays absent and quiet across re-renders', async () => {
      const onReady = jest.fn();
      for (let pass = 0; pass < 3; pass += 1) {
        await act(async () => {
          root.render(
            <GitHubTestHost client={client} github={github} brand={canopyBrand}>
              <Consumer cloudGitEnabled={false} onReady={onReady} />
            </GitHubTestHost>,
          );
        });
      }

      expect(container.innerHTML).toBe('');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(onReady).not.toHaveBeenCalled();
    });

    it('drops the step, the notice and every pending request when the flag turns off', async () => {
      const onReady = await mount();
      expect(has('github-cloud-connect-step')).toBe(true);

      await act(async () => {
        root.render(
          <GitHubTestHost client={client} github={github} brand={canopyBrand}>
            <Consumer cloudGitEnabled={false} onReady={onReady} />
          </GitHubTestHost>,
        );
      });
      // A late answer to the read the wrapper abandoned changes nothing.
      await take('GET', CONNECTION).respond(200, READY);

      expect(container.innerHTML).toBe('');
      expect(calls('POST', VERIFY)).toHaveLength(0);
      expect(onReady).not.toHaveBeenCalled();
    });
  });

  describe('flag on', () => {
    it('mounts one controller for the notice and the step: one read, one live check, even under Strict Mode', async () => {
      const onReady = await mount({}, true);
      expect(calls('GET', CONNECTION)).toHaveLength(1);

      await take('GET', CONNECTION).respond(200, NEEDS_REAUTH);
      // Both views are on screen and share the one answer.
      expect(has('github-cloud-reauth-notice')).toBe(true);
      expect(has('github-cloud-connect-step')).toBe(true);
      expect(calls('POST', VERIFY)).toHaveLength(1);

      await take('POST', VERIFY).respond(200, NEEDS_REAUTH);
      expect(requests).toHaveLength(2);
      expect(onReady).not.toHaveBeenCalled();
    });

    it('notifies once when the fresh live check finds an adopted, usable account', async () => {
      const onReady = await mount();
      await take('GET', CONNECTION).respond(200, READY);
      // The stored snapshot is not enough.
      expect(onReady).not.toHaveBeenCalled();
      expect(find('github-cloud-status').textContent).toBe(
        'Checking with GitHub…',
      );

      await take('POST', VERIFY).respond(200, READY);
      expect(find('github-cloud-status').textContent).toBe('GitHub connected');
      expect(onReady).toHaveBeenCalledTimes(1);

      // A later Check again that still finds it ready does not announce again.
      await rerender({ onReady });
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('stays unready and silent when the live check fails, then notifies once on recovery', async () => {
      const onReady = await mount();
      await take('GET', CONNECTION).respond(200, READY);
      await take('POST', VERIFY).respond(502, { code: 'github-unavailable' });

      expect(onReady).not.toHaveBeenCalled();
      expect(find('github-cloud-error').textContent).toContain(
        "Couldn't reach GitHub. Try again.",
      );
      expect(find('github-cloud-error').textContent).toContain(
        'Showing the last known status.',
      );

      await click(find('github-cloud-check-again'));
      await take('POST', VERIFY).respond(200, READY);
      expect(find('github-cloud-status').textContent).toBe('GitHub connected');
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('shows the reauth notice beside the step and Reconnect GitHub sends one Connect', async () => {
      const onReady = await mount();
      await take('GET', CONNECTION).respond(200, NEEDS_REAUTH);
      await take('POST', VERIFY).respond(200, NEEDS_REAUTH);

      const reconnect = find('github-cloud-reauth-reconnect');
      await click(reconnect);
      expect(calls('POST', CONNECT)).toHaveLength(1);
      // The notice shows the busy label while Connect runs.
      expect(find('github-cloud-reauth-reconnect').textContent).toBe(
        'Connecting…',
      );

      await take('POST', CONNECT).respond(200, {
        connection: READY,
        next: 'done',
      });
      // The state is reconnected: the notice ends and the step is ready.
      expect(has('github-cloud-reauth-notice')).toBe(false);
      expect(find('github-cloud-status').textContent).toBe('GitHub connected');
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('never notifies for a Connect that is done but still awaiting Core adoption, then notifies once it is adopted', async () => {
      const onReady = await mount();
      await take('GET', CONNECTION).respond(200, NEEDS_REAUTH);
      await take('POST', VERIFY).respond(200, NEEDS_REAUTH);

      await click(find('github-cloud-reauth-reconnect'));
      await take('POST', CONNECT).respond(200, {
        connection: PENDING,
        next: 'done',
      });

      // `done` is not readiness: the step offers Check again, not a reinstall.
      expect(find('github-cloud-status').textContent).toContain(
        'Finishing setup',
      );
      expect(has('github-cloud-install')).toBe(false);
      expect(onReady).not.toHaveBeenCalled();

      await click(find('github-cloud-check-again'));
      await take('POST', VERIFY).respond(200, PENDING);
      expect(onReady).not.toHaveBeenCalled();

      await click(find('github-cloud-check-again'));
      await take('POST', VERIFY).respond(200, READY);
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('does not notify for a ready connection whose selected account is not active', async () => {
      const connection: GitHubCloudConnectionDto = {
        ...READY,
        targets: [
          target(),
          target({
            id: '6f1c2c1e-0000-4000-8000-000000000002',
            installationId: '2002',
            accountLogin: 'acme',
            accountType: 'Organization',
            state: 'SUSPENDED',
          }),
        ],
      };
      const onReady = await mount({ selectedInstallationId: '2002' });
      await take('GET', CONNECTION).respond(200, connection);
      await take('POST', VERIFY).respond(200, connection);

      expect(onReady).not.toHaveBeenCalled();
      expect(find('github-cloud-status').textContent).toContain(
        'GitHub app needs attention',
      );

      // The consumer picks the account that is active: the step is ready.
      await rerender({ onReady, selectedInstallationId: '1001' });
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('recovers after a reinstall: the removed row stays listed, the new one makes the owner ready', async () => {
      const acme = (
        id: string,
        installationId: string,
        state: 'REMOVED' | 'ACTIVE',
      ): GitHubCloudTargetDto =>
        target({
          id,
          installationId,
          accountLogin: 'acme',
          accountType: 'Organization',
          state,
        });
      const removedOnly: GitHubCloudConnectionDto = {
        ...READY,
        targets: [
          target(),
          acme('6f1c2c1e-0000-4000-8000-000000000002', '2002', 'REMOVED'),
        ],
      };
      const reinstalled: GitHubCloudConnectionDto = {
        ...READY,
        targets: [
          target(),
          acme('6f1c2c1e-0000-4000-8000-000000000002', '2002', 'REMOVED'),
          acme('6f1c2c1e-0000-4000-8000-000000000004', '9009', 'ACTIVE'),
        ],
      };
      const onReady = await mount({ selectedAccountLogin: 'acme' });
      await take('GET', CONNECTION).respond(200, removedOnly);
      await take('POST', VERIFY).respond(200, removedOnly);
      expect(find('github-cloud-status').textContent).toContain(
        'GitHub app needed',
      );
      expect(onReady).not.toHaveBeenCalled();

      // The user installed the app again in another tab and checks again.
      await click(find('github-cloud-check-again'));
      await take('POST', VERIFY).respond(200, reinstalled);
      expect(find('github-cloud-status').textContent).toBe('GitHub connected');
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('does not let another usable account stand in for an owner that is not installed', async () => {
      // octocat is ACTIVE and ready; the selected owner "acme" has no
      // installation, so the step asks to install the app and never notifies.
      const onReady = await mount({ selectedAccountLogin: 'acme' });
      await take('GET', CONNECTION).respond(200, READY);
      await take('POST', VERIFY).respond(200, READY);

      expect(onReady).not.toHaveBeenCalled();
      expect(find('github-cloud-status').textContent).toContain(
        'GitHub app needed',
      );
      expect(find('github-cloud-install').textContent).toBe(
        'Install GitHub app',
      );

      // The consumer's owner is the connected account, in another case.
      await rerender({ onReady, selectedAccountLogin: 'OCTOCAT' });
      expect(find('github-cloud-status').textContent).toBe('GitHub connected');
      expect(onReady).toHaveBeenCalledTimes(1);
    });
  });
});

/** @jest-environment ./packages/ui-app/src/settings/github/__tests__/helpers/web-fetch-jsdom-environment.ts */
/* eslint-disable @typescript-eslint/require-await -- act() callbacks stay async so React flushes the settled promises they trigger. */
import { act, StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GitHubCloudConnectionDto } from '@canopy/protocol/settings/account-github';
import { GITHUB_CLOUD_ERROR_COPY } from '@canopy/protocol/settings/github-cloud-errors';
import {
  GITHUB_CLOUD_ACTION_ERROR_COPY,
  GITHUB_CLOUD_UNAVAILABLE_COPY,
} from '../github-cloud-api';
import {
  GITHUB_CLOUD_LINK_FAILED_COPY,
  GITHUB_CLOUD_LINK_MARKER_KEY,
  GITHUB_CLOUD_LINKED_ELSEWHERE_COPY,
  GITHUB_CLOUD_REQUESTED_COPY,
  GITHUB_CLOUD_SETUP_FAILED_COPY,
  useGitHubCloudConnection,
  type GitHubCloudConnectionController,
  type UseGitHubCloudConnectionOptions,
} from '../use-github-cloud-connection';
import {
  createFetchBackedGitHubPorts,
  createFetchBackedSettingsClient,
  GitHubTestHost,
  type TestBackendFetch,
  type TestLinkSocial,
} from './helpers/github-test-host';

type LinkSocialResult = Awaited<ReturnType<TestLinkSocial>>;

// The web GitHub host's `authClient.linkSocial`, as the harness wires it.
const mockLinkSocial = jest.fn<
  ReturnType<TestLinkSocial>,
  Parameters<TestLinkSocial>
>();
// The backend (paths after `/api`) behind the settings client.
const fetchMock = jest.fn<
  ReturnType<TestBackendFetch>,
  Parameters<TestBackendFetch>
>();
const client = createFetchBackedSettingsClient(fetchMock);
const github = createFetchBackedGitHubPorts(fetchMock, mockLinkSocial);

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const CONNECTION = '/cloud/github/connection';
const CONNECT = '/cloud/github/connection/connect';
const VERIFY = '/cloud/github/connection/install-verify';
const PAGE = '/account/integrations?tab=github';
const INSTALL_URL =
  'https://github.com/apps/unstoppable-code/installations/new?state=signed';
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize?state=x';

const TARGET = {
  id: '6f1c2c1e-0000-4000-8000-000000000001',
  installationId: '1001',
  accountLogin: 'octocat',
  accountType: 'User',
  repositorySelection: 'all',
  state: 'ACTIVE',
} as const;

const STORED_ACTIVE: GitHubCloudConnectionDto = {
  state: 'ACTIVE',
  githubLogin: 'octocat',
  verifiedAt: '2026-10-01T10:00:00.000Z',
  readyForProjects: true,
  targets: [TARGET],
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
const NEEDS_REAUTH: GitHubCloudConnectionDto = {
  ...STORED_ACTIVE,
  state: 'NEEDS_REAUTH',
  readyForProjects: false,
};
const ADOPTION_PENDING: GitHubCloudConnectionDto = {
  ...LIVE_ACTIVE,
  readyForProjects: false,
  targets: [{ ...TARGET, state: 'PENDING_ADOPTION' }],
};

// ---------------------------------------------------------------------------
// Real promise ordering: every request stays pending until the test answers.
// ---------------------------------------------------------------------------

interface PendingRequest {
  readonly method: string;
  readonly path: string;
  readonly init: RequestInit;
  respond(status: number, body: unknown): Promise<void>;
  fail(error: unknown): Promise<void>;
}

let requests: PendingRequest[] = [];
let taken = new Set<PendingRequest>();

function installFetch(): void {
  fetchMock.mockImplementation((path, init) => {
    let resolve: (response: Response) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<Response>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    requests.push({
      method: init?.method ?? 'GET',
      path,
      init: init ?? {},
      respond: (status, body) =>
        act(async () => {
          resolve(Response.json(body, { status }));
        }),
      fail: (error) =>
        act(async () => {
          reject(error);
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

/** The oldest request for `method path` the test has not answered yet. */
function take(method: string, path: string): PendingRequest {
  const request = calls(method, path).find((entry) => !taken.has(entry));
  if (!request) throw new Error(`no pending ${method} ${path}`);
  taken.add(request);
  return request;
}

function bodyOf(request: PendingRequest): unknown {
  return typeof request.init.body === 'string'
    ? JSON.parse(request.init.body)
    : undefined;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const results: GitHubCloudConnectionController[] = [];
const navigate = jest.fn<void, [string]>();

function Probe({
  index,
  ...options
}: UseGitHubCloudConnectionOptions & { index: number }): null {
  const controller = useGitHubCloudConnection(options);
  useEffect(() => {
    results[index] = controller;
  });
  return null;
}

let root: Root;
let container: HTMLDivElement;
let userCount = 0;
let userId = 'user-0';

function current(index = 0): GitHubCloudConnectionController {
  const result = results[index];
  if (!result) throw new Error(`consumer ${index} never rendered`);
  return result;
}

async function mount(
  options: { strict?: boolean; consumers?: number; user?: string } = {},
): Promise<void> {
  const consumers = Array.from({ length: options.consumers ?? 1 }, (_, i) => (
    <Probe
      key={i}
      index={i}
      userId={options.user ?? userId}
      navigate={navigate}
    />
  ));
  await act(async () => {
    root.render(
      <GitHubTestHost client={client} github={github}>
        {options.strict ? (
          <StrictMode>{consumers}</StrictMode>
        ) : (
          <>{consumers}</>
        )}
      </GitHubTestHost>,
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {});
}

/**
 * Starts an action inside `act` without waiting for it. The promise is boxed:
 * an async function returning it would adopt (and so await) it.
 */
async function start<T>(
  action: () => Promise<T>,
): Promise<{ done: Promise<T> }> {
  let done: Promise<T> = new Promise<T>(() => undefined);
  await act(async () => {
    done = action();
  });
  return { done };
}

function setPage(path: string): void {
  window.history.replaceState(null, '', path);
}

/** What `linkSocial` answers with `disableRedirect: true`. */
function linkRedirect(): LinkSocialResult {
  return { data: { url: AUTHORIZE_URL, redirect: false }, error: null };
}

/** The one-shot marker an in-app link writes right before `linkSocial`. */
function armLinkMarker(
  intent: 'connect' | 'install' = 'connect',
  user: string = userId,
): void {
  window.sessionStorage.setItem(
    GITHUB_CLOUD_LINK_MARKER_KEY,
    JSON.stringify({ userId: user, intent, continuationGeneration: 17 }),
  );
}

function storedMarker(): unknown {
  const raw = window.sessionStorage.getItem(GITHUB_CLOUD_LINK_MARKER_KEY);
  return raw === null ? null : JSON.parse(raw);
}

/** linkSocial stays pending until the test answers it. */
function pendingLink(): (result: LinkSocialResult) => Promise<void> {
  let resolve: (result: LinkSocialResult) => void = () => undefined;
  mockLinkSocial.mockImplementation(
    () =>
      new Promise<LinkSocialResult>((res) => {
        resolve = res;
      }),
  );
  return (result) =>
    act(async () => {
      resolve(result);
    });
}

/** Mounts on a stored ACTIVE connection whose live check is still pending. */
async function mountActive(): Promise<PendingRequest> {
  await mount();
  await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
  return take('POST', VERIFY);
}

beforeEach(() => {
  requests = [];
  taken = new Set();
  results.length = 0;
  navigate.mockReset();
  mockLinkSocial.mockReset();
  installFetch();
  window.sessionStorage.clear();
  userCount += 1;
  userId = `user-${userCount}`;
  setPage(PAGE);
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
});

describe('Settings mount', () => {
  it('reads the stored status, then verifies it live', async () => {
    await mount();
    expect(current()).toMatchObject({
      connection: null,
      loading: true,
      checking: false,
      verified: false,
    });

    await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
    expect(current()).toMatchObject({
      connection: STORED_ACTIVE,
      loading: false,
      checking: true,
      verified: false,
      stale: false,
    });

    const verify = take('POST', VERIFY);
    await verify.respond(200, LIVE_ACTIVE);
    expect(current()).toMatchObject({
      connection: LIVE_ACTIVE,
      loading: false,
      checking: false,
      verified: true,
      stale: false,
      busy: null,
      error: null,
      notice: null,
    });
    expect(requests).toHaveLength(2);
  });

  it.each([
    ['NEEDS_REAUTH', NEEDS_REAUTH],
    ['NEEDS_INSTALL', { ...DISCONNECTED, state: 'NEEDS_INSTALL' }],
  ] as const)('verifies a stored %s connection', async (_state, stored) => {
    await mount();
    await take('GET', CONNECTION).respond(200, stored);
    expect(calls('POST', VERIFY)).toHaveLength(1);
  });

  it('does not verify or reconnect a disconnected account', async () => {
    await mount();
    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    await flush();

    expect(current()).toMatchObject({
      connection: DISCONNECTED,
      loading: false,
      checking: false,
      verified: false,
    });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${CONNECTION}`,
    ]);
    expect(mockLinkSocial).not.toHaveBeenCalled();
  });

  it('keeps the last snapshot, marked stale, when the live check fails', async () => {
    const verify = await mountActive();
    await verify.respond(502, {
      error: "Couldn't reach GitHub. Try again.",
      code: 'github-unavailable',
    });

    expect(current()).toMatchObject({
      connection: STORED_ACTIVE,
      checking: false,
      verified: false,
      stale: true,
      error: {
        source: 'verify',
        code: 'github-unavailable',
        message: GITHUB_CLOUD_ERROR_COPY['github-unavailable'],
      },
    });
  });

  it('never displays an arbitrary error body', async () => {
    const verify = await mountActive();
    await verify.respond(409, {
      error: 'Bad credentials ghp_leakedtoken',
      code: 'ghp_leakedtoken',
    });

    expect(current().error).toEqual({
      source: 'verify',
      code: null,
      message: GITHUB_CLOUD_ACTION_ERROR_COPY.verify,
    });
    expect(JSON.stringify(current())).not.toContain('ghp_leakedtoken');
  });

  it('shows retryable copy for a failed first read, and reload recovers', async () => {
    await mount();
    await take('GET', CONNECTION).respond(503, {
      error: { code: 'database_unavailable' },
    });
    expect(current()).toMatchObject({
      connection: null,
      loading: false,
      error: { source: 'load', message: GITHUB_CLOUD_ACTION_ERROR_COPY.load },
    });

    await act(async () => {
      current().reload();
    });
    expect(current()).toMatchObject({ loading: true, error: null });
    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    expect(current()).toMatchObject({
      connection: DISCONNECTED,
      loading: false,
      error: null,
    });
  });

  it('does not strand loading under Strict Mode and sends one read', async () => {
    await mount({ strict: true });
    expect(calls('GET', CONNECTION)).toHaveLength(1);

    await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
    expect(current()).toMatchObject({ loading: false, checking: true });
    await take('POST', VERIFY).respond(200, LIVE_ACTIVE);
    expect(current()).toMatchObject({
      loading: false,
      checking: false,
      verified: true,
    });
    expect(requests).toHaveLength(2);
  });

  it('ignores responses that arrive after unmount', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    await mount();
    const read = take('GET', CONNECTION);
    const before = current();

    await act(async () => {
      root.unmount();
    });
    // The settings client takes no signal: the late answer is dropped.
    await read.respond(200, STORED_ACTIVE);

    expect(results[0]).toBe(before);
    expect(calls('POST', VERIFY)).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it('resets and reloads when the signed-in user changes', async () => {
    const verify = await mountActive();
    const nextUser = `${userId}-next`;

    await mount({ user: nextUser });
    expect(current()).toMatchObject({
      connection: null,
      loading: true,
      verified: false,
    });

    // The reset view stays one object across renders until the reset commits.
    const resetView = current();
    await mount({ user: nextUser });
    expect(current()).toBe(resetView);

    await verify.respond(200, LIVE_ACTIVE);
    expect(current().connection).toBeNull();

    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    expect(current()).toMatchObject({
      connection: DISCONNECTED,
      loading: false,
    });
  });
  it('drops the previous user busy action on a user change', async () => {
    await mount();
    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    await start(() => current().connect());
    const stale = take('POST', CONNECT);
    expect(current().busy).toBe('connect');

    await mount({ user: `${userId}-next` });
    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    expect(current().busy).toBeNull();

    await start(() => current().connect());
    expect(calls('POST', CONNECT)).toHaveLength(2);
    await stale.respond(200, { connection: LIVE_ACTIVE, next: 'done' });
    expect(current()).toMatchObject({
      connection: DISCONNECTED,
      busy: 'connect',
    });
  });
});

describe('Disconnect', () => {
  it('ignores a live check that answers after Disconnect', async () => {
    const verify = await mountActive();

    const disconnected = await start(() => current().disconnect());
    expect(current().busy).toBe('disconnect');
    await take('DELETE', CONNECTION).respond(200, DISCONNECTED);
    await expect(disconnected.done).resolves.toBe(true);

    await verify.respond(200, LIVE_ACTIVE);
    expect(current()).toMatchObject({
      connection: DISCONNECTED,
      busy: null,
      checking: false,
      verified: false,
    });
  });

  it('ignores a Connect that answers after Disconnect', async () => {
    const verify = await mountActive();
    await verify.respond(200, LIVE_ACTIVE);

    const connecting = await start(() => current().connect());
    await start(() => current().disconnect());
    await take('DELETE', CONNECTION).respond(200, DISCONNECTED);
    await take('POST', CONNECT).respond(200, {
      connection: NEEDS_REAUTH,
      next: 'reauth',
      continuationGeneration: 17,
    });
    await connecting.done;

    expect(mockLinkSocial).not.toHaveBeenCalled();
    expect(current()).toMatchObject({ connection: DISCONNECTED, busy: null });
  });

  it('keeps the connection and shows the error when Disconnect fails', async () => {
    const verify = await mountActive();
    await verify.respond(200, LIVE_ACTIVE);

    const disconnected = await start(() => current().disconnect());
    await take('DELETE', CONNECTION).respond(500, {
      error: 'Something went wrong. Try again.',
      code: 'internal_error',
    });

    await expect(disconnected.done).resolves.toBe(false);
    expect(current()).toMatchObject({
      connection: LIVE_ACTIVE,
      verified: true,
      busy: null,
      error: {
        source: 'disconnect',
        code: null,
        message: GITHUB_CLOUD_ACTION_ERROR_COPY.disconnect,
      },
    });
  });
});

describe('Connect', () => {
  it('links GitHub with callback markers, navigates itself and keeps busy while navigating', async () => {
    await mount();
    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    let markerAtLink: unknown = 'not called';
    mockLinkSocial.mockImplementation(async () => {
      markerAtLink = storedMarker();
      return linkRedirect();
    });

    await start(() => current().connect());
    expect(current().busy).toBe('connect');
    const connect = take('POST', CONNECT);
    expect(bodyOf(connect)).toEqual({ returnTo: PAGE, intent: 'connect' });
    await connect.respond(200, {
      connection: DISCONNECTED,
      next: 'link',
      continuationGeneration: 17,
    });

    expect(mockLinkSocial).toHaveBeenCalledWith({
      provider: 'github',
      callbackURL: `http://localhost${PAGE}&github_cloud=linked`,
      errorCallbackURL: `http://localhost${PAGE}&github_cloud=link_error`,
      disableRedirect: true,
    });
    // Written immediately before the link, for this user and intent.
    expect(markerAtLink).toEqual({
      userId,
      intent: 'connect',
      continuationGeneration: 17,
    });
    expect(navigate).toHaveBeenCalledWith(AUTHORIZE_URL);
    expect(current()).toMatchObject({ busy: 'connect', error: null });

    // Back/forward cache restore: the link was abandoned.
    await act(async () => {
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', { persisted: true }),
      );
    });
    expect(current().busy).toBeNull();
    expect(storedMarker()).toBeNull();
  });

  it.each(['disconnect', 'unmount'] as const)(
    'never navigates to GitHub after a %s while linkSocial is pending',
    async (interruption) => {
      await mount();
      await take('GET', CONNECTION).respond(200, DISCONNECTED);
      const answerLink = pendingLink();

      await start(() => current().connect());
      await take('POST', CONNECT).respond(200, {
        connection: DISCONNECTED,
        next: 'link',
        continuationGeneration: 17,
      });
      expect(mockLinkSocial).toHaveBeenCalledTimes(1);
      expect(storedMarker()).not.toBeNull();

      if (interruption === 'disconnect') {
        await start(() => current().disconnect());
        await take('DELETE', CONNECTION).respond(200, DISCONNECTED);
      } else {
        await act(async () => {
          root.unmount();
        });
      }
      await answerLink(linkRedirect());

      expect(navigate).not.toHaveBeenCalled();
      expect(storedMarker()).toBeNull();
      if (interruption === 'disconnect') {
        expect(current()).toMatchObject({
          connection: DISCONNECTED,
          busy: null,
          error: null,
        });
      } else {
        root = createRoot(container);
      }
    },
  );

  it('drops the link marker when Disconnect lands while the GitHub navigation is pending', async () => {
    await mount();
    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    mockLinkSocial.mockResolvedValue(linkRedirect());
    await start(() => current().connect());
    await take('POST', CONNECT).respond(200, {
      connection: DISCONNECTED,
      next: 'link',
      continuationGeneration: 17,
    });
    expect(navigate).toHaveBeenCalledWith(AUTHORIZE_URL);
    expect(storedMarker()).not.toBeNull();

    await start(() => current().disconnect());
    expect(storedMarker()).toBeNull();
    await take('DELETE', CONNECTION).respond(200, DISCONNECTED);
    expect(current()).toMatchObject({ connection: DISCONNECTED, busy: null });
  });

  it('reports a failed navigation to GitHub and clears busy', async () => {
    await mount();
    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    mockLinkSocial.mockResolvedValue(linkRedirect());
    navigate.mockImplementation(() => {
      throw new Error('navigation blocked');
    });

    await start(() => current().connect());
    await take('POST', CONNECT).respond(200, {
      connection: DISCONNECTED,
      next: 'link',
      continuationGeneration: 17,
    });

    expect(current()).toMatchObject({
      busy: null,
      error: { source: 'link', message: GITHUB_CLOUD_LINK_FAILED_COPY },
    });
    expect(storedMarker()).toBeNull();
  });

  it('follows next: reauth even when the stored state is ACTIVE', async () => {
    const verify = await mountActive();
    await verify.respond(200, LIVE_ACTIVE);
    mockLinkSocial.mockResolvedValue(linkRedirect());

    await start(() => current().connect());
    await take('POST', CONNECT).respond(200, {
      connection: LIVE_ACTIVE,
      next: 'reauth',
      continuationGeneration: 17,
    });

    expect(mockLinkSocial).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(AUTHORIZE_URL);
    expect(current()).toMatchObject({ verified: false, busy: 'connect' });
  });

  it.each([
    [
      'a returned error',
      (): Promise<LinkSocialResult> =>
        Promise.resolve({
          data: null,
          error: {
            status: 400,
            statusText: 'Bad Request',
            message: 'raw provider text',
          },
        }),
    ],
    [
      'a rejection',
      (): Promise<LinkSocialResult> =>
        Promise.reject(new Error('raw provider text')),
    ],
  ])('reports %s from linkSocial and clears busy', async (_case, outcome) => {
    await mount();
    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    mockLinkSocial.mockImplementation(outcome);

    await start(() => current().connect());
    await take('POST', CONNECT).respond(200, {
      connection: DISCONNECTED,
      next: 'link',
      continuationGeneration: 17,
    });

    expect(current()).toMatchObject({
      busy: null,
      error: {
        source: 'link',
        code: null,
        message: GITHUB_CLOUD_LINK_FAILED_COPY,
      },
    });
    expect(JSON.stringify(current())).not.toContain('raw provider text');
    expect(navigate).not.toHaveBeenCalled();
    expect(storedMarker()).toBeNull();
  });

  it('clears busy when linkSocial resolves without a URL to follow', async () => {
    await mount();
    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    mockLinkSocial.mockResolvedValue({
      data: { url: '', redirect: false },
      error: null,
    });

    await start(() => current().connect());
    await take('POST', CONNECT).respond(200, {
      connection: DISCONNECTED,
      next: 'link',
      continuationGeneration: 17,
    });

    expect(current()).toMatchObject({ busy: null, error: null });
    expect(navigate).not.toHaveBeenCalled();
    expect(storedMarker()).toBeNull();
  });

  it('navigates to the install URL and keeps busy only while navigation is pending', async () => {
    const verify = await mountActive();
    await verify.respond(200, LIVE_ACTIVE);

    await start(() => current().connect({ intent: 'install' }));
    const connect = take('POST', CONNECT);
    expect(bodyOf(connect)).toEqual({ returnTo: PAGE, intent: 'install' });
    await connect.respond(200, {
      connection: LIVE_ACTIVE,
      next: 'install',
      installUrl: INSTALL_URL,
    });

    expect(navigate).toHaveBeenCalledWith(INSTALL_URL);
    expect(current().busy).toBe('install');

    // Back/forward cache restore: the navigation is no longer pending.
    await act(async () => {
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', { persisted: true }),
      );
    });
    expect(current().busy).toBeNull();
    await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
    expect(current().connection).toEqual(STORED_ACTIVE);
  });

  it('treats done as fresh but never as project-ready on its own', async () => {
    await mount();
    await take('GET', CONNECTION).respond(200, DISCONNECTED);

    await start(() => current().connect());
    await take('POST', CONNECT).respond(200, {
      connection: ADOPTION_PENDING,
      next: 'done',
    });

    expect(current()).toMatchObject({
      connection: ADOPTION_PENDING,
      verified: true,
      busy: null,
      error: null,
    });
    expect(current().connection?.readyForProjects).toBe(false);
  });

  it('maps a typed Connect failure to its copy', async () => {
    await mount();
    await take('GET', CONNECTION).respond(200, DISCONNECTED);

    await start(() => current().connect());
    await take('POST', CONNECT).respond(429, {
      error: 'GitHub rate limit reached. Try again in a minute.',
      code: 'github-rate-limited',
    });

    expect(current()).toMatchObject({
      busy: null,
      error: {
        source: 'connect',
        code: 'github-rate-limited',
        message: GITHUB_CLOUD_ERROR_COPY['github-rate-limited'],
      },
    });
  });

  it('starts one Connect at a time', async () => {
    await mount();
    await take('GET', CONNECTION).respond(200, DISCONNECTED);

    await start(() => current().connect());
    await start(() => current().connect());
    await start(() => current().verify());

    expect(calls('POST', CONNECT)).toHaveLength(1);
    expect(calls('POST', VERIFY)).toHaveLength(0);
  });

  it('invalidates the mount read it overtakes', async () => {
    await mount();
    const read = take('GET', CONNECTION);

    await start(() => current().connect());
    await take('POST', CONNECT).respond(200, {
      connection: LIVE_ACTIVE,
      next: 'done',
    });
    await read.respond(200, DISCONNECTED);

    expect(current()).toMatchObject({
      connection: LIVE_ACTIVE,
      loading: false,
      verified: true,
    });
    expect(calls('POST', VERIFY)).toHaveLength(0);
  });
});

describe('Check again', () => {
  it('verifies live and reports the busy action', async () => {
    const verify = await mountActive();
    await verify.respond(200, LIVE_ACTIVE);

    await start(() => current().verify());
    expect(current()).toMatchObject({ busy: 'verify', checking: true });
    await take('POST', VERIFY).respond(200, ADOPTION_PENDING);

    expect(current()).toMatchObject({
      connection: ADOPTION_PENDING,
      busy: null,
      checking: false,
      verified: true,
    });
  });
});

describe('callback continuation', () => {
  it.each([undefined, null, '17', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'does not continue a link with an invalid or legacy fence (%p)',
    async (continuationGeneration) => {
      window.sessionStorage.setItem(
        GITHUB_CLOUD_LINK_MARKER_KEY,
        JSON.stringify({
          userId,
          intent: 'connect',
          continuationGeneration,
        }),
      );
      setPage(`${PAGE}&github_cloud=linked`);
      await mount();
      expect(calls('POST', CONNECT)).toHaveLength(0);
      await take('GET', CONNECTION).respond(200, DISCONNECTED);
      expect(current()).toMatchObject({ connection: DISCONNECTED, busy: null });
      expect(storedMarker()).toBeNull();
    },
  );

  it('keeps Disconnect when the server rejects a superseded OAuth continuation', async () => {
    armLinkMarker();
    setPage(`${PAGE}&github_cloud=linked`);
    await mount();
    const connect = take('POST', CONNECT);
    expect(bodyOf(connect)).toEqual({
      returnTo: PAGE,
      intent: 'connect',
      continuationGeneration: 17,
    });
    await connect.respond(409, { code: 'github-cloud-operation-superseded' });
    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    expect(current()).toMatchObject({
      connection: DISCONNECTED,
      busy: null,
      error: { code: 'github-cloud-operation-superseded' },
    });
    expect(mockLinkSocial).not.toHaveBeenCalled();
    expect(calls('POST', VERIFY)).toHaveLength(0);
  });

  it('continues Connect once after an in-app link, and strips only the Cloud Git parameters', async () => {
    armLinkMarker('install');
    setPage(`${PAGE}&github_cloud=linked&github_cloud_intent=install`);
    await mount();

    expect(storedMarker()).toBeNull();

    expect(window.location.pathname + window.location.search).toBe(PAGE);
    expect(calls('GET', CONNECTION)).toHaveLength(0);
    expect(current()).toMatchObject({ loading: true, busy: 'install' });
    const connect = take('POST', CONNECT);
    expect(bodyOf(connect)).toEqual({
      returnTo: PAGE,
      intent: 'install',
      continuationGeneration: 17,
    });

    await connect.respond(200, {
      connection: LIVE_ACTIVE,
      next: 'install',
      installUrl: INSTALL_URL,
    });
    expect(navigate).toHaveBeenCalledWith(INSTALL_URL);
    expect(current()).toMatchObject({
      connection: LIVE_ACTIVE,
      loading: false,
      busy: 'install',
    });
  });

  it('continues a link callback once under Strict Mode', async () => {
    armLinkMarker();
    setPage(`${PAGE}&github_cloud=linked`);
    await mount({ strict: true });

    expect(calls('POST', CONNECT)).toHaveLength(1);
    await take('POST', CONNECT).respond(200, {
      connection: LIVE_ACTIVE,
      next: 'done',
    });
    expect(current()).toMatchObject({
      connection: LIVE_ACTIVE,
      loading: false,
      verified: true,
      busy: null,
    });
    expect(calls('POST', VERIFY)).toHaveLength(0);
  });

  it('lets only one of two mounted consumers continue, and the other does not verify meanwhile', async () => {
    armLinkMarker();
    setPage(`${PAGE}&github_cloud=linked`);
    await mount({ consumers: 2 });

    expect(calls('POST', CONNECT)).toHaveLength(1);
    expect(calls('GET', CONNECTION)).toHaveLength(1);
    await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
    expect(calls('POST', VERIFY)).toHaveLength(0);
    expect(current(1)).toMatchObject({
      connection: STORED_ACTIVE,
      verified: false,
      checking: false,
    });

    await take('POST', CONNECT).respond(200, {
      connection: LIVE_ACTIVE,
      next: 'done',
    });
    expect(current(0)).toMatchObject({
      connection: LIVE_ACTIVE,
      verified: true,
    });
    expect(window.location.search).toBe('?tab=github');
  });

  it('does not loop back to GitHub when Connect still needs a link', async () => {
    armLinkMarker();
    setPage(`${PAGE}&github_cloud=linked`);
    await mount();

    await take('POST', CONNECT).respond(200, {
      connection: DISCONNECTED,
      next: 'link',
      continuationGeneration: 17,
    });

    expect(mockLinkSocial).not.toHaveBeenCalled();
    expect(current()).toMatchObject({
      connection: DISCONNECTED,
      loading: false,
      busy: null,
      error: { source: 'link', message: GITHUB_CLOUD_LINK_FAILED_COPY },
    });
  });

  it('reads the stored status, without verifying, when the continued Connect fails', async () => {
    armLinkMarker();
    setPage(`${PAGE}&github_cloud=linked`);
    await mount();

    await take('POST', CONNECT).respond(502, {
      error: "Couldn't reach GitHub. Try again.",
      code: 'github-unavailable',
    });
    expect(current().error).toEqual({
      source: 'connect',
      code: 'github-unavailable',
      message: GITHUB_CLOUD_ERROR_COPY['github-unavailable'],
    });
    await take('GET', CONNECTION).respond(200, NEEDS_REAUTH);

    expect(current()).toMatchObject({
      connection: NEEDS_REAUTH,
      loading: false,
      busy: null,
      verified: false,
    });
    expect(calls('POST', VERIFY)).toHaveLength(0);
  });

  it('shows the owner-approval notice and verifies', async () => {
    setPage(`${PAGE}&github_cloud=requested`);
    await mount();

    expect(current().notice).toEqual({
      kind: 'requested',
      message: GITHUB_CLOUD_REQUESTED_COPY,
    });
    await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
    await take('POST', VERIFY).respond(200, LIVE_ACTIVE);
    expect(current()).toMatchObject({ verified: true, error: null });

    await act(async () => {
      current().dismissNotice();
    });
    expect(current().notice).toBeNull();
  });

  it('explains rollout availability without repeating it as an error', async () => {
    setPage(`${PAGE}&github_cloud=unavailable`);
    await mount();

    expect(current().notice).toEqual({
      kind: 'unavailable',
      message: GITHUB_CLOUD_UNAVAILABLE_COPY,
    });
    await take('GET', CONNECTION).respond(404, { error: 'not found' });
    expect(current()).toMatchObject({ loading: false, error: null });
  });

  it.each([
    [
      'github_cloud_reason=github-cloud-state-invalid',
      'github-cloud-state-invalid',
      GITHUB_CLOUD_ERROR_COPY['github-cloud-state-invalid'],
    ],
    [
      'github_cloud_reason=internal_error',
      null,
      GITHUB_CLOUD_SETUP_FAILED_COPY,
    ],
    [
      'github_cloud_reason=%3Cscript%3Eghp_leak',
      null,
      GITHUB_CLOUD_SETUP_FAILED_COPY,
    ],
  ])(
    'shows safe copy for a Setup error (%s)',
    async (reason, code, message) => {
      setPage(`${PAGE}&github_cloud=error&${reason}`);
      await mount();

      expect(current().error).toEqual({ source: 'setup', code, message });
      expect(JSON.stringify(current())).not.toContain('ghp_leak');
      expect(window.location.search).toBe('?tab=github');
      await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
      expect(calls('POST', VERIFY)).toHaveLength(1);
    },
  );

  it.each([
    [
      'account_already_linked_to_different_user',
      GITHUB_CLOUD_LINKED_ELSEWHERE_COPY,
    ],
    ['unable_to_link_account', GITHUB_CLOUD_LINK_FAILED_COPY],
  ])('shows safe copy for link error %s', async (betterAuthError, message) => {
    armLinkMarker();
    setPage(
      `${PAGE}&github_cloud=link_error&error=${betterAuthError}&error_description=raw`,
    );
    await mount();

    expect(current().error).toEqual({ source: 'link', code: null, message });
    expect(storedMarker()).toBeNull();
    expect(window.location.search).toBe('?tab=github');
    expect(mockLinkSocial).not.toHaveBeenCalled();
    expect(calls('POST', CONNECT)).toHaveLength(0);
  });

  it('continues nothing on a later mount once consumed', async () => {
    armLinkMarker();
    setPage(`${PAGE}&github_cloud=linked`);
    await mount();
    await take('POST', CONNECT).respond(200, {
      connection: LIVE_ACTIVE,
      next: 'done',
    });
    await act(async () => {
      root.unmount();
    });

    root = createRoot(container);
    await mount();
    expect(calls('POST', CONNECT)).toHaveLength(1);
    expect(calls('GET', CONNECTION)).toHaveLength(1);
  });

  it('never replays an interrupted continuation on a later mount of the same URL', async () => {
    armLinkMarker();
    setPage(`${PAGE}&github_cloud=linked`);
    await mount();
    const interrupted = take('POST', CONNECT);
    await act(async () => {
      root.unmount();
    });

    // Even a fresh marker (a new in-app link in this tab) is not a replay.
    armLinkMarker();
    root = createRoot(container);
    await mount();
    expect(calls('POST', CONNECT)).toHaveLength(1);
    await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
    await take('POST', VERIFY).respond(200, LIVE_ACTIVE);
    expect(current()).toMatchObject({
      connection: LIVE_ACTIVE,
      verified: true,
    });

    await interrupted.respond(200, {
      connection: LIVE_ACTIVE,
      next: 'install',
      installUrl: INSTALL_URL,
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('only loads and verifies a crafted linked callback without the in-app marker', async () => {
    setPage(`${PAGE}&github_cloud=linked&github_cloud_intent=install`);
    await mount();

    expect(window.location.search).toBe('?tab=github');
    expect(current().busy).toBeNull();
    await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
    await take('POST', VERIFY).respond(200, LIVE_ACTIVE);

    expect(calls('POST', CONNECT)).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
    expect(current()).toMatchObject({
      connection: LIVE_ACTIVE,
      verified: true,
      busy: null,
      error: null,
    });
  });

  it('ignores a marker another user wrote in this tab', async () => {
    armLinkMarker('install', `${userId}-other`);
    setPage(`${PAGE}&github_cloud=linked&github_cloud_intent=install`);
    await mount();

    await take('GET', CONNECTION).respond(200, STORED_ACTIVE);
    expect(calls('POST', CONNECT)).toHaveLength(0);
    expect(storedMarker()).toBeNull();
  });

  it('drops a leftover marker on an ordinary mount', async () => {
    armLinkMarker('install');
    await mount();

    expect(storedMarker()).toBeNull();
    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    expect(calls('POST', CONNECT)).toHaveLength(0);
  });

  it('treats unavailable session storage as no marker and still links', async () => {
    const denied = (): never => {
      throw new DOMException('denied', 'SecurityError');
    };
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(denied);
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(denied);
    jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(denied);
    setPage(`${PAGE}&github_cloud=linked`);
    await mount();

    await take('GET', CONNECTION).respond(200, DISCONNECTED);
    expect(calls('POST', CONNECT)).toHaveLength(0);

    mockLinkSocial.mockResolvedValue(linkRedirect());
    await start(() => current().connect());
    await take('POST', CONNECT).respond(200, {
      connection: DISCONNECTED,
      next: 'link',
      continuationGeneration: 17,
    });
    expect(mockLinkSocial).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(AUTHORIZE_URL);
  });
});

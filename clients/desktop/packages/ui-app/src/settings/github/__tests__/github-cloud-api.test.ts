import type { GitHubCloudConnectionDto } from '@canopy/protocol/settings/account-github';
import { cloudRepositoryFailureCopy } from '@canopy/protocol/settings/cloud-repository-errors';
import type { GitHubCloudRepositoryPageDto } from '@canopy/protocol/settings/github-cloud-repository-listing';
import {
  GITHUB_CLOUD_ERROR_CODES,
  GITHUB_CLOUD_ERROR_COPY,
  GITHUB_CLOUD_ERROR_STATUS,
} from '@canopy/protocol/settings/github-cloud-errors';
import {
  disconnectGitHubCloud,
  fetchGitHubCloudConnection,
  fetchGitHubCloudRepositoryPage,
  fetchGitHubRepositoryCreationCapability,
  GITHUB_CLOUD_ACTION_ERROR_COPY,
  GITHUB_CLOUD_REPOSITORY_ACTION_ERROR_COPY,
  GITHUB_CLOUD_SIGNED_OUT_COPY,
  GITHUB_CLOUD_UNAVAILABLE_COPY,
  GitHubCloudApiError,
  gitHubCloudErrorMessage,
  GitHubCloudRepositoryApiError,
  gitHubCloudRepositoryErrorMessage,
  isGitHubCloudApiError,
  startGitHubCloudConnect,
  verifyGitHubCloudConnection,
} from '../github-cloud-api';
import { SettingsOperationError } from '@canopy/protocol/settings';
import { createFakeSettingsClient } from '../../__tests__/helpers/test-settings-host';
import {
  createFetchBackedGitHubPorts,
  createFetchBackedSettingsClient,
  type TestBackendFetch,
  type TestLinkSocial,
} from './helpers/github-test-host';

const ACTIVE: GitHubCloudConnectionDto = {
  state: 'ACTIVE',
  githubLogin: 'octocat',
  verifiedAt: '2026-10-05T10:00:00.000Z',
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

// The backend (paths after `/api`, like `fetchBackendUrl`) behind both the
// settings client the connection calls use and the GitHub host's repository
// transport.
const fetchMock = jest.fn<
  ReturnType<TestBackendFetch>,
  Parameters<TestBackendFetch>
>();
const client = createFetchBackedSettingsClient(fetchMock);
const repositories = createFetchBackedGitHubPorts(
  fetchMock,
  jest.fn<ReturnType<TestLinkSocial>, Parameters<TestLinkSocial>>(),
).repositories;

beforeEach(() => {
  fetchMock.mockReset();
});

function respond(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce(Response.json(body, { status }));
}

function respondText(status: number, text: string): void {
  fetchMock.mockResolvedValueOnce(new Response(text, { status }));
}

function lastInit(): RequestInit {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  return call[1] ?? {};
}

async function failure(
  promise: Promise<unknown>,
): Promise<GitHubCloudApiError> {
  const error: unknown = await promise.then(
    () => new Error('expected a rejection'),
    (reason: unknown) => reason,
  );
  if (!(error instanceof GitHubCloudApiError)) {
    throw new Error('expected a GitHubCloudApiError');
  }
  return error;
}

describe('requests', () => {
  it('reads the stored connection through its settings entry, with the session', async () => {
    respond(200, ACTIVE);
    const controller = new AbortController();
    const read = jest.spyOn(client, 'read');

    await expect(
      fetchGitHubCloudConnection(client, controller.signal),
    ).resolves.toEqual(ACTIVE);

    expect(read).toHaveBeenCalledWith('account.github.connection.read', {});
    read.mockRestore();
    expect(fetchMock).toHaveBeenCalledWith(
      '/cloud/github/connection',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
    expect(lastInit().body).toBeUndefined();
  });

  it('verifies live with a body-less POST', async () => {
    respond(200, ACTIVE);
    const controller = new AbortController();
    const write = jest.spyOn(client, 'write');

    await expect(
      verifyGitHubCloudConnection(client, controller.signal),
    ).resolves.toEqual(ACTIVE);

    expect(write).toHaveBeenCalledWith('account.github.connection.verify', {});
    write.mockRestore();
    expect(fetchMock).toHaveBeenCalledWith(
      '/cloud/github/connection/install-verify',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    expect(lastInit().body).toBeUndefined();
  });

  it('starts Connect with exactly the allowed JSON body', async () => {
    respond(200, { connection: ACTIVE, next: 'done' });

    await expect(
      startGitHubCloudConnect(client, {
        returnTo: '/account/integrations?tab=github',
      }),
    ).resolves.toEqual({ connection: ACTIVE, next: 'done' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/cloud/github/connection/connect',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    expect(new Headers(lastInit().headers).get('Content-Type')).toBe(
      'application/json',
    );
    expect(lastInit().body).toBe(
      JSON.stringify({ returnTo: '/account/integrations?tab=github' }),
    );

    respond(200, {
      connection: ACTIVE,
      next: 'install',
      installUrl: 'https://github.com/apps/x/installations/new?state=s',
    });
    await startGitHubCloudConnect(client, {
      returnTo: '/account/integrations',
      intent: 'install',
    });
    expect(lastInit().body).toBe(
      JSON.stringify({ returnTo: '/account/integrations', intent: 'install' }),
    );
  });

  it('disconnects with DELETE and returns the projection', async () => {
    const disconnected: GitHubCloudConnectionDto = {
      state: 'DISCONNECTED',
      githubLogin: null,
      verifiedAt: null,
      readyForProjects: false,
      targets: [],
    };
    respond(200, disconnected);

    await expect(disconnectGitHubCloud(client)).resolves.toEqual(disconnected);

    expect(fetchMock).toHaveBeenCalledWith(
      '/cloud/github/connection',
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    );
    expect(lastInit().body).toBeUndefined();
  });
});

describe('response validation', () => {
  it('rejects a success body that fails the DTO guard', async () => {
    respond(200, { ...ACTIVE, readyForProjects: 'yes' });
    const error = await failure(fetchGitHubCloudConnection(client));
    expect(error.kind).toBe('invalid-response');
    expect(error.code).toBeNull();
  });

  it('rejects a success body that is not JSON', async () => {
    respondText(200, '<html>gateway</html>');
    expect((await failure(verifyGitHubCloudConnection(client))).kind).toBe(
      'invalid-response',
    );
  });

  it('rejects an install step whose URL is not GitHub', async () => {
    respond(200, {
      connection: ACTIVE,
      next: 'install',
      installUrl: 'https://evil.example/apps/x',
    });
    expect(
      (await failure(startGitHubCloudConnect(client, { returnTo: '/account' })))
        .kind,
    ).toBe('invalid-response');
  });
});

describe('error bodies', () => {
  it.each(GITHUB_CLOUD_ERROR_CODES.map((code) => [code]))(
    'reads the allowlisted code %s at its contract status',
    async (code) => {
      respond(GITHUB_CLOUD_ERROR_STATUS[code], {
        error: 'server text that must never be shown',
        code,
      });
      const error = await failure(verifyGitHubCloudConnection(client));
      expect(error.kind).toBe('typed');
      expect(error.code).toBe(code);
      expect(error.status).toBe(GITHUB_CLOUD_ERROR_STATUS[code]);
      expect(error.message).not.toContain('server text');
      expect(gitHubCloudErrorMessage(error, 'verify')).toBe(
        GITHUB_CLOUD_ERROR_COPY[code],
      );
    },
  );

  it('never treats an arbitrary string code as safe, nor shows its error text', async () => {
    respond(409, { error: 'Bad credentials ghp_leaked', code: 'ghp_leaked' });
    const error = await failure(
      startGitHubCloudConnect(client, { returnTo: '/' }),
    );
    expect(error.kind).toBe('http');
    expect(error.code).toBeNull();
    expect(error.status).toBe(409);
    expect(JSON.stringify(error)).not.toContain('ghp_leaked');
    expect(error.message).not.toContain('ghp_leaked');
    const message = gitHubCloudErrorMessage(error, 'connect');
    expect(message).toBe(GITHUB_CLOUD_ACTION_ERROR_COPY.connect);
    expect(message).not.toContain('Bad credentials');
  });

  it('does not accept an allowlisted code at a status the contract never uses', async () => {
    respond(500, { error: 'x', code: 'github-cloud-needs-reauth' });
    const error = await failure(verifyGitHubCloudConnection(client));
    expect(error.kind).toBe('http');
    expect(error.code).toBeNull();
  });

  it('tolerates the cloud wrapper 503 with an object-valued error', async () => {
    respond(503, { error: { code: 'database_unavailable' } });
    const error = await failure(fetchGitHubCloudConnection(client));
    expect(error.kind).toBe('http');
    expect(error.status).toBe(503);
    expect(error.code).toBeNull();
    expect(gitHubCloudErrorMessage(error, 'load')).toBe(
      GITHUB_CLOUD_ACTION_ERROR_COPY.load,
    );
  });

  it('maps the route-level codes and a non-JSON body to generic copy', async () => {
    respond(500, {
      error: 'Something went wrong. Try again.',
      code: 'internal_error',
    });
    expect(
      gitHubCloudErrorMessage(
        await failure(disconnectGitHubCloud(client)),
        'disconnect',
      ),
    ).toBe(GITHUB_CLOUD_ACTION_ERROR_COPY.disconnect);

    respond(400, {
      error: "Couldn't process that request.",
      code: 'invalid_request',
    });
    expect(
      (await failure(startGitHubCloudConnect(client, { returnTo: '/' }))).code,
    ).toBeNull();

    respondText(502, 'Bad gateway');
    const error = await failure(verifyGitHubCloudConnection(client));
    expect(error.kind).toBe('http');
    expect(error.status).toBe(502);
  });

  it('reads a 404 as not available for this account', async () => {
    respond(404, { error: 'not found' });
    const error = await failure(fetchGitHubCloudConnection(client));
    expect(error.kind).toBe('unavailable');
    expect(gitHubCloudErrorMessage(error, 'load')).toBe(
      GITHUB_CLOUD_UNAVAILABLE_COPY,
    );
  });

  it('reads a 401 as a signed-out session', async () => {
    respond(401, { error: 'Unauthorized' });
    const error = await failure(verifyGitHubCloudConnection(client));
    expect(error.kind).toBe('unauthorized');
    expect(gitHubCloudErrorMessage(error, 'verify')).toBe(
      GITHUB_CLOUD_SIGNED_OUT_COPY,
    );
  });
});

describe('transport failures', () => {
  it('wraps a network failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const error = await failure(disconnectGitHubCloud(client));
    expect(error.kind).toBe('network');
    expect(error.status).toBeNull();
    expect(gitHubCloudErrorMessage(error, 'disconnect')).toBe(
      GITHUB_CLOUD_ACTION_ERROR_COPY.disconnect,
    );
  });

  it('passes an abort through untouched so callers can ignore it', async () => {
    const controller = new AbortController();
    const abort = new DOMException('Aborted', 'AbortError');
    fetchMock.mockImplementationOnce(() => {
      controller.abort(abort);
      return Promise.reject(abort);
    });
    await expect(
      fetchGitHubCloudConnection(client, controller.signal),
    ).rejects.toBe(abort);
  });

  it('rejects with the abort when the signal aborts while the settings call is pending', async () => {
    let answer: (response: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const controller = new AbortController();
    const abort = new DOMException('Aborted', 'AbortError');
    const pending = fetchGitHubCloudConnection(client, controller.signal);
    controller.abort(abort);

    await expect(pending).rejects.toBe(abort);
    // The late answer lands nowhere.
    answer(Response.json(ACTIVE));
  });

  it('rejects an already aborted call without reaching the settings client', async () => {
    const controller = new AbortController();
    const abort = new DOMException('Aborted', 'AbortError');
    controller.abort(abort);

    await expect(
      verifyGitHubCloudConnection(client, controller.signal),
    ).rejects.toBe(abort);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads a settings failure without an answer as a network failure', async () => {
    const offline = createFakeSettingsClient({
      'account.github.connection.verify': () => {
        throw new SettingsOperationError({ code: 'uncertain' });
      },
    });
    const error = await failure(verifyGitHubCloudConnection(offline));
    expect(error.kind).toBe('network');
    expect(error.status).toBeNull();
  });

  it('still refuses a body a host client answered loosely', async () => {
    const loose = createFakeSettingsClient({
      'account.github.connection.read': () => ({ state: 'ACTIVE' }),
    });
    const error = await failure(fetchGitHubCloudConnection(loose));
    expect(error.kind).toBe('invalid-response');
    expect(error.code).toBeNull();
  });

  it('maps anything that is not an API error to the action copy', () => {
    expect(isGitHubCloudApiError(new Error('boom'))).toBe(false);
    expect(gitHubCloudErrorMessage(new Error('ghp_leaked'), 'verify')).toBe(
      GITHUB_CLOUD_ACTION_ERROR_COPY.verify,
    );
    expect(gitHubCloudErrorMessage('ghp_leaked', 'load')).toBe(
      GITHUB_CLOUD_ACTION_ERROR_COPY.load,
    );
  });
});

// ---------------------------------------------------------------------------
// Repository listing and creation capability (REG-3021)
// ---------------------------------------------------------------------------

const PAGE: GitHubCloudRepositoryPageDto = {
  installationId: '1001',
  repositories: [
    {
      providerRepoId: '9007199254740993',
      ownerLogin: 'octocat',
      ownerType: 'User',
      name: 'widgets',
      fullName: 'octocat/widgets',
      private: true,
      visibility: 'private',
      archived: false,
      permission: 'admin',
      description: 'Widget factory',
      defaultBranch: 'main',
      updatedAt: '2026-10-05T10:00:00.000Z',
    },
  ],
  repositorySelection: 'all',
  totalCount: 1,
  nextCursor: null,
  searchIncomplete: false,
};

const CAPABILITY = {
  installationId: '1001',
  state: 'READY',
  checkedAt: '2026-10-05T10:00:00.000Z',
} as const;

async function repositoryFailure(
  promise: Promise<unknown>,
): Promise<GitHubCloudRepositoryApiError> {
  const error: unknown = await promise.then(
    () => new Error('expected a rejection'),
    (reason: unknown) => reason,
  );
  if (!(error instanceof GitHubCloudRepositoryApiError)) {
    throw new Error('expected a GitHubCloudRepositoryApiError');
  }
  return error;
}

function lastPath(): string {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  return String(call[0]);
}

describe('repository listing requests', () => {
  it('reads the first page with only the installation, never cached', async () => {
    respond(200, PAGE);
    const controller = new AbortController();

    await expect(
      fetchGitHubCloudRepositoryPage(
        repositories,
        { installationId: '1001', cursor: 1, query: '' },
        controller.signal,
      ),
    ).resolves.toEqual(PAGE);

    expect(fetchMock).toHaveBeenCalledWith(
      '/cloud/github/repositories?installationId=1001',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      }),
    );
    expect(lastInit().body).toBeUndefined();
  });

  it('sends a later cursor and the trimmed query, bounded to the route limit', async () => {
    respond(200, { ...PAGE, nextCursor: null });
    await fetchGitHubCloudRepositoryPage(repositories, {
      installationId: '1001',
      cursor: 4,
      query: '  wid get  ',
    });
    expect(lastPath()).toBe(
      '/cloud/github/repositories?installationId=1001&cursor=4&q=wid+get',
    );

    respond(200, PAGE);
    await fetchGitHubCloudRepositoryPage(repositories, {
      installationId: '1001',
      cursor: 1,
      query: 'x'.repeat(150),
    });
    const query = new URL(lastPath(), 'https://canopy.test').searchParams;
    expect(query.get('q')).toBe('x'.repeat(100));
  });

  it('reads the creation capability of one installation', async () => {
    respond(200, CAPABILITY);

    await expect(
      fetchGitHubRepositoryCreationCapability(repositories, '1001'),
    ).resolves.toEqual(CAPABILITY);

    expect(lastPath()).toBe(
      '/cloud/github/repositories/creation-capability?installationId=1001',
    );
    expect(lastInit()).toEqual(
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    );
  });
});

describe('repository page and capability guards', () => {
  it('tolerates additive fields on a page and its rows', async () => {
    const [row] = PAGE.repositories;
    respond(200, {
      ...PAGE,
      newField: true,
      repositories: [{ ...row, topics: ['x'] }],
    });
    const page = await fetchGitHubCloudRepositoryPage(repositories, {
      installationId: '1001',
      cursor: 1,
      query: '',
    });
    expect(page.repositories.map((entry) => entry.providerRepoId)).toEqual([
      '9007199254740993',
    ]);
  });

  it.each([
    ['another installation’s page', { ...PAGE, installationId: '2002' }],
    [
      'a numeric repository id',
      {
        ...PAGE,
        repositories: [{ ...PAGE.repositories[0], providerRepoId: 42 }],
      },
    ],
    [
      'a full name that is not owner/name',
      {
        ...PAGE,
        repositories: [{ ...PAGE.repositories[0], fullName: 'evil/widgets' }],
      },
    ],
    ['a cursor past the last page', { ...PAGE, nextCursor: 101 }],
    ['a missing searchIncomplete', { ...PAGE, searchIncomplete: undefined }],
  ])('rejects %s', async (_label, body) => {
    respond(200, body);
    const error = await repositoryFailure(
      fetchGitHubCloudRepositoryPage(repositories, {
        installationId: '1001',
        cursor: 1,
        query: '',
      }),
    );
    expect(error.kind).toBe('invalid-response');
    expect(error.code).toBeNull();
    expect(gitHubCloudRepositoryErrorMessage(error, 'list')).toBe(
      GITHUB_CLOUD_REPOSITORY_ACTION_ERROR_COPY.list,
    );
  });

  it.each([
    ['another installation', { ...CAPABILITY, installationId: '2002' }],
    ['an unknown state', { ...CAPABILITY, state: 'MAYBE' }],
    ['a non-ISO time', { ...CAPABILITY, checkedAt: 'yesterday' }],
  ])('rejects a capability for %s', async (_label, body) => {
    respond(200, body);
    const error = await repositoryFailure(
      fetchGitHubRepositoryCreationCapability(repositories, '1001'),
    );
    expect(error.kind).toBe('invalid-response');
  });
});

describe('repository request failures', () => {
  it('keeps a typed code, its fixed copy and only the allowlisted details', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: 'github-rate-limited',
            message: 'provider says ghp_leaked',
            retryable: true,
            details: {
              requestId: '3f2b8c1a-5d6e-4f70-8a9b-0c1d2e3f4a5b',
              token: 'ghp_leaked',
            },
          },
        },
        { status: 429, headers: { 'Retry-After': '60' } },
      ),
    );
    const error = await repositoryFailure(
      fetchGitHubCloudRepositoryPage(repositories, {
        installationId: '1001',
        cursor: 1,
        query: '',
      }),
    );
    expect(error.kind).toBe('typed');
    expect(error.status).toBe(429);
    expect(error.code).toBe('github-rate-limited');
    expect(error.retryable).toBe(true);
    // The client caps a Retry-After it will honour; it never re-sends by itself.
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.details).toEqual({
      requestId: '3f2b8c1a-5d6e-4f70-8a9b-0c1d2e3f4a5b',
    });
    expect(JSON.stringify(error)).not.toContain('ghp_leaked');
    expect(error.message).not.toContain('ghp_leaked');
    expect(gitHubCloudRepositoryErrorMessage(error, 'list')).toBe(
      cloudRepositoryFailureCopy('github-rate-limited'),
    );
  });

  it.each([
    ['github-cloud-needs-reauth', 409],
    ['github-cloud-installation-not-visible', 403],
    ['cloud-repository-request-invalid', 400],
    ['github-unavailable', 502],
  ] as const)('reads %s at its contract status', async (code, status) => {
    respond(status, { error: { code, message: 'server text' } });
    const error = await repositoryFailure(
      fetchGitHubRepositoryCreationCapability(repositories, '1001'),
    );
    expect(error.kind).toBe('typed');
    expect(error.code).toBe(code);
    expect(gitHubCloudRepositoryErrorMessage(error, 'capability')).toBe(
      cloudRepositoryFailureCopy(code),
    );
  });

  it('trusts no code at a status its contract never uses, nor the flat REG-3020 body', async () => {
    respond(500, {
      error: { code: 'github-cloud-needs-reauth', message: 'x' },
    });
    const wrongStatus = await repositoryFailure(
      fetchGitHubRepositoryCreationCapability(repositories, '1001'),
    );
    expect(wrongStatus.kind).toBe('http');
    expect(wrongStatus.code).toBeNull();
    expect(wrongStatus.details).toBeNull();
    expect(gitHubCloudRepositoryErrorMessage(wrongStatus, 'capability')).toBe(
      GITHUB_CLOUD_REPOSITORY_ACTION_ERROR_COPY.capability,
    );

    respond(409, {
      error: 'Bad credentials',
      code: 'github-cloud-needs-reauth',
    });
    expect(
      (
        await repositoryFailure(
          fetchGitHubCloudRepositoryPage(repositories, {
            installationId: '1001',
            cursor: 1,
            query: '',
          }),
        )
      ).code,
    ).toBeNull();
  });

  it('reads the rollout 404 as unavailable and a 401 as signed out', async () => {
    respond(404, { error: 'not found' });
    const unavailable = await repositoryFailure(
      fetchGitHubCloudRepositoryPage(repositories, {
        installationId: '1001',
        cursor: 1,
        query: '',
      }),
    );
    expect(unavailable.kind).toBe('unavailable');
    expect(gitHubCloudRepositoryErrorMessage(unavailable, 'list')).toBe(
      cloudRepositoryFailureCopy('cloud-repository-disabled'),
    );

    respond(401, { error: 'Unauthorized' });
    const signedOut = await repositoryFailure(
      fetchGitHubRepositoryCreationCapability(repositories, '1001'),
    );
    expect(signedOut.kind).toBe('unauthorized');
    expect(gitHubCloudRepositoryErrorMessage(signedOut, 'capability')).toBe(
      GITHUB_CLOUD_SIGNED_OUT_COPY,
    );
  });

  it('wraps a network failure and passes an abort through untouched', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const network = await repositoryFailure(
      fetchGitHubCloudRepositoryPage(repositories, {
        installationId: '1001',
        cursor: 1,
        query: '',
      }),
    );
    expect(network.kind).toBe('network');
    expect(network.status).toBeNull();

    const controller = new AbortController();
    const abort = new DOMException('Aborted', 'AbortError');
    fetchMock.mockImplementationOnce(() => {
      controller.abort(abort);
      return Promise.reject(abort);
    });
    await expect(
      fetchGitHubCloudRepositoryPage(
        repositories,
        { installationId: '1001', cursor: 1, query: '' },
        controller.signal,
      ),
    ).rejects.toBe(abort);

    const late = new AbortController();
    const lateAbort = new DOMException('Aborted', 'AbortError');
    // The body read is cut off by an abort after the headers arrived.
    const cutOff = Response.json(CAPABILITY);
    Object.defineProperty(cutOff, 'json', {
      value: (): Promise<unknown> => {
        late.abort(lateAbort);
        return Promise.reject(lateAbort);
      },
    });
    fetchMock.mockResolvedValueOnce(cutOff);
    await expect(
      fetchGitHubRepositoryCreationCapability(
        repositories,
        '1001',
        late.signal,
      ),
    ).rejects.toBe(lateAbort);
  });

  it('answers unavailable without a repository transport, sending nothing', async () => {
    const listing = await repositoryFailure(
      fetchGitHubCloudRepositoryPage(null, {
        installationId: '1001',
        cursor: 1,
        query: '',
      }),
    );
    expect(listing.kind).toBe('unavailable');
    expect(listing.status).toBeNull();
    expect(gitHubCloudRepositoryErrorMessage(listing, 'list')).toBe(
      cloudRepositoryFailureCopy('cloud-repository-disabled'),
    );
    const capability = await repositoryFailure(
      fetchGitHubRepositoryCreationCapability(null, '1001'),
    );
    expect(capability.kind).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps anything that is not a repository API error to the action copy', () => {
    expect(gitHubCloudRepositoryErrorMessage(new Error('ghp_x'), 'list')).toBe(
      GITHUB_CLOUD_REPOSITORY_ACTION_ERROR_COPY.list,
    );
  });
});

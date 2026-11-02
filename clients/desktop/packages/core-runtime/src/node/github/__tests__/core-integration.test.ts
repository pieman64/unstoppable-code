import {
  CORE_INTEGRATION_QUERIES,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyDispatcher } from '../../../runtime/types';
import {
  createCoreIntegrationHandlers,
  parseGitHubCliStatusOutput,
  type CoreIntegrationHost,
  type GitHubCliObservation,
  type GitHubCredentialDescription,
} from '..';

const CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.integration.read'],
};

// Pull request and repository reads are not these queries'.
const unused = (): Promise<never> => Promise.reject(new Error('unused'));
const UNUSED_READS = {
  getPullRequest: unused,
  listPullRequests: unused,
  listRepositories: unused,
  getBranchHead: unused,
  createPullRequest: unused,
  findOpenPullRequest: unused,
  updatePullRequest: unused,
};

const CONTEXT = {
  requestId: 'request-1',
  caller: CALLER,
  metadata: {},
  signal: new AbortController().signal,
};

interface Fixture {
  host: CoreIntegrationHost;
  describe: jest.Mock<Promise<GitHubCredentialDescription>, []>;
  observe: jest.Mock<Promise<GitHubCliObservation>, []>;
  dispatcher: ReturnType<typeof dispatcherFor>;
}

function dispatcherFor(
  host: CoreIntegrationHost,
): CanopyDispatcher<
  typeof CORE_INTEGRATION_QUERIES,
  Record<never, never>,
  Record<never, never>
> {
  return createCanopyDispatcher({
    profile: 'core+worker',
    definitions: {
      queries: CORE_INTEGRATION_QUERIES,
      instructions: {},
      streams: {},
    },
    handlers: {
      queries: createCoreIntegrationHandlers(host),
      instructions: {},
      streams: {},
    },
  });
}

function fixture(
  credential: GitHubCredentialDescription = {
    tokenSource: 'pat',
    storedCredential: 'present',
  },
  observation: GitHubCliObservation = { kind: 'failed' },
): Fixture {
  const describe = jest.fn(() => Promise.resolve(credential));
  const observe = jest.fn(() => Promise.resolve(observation));
  const host: CoreIntegrationHost = {
    authorityId: 'local-desktop',
    github: { describe, ...UNUSED_READS },
    observeGitHubCli: observe,
  };
  return { host, describe, observe, dispatcher: dispatcherFor(host) };
}

function get(
  f: Fixture,
  integrationId: string,
  scope?: Record<string, string>,
): Promise<unknown> {
  return f.dispatcher.query(
    'core.integration.get',
    { integrationId, ...(scope ? { scope } : {}) },
    { caller: CALLER },
  );
}

function payloadOf(error: unknown): unknown {
  return error instanceof CanopyOperationError ? error.payload : error;
}

const cliHosts = (
  ...entries: { active: boolean; login: string; tokenSource: string }[]
): GitHubCliObservation => ({ kind: 'hosts', entries });

describe('core.integration.get github', () => {
  it.each<[GitHubCredentialDescription, string, string[]]>([
    [
      { tokenSource: 'pat', storedCredential: 'present' },
      'connected',
      ['pull-requests', 'repositories'],
    ],
    [
      { tokenSource: 'gh-cli', storedCredential: 'absent' },
      'connected',
      ['pull-requests', 'repositories'],
    ],
    // A CLI token still connects while the store cannot be read.
    [
      { tokenSource: 'gh-cli', storedCredential: 'storage-unavailable' },
      'connected',
      ['pull-requests', 'repositories'],
    ],
    [{ tokenSource: 'none', storedCredential: 'absent' }, 'disconnected', []],
    [
      { tokenSource: 'none', storedCredential: 'storage-unavailable' },
      'error',
      [],
    ],
    [{ tokenSource: 'none', storedCredential: 'unreadable' }, 'error', []],
  ])('reports %j as %s', async (credential, state, capabilities) => {
    const f = fixture(credential);
    await expect(get(f, 'github')).resolves.toEqual({
      integrationId: 'github',
      kind: 'github',
      accountLabel: '',
      state,
      capabilities,
      revision: 0,
      githubCredential: credential,
    });
    expect(f.observe).not.toHaveBeenCalled();
  });

  it('answers a failed credential read as redacted internal, keeping the cause', async () => {
    const cause = new Error('/Users/me/.canopy/github-pat: EACCES');
    const host: CoreIntegrationHost = {
      authorityId: 'local-desktop',
      github: { describe: () => Promise.reject(cause), ...UNUSED_READS },
      observeGitHubCli: () => Promise.resolve({ kind: 'failed' }),
    };
    const get = createCoreIntegrationHandlers(host)['core.integration.get'];
    const error: unknown = await Promise.resolve()
      .then(() => get({ integrationId: 'github' }, CONTEXT))
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(CanopyOperationError);
    expect(payloadOf(error)).toEqual({
      kind: 'internal',
      message: 'The host could not read its credential state.',
      retry: { kind: 'never' },
    });
    expect(error instanceof CanopyOperationError && error.runtimeCause).toBe(
      cause,
    );
    await expect(
      dispatcherFor(host).query(
        'core.integration.get',
        { integrationId: 'github' },
        { caller: CALLER },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
  });
});

describe('core.integration.get github-cli', () => {
  const none = {
    login: null,
    tokenSourceKind: null,
    environmentVariable: null,
    hasCredentialStoreLogin: false,
    unavailableReason: null,
  };

  it.each<[string, GitHubCliObservation, unknown]>([
    [
      'a missing CLI',
      { kind: 'not-installed' },
      {
        state: 'error',
        accountLabel: '',
        capabilities: [],
        githubCli: { ...none, unavailableReason: 'not_installed' },
      },
    ],
    [
      'output that is not JSON',
      { kind: 'unparseable-output' },
      {
        state: 'error',
        accountLabel: '',
        capabilities: [],
        githubCli: { ...none, unavailableReason: 'unparseable_output' },
      },
    ],
    [
      'a failed or timed-out run',
      { kind: 'failed' },
      {
        state: 'disconnected',
        accountLabel: '',
        capabilities: [],
        githubCli: none,
      },
    ],
    [
      'no github.com entries',
      cliHosts(),
      {
        state: 'disconnected',
        accountLabel: '',
        capabilities: [],
        githubCli: none,
      },
    ],
    [
      'only an inactive keyring login',
      cliHosts({ active: false, login: 'octo', tokenSource: 'keyring' }),
      {
        state: 'disconnected',
        accountLabel: '',
        capabilities: [],
        githubCli: { ...none, hasCredentialStoreLogin: true },
      },
    ],
    [
      'an active keyring login',
      cliHosts({ active: true, login: 'octo', tokenSource: 'keyring' }),
      {
        state: 'connected',
        accountLabel: 'octo',
        capabilities: ['token-source'],
        githubCli: {
          login: 'octo',
          tokenSourceKind: 'keyring',
          environmentVariable: null,
          hasCredentialStoreLogin: true,
          unavailableReason: null,
        },
      },
    ],
    [
      'an active GH_TOKEN entry beside an inactive keyring login',
      cliHosts(
        { active: true, login: 'octo', tokenSource: 'GH_TOKEN' },
        { active: false, login: 'octo', tokenSource: 'keyring' },
      ),
      {
        state: 'connected',
        accountLabel: 'octo',
        capabilities: ['token-source'],
        githubCli: {
          login: 'octo',
          tokenSourceKind: 'environment',
          environmentVariable: 'GH_TOKEN',
          hasCredentialStoreLogin: true,
          unavailableReason: null,
        },
      },
    ],
    [
      'an active environment entry alone',
      cliHosts({
        active: true,
        login: 'octo',
        tokenSource: 'GITHUB_ENTERPRISE_TOKEN',
      }),
      {
        state: 'connected',
        accountLabel: 'octo',
        capabilities: ['token-source'],
        githubCli: {
          login: 'octo',
          tokenSourceKind: 'environment',
          environmentVariable: 'GITHUB_ENTERPRISE_TOKEN',
          hasCredentialStoreLogin: false,
          unavailableReason: null,
        },
      },
    ],
    [
      'an active entry with an empty login',
      cliHosts({ active: true, login: '', tokenSource: 'keyring' }),
      {
        state: 'connected',
        accountLabel: '',
        capabilities: ['token-source'],
        githubCli: {
          login: null,
          tokenSourceKind: 'keyring',
          environmentVariable: null,
          hasCredentialStoreLogin: true,
          unavailableReason: null,
        },
      },
    ],
  ])('reports %s', async (_label, observation, expected) => {
    const f = fixture(undefined, observation);
    await expect(get(f, 'github-cli')).resolves.toEqual({
      integrationId: 'github-cli',
      kind: 'github-cli',
      revision: 0,
      ...(expected as object),
    });
    expect(f.describe).not.toHaveBeenCalled();
  });

  it.each([
    ['/Users/octo/.config/gh/hosts.yml', 'config-file'],
    ['C:\\Users\\octo\\AppData\\Roaming\\GitHub CLI\\hosts.yml', 'config-file'],
    ['oauth_token', 'config-file'],
    ['/Users/octo/.config/gh/other.yml', 'other'],
    ['keychain-helper', 'other'],
  ])(
    'classifies token source %s as %s without crossing it',
    async (source, kind) => {
      const f = fixture(
        undefined,
        cliHosts({ active: true, login: 'octo', tokenSource: source }),
      );
      const result = await get(f, 'github-cli');
      expect(result).toMatchObject({
        githubCli: { tokenSourceKind: kind, environmentVariable: null },
      });
      expect(JSON.stringify(result)).not.toContain(source);
    },
  );
});

describe('core.integration.get identity and scope', () => {
  it('refuses another integration id as notFound before any read', async () => {
    const f = fixture();
    await expect(get(f, 'linear').catch(payloadOf)).resolves.toEqual({
      kind: 'not_found',
      code: 'core.integration.notFound',
      message: 'The host serves no integration with this id.',
      retry: { kind: 'never' },
    });
    expect(f.describe).not.toHaveBeenCalled();
    expect(f.observe).not.toHaveBeenCalled();
  });

  it.each([
    [{ authorityId: 'another-desktop' }],
    [{ targetId: 'remote-worker' }],
  ])(
    'refuses scope %j as capability_unavailable before any read',
    async (scope) => {
      const f = fixture();
      for (const id of ['github', 'github-cli'])
        await expect(get(f, id, scope)).rejects.toMatchObject({
          payload: { kind: 'capability_unavailable' },
        });
      await expect(
        f.dispatcher.query(
          'core.integration.list',
          { scope },
          { caller: CALLER },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
      expect(f.describe).not.toHaveBeenCalled();
      expect(f.observe).not.toHaveBeenCalled();
    },
  );

  it('answers the same for any workspace scope of the serving authority', async () => {
    const f = fixture();
    await expect(
      get(f, 'github', { authorityId: 'local-desktop', workspaceId: 'ws-1' }),
    ).resolves.toMatchObject({ state: 'connected' });
  });

  it('denies a caller without core.integration.read before the host runs', async () => {
    const f = fixture();
    await expect(
      f.dispatcher.query(
        'core.integration.get',
        { integrationId: 'github' },
        { caller: { ...CALLER, grants: ['core.workspace.read'] } },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(f.describe).not.toHaveBeenCalled();
  });

  it('counts a revision per connection, bumped only when its state changes', async () => {
    const credential: GitHubCredentialDescription = {
      tokenSource: 'pat',
      storedCredential: 'present',
    };
    const f = fixture(credential);
    const revision = async (id: string): Promise<unknown> =>
      Reflect.get(Object(await get(f, id)), 'revision');
    expect(await revision('github')).toBe(0);
    expect(await revision('github')).toBe(0);
    f.describe.mockResolvedValue({
      tokenSource: 'none',
      storedCredential: 'absent',
    });
    expect(await revision('github')).toBe(1);
    expect(await revision('github-cli')).toBe(0);
    f.describe.mockResolvedValue(credential);
    expect(await revision('github')).toBe(2);
  });
});

describe('core.integration.list', () => {
  it('lists github then github-cli, each equal to its get result', async () => {
    const f = fixture(
      undefined,
      cliHosts({
        active: true,
        login: 'octo',
        tokenSource: 'keyring',
      }),
    );
    const listed = await f.dispatcher.query(
      'core.integration.list',
      {},
      { caller: CALLER },
    );
    expect(listed.nextCursor).toBeNull();
    expect(listed.items).toEqual([
      await get(f, 'github'),
      await get(f, 'github-cli'),
    ]);
  });

  it('pages with pageSize 1, reading only the page it returns', async () => {
    const f = fixture();
    const first = await f.dispatcher.query(
      'core.integration.list',
      { pageSize: 1 },
      { caller: CALLER },
    );
    expect(first.items.map(({ integrationId }) => integrationId)).toEqual([
      'github',
    ]);
    expect(f.observe).not.toHaveBeenCalled();
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await f.dispatcher.query(
      'core.integration.list',
      { pageSize: 1, cursor: first.nextCursor ?? undefined },
      { caller: CALLER },
    );
    expect(second.items.map(({ integrationId }) => integrationId)).toEqual([
      'github-cli',
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('refuses a cursor it did not mint, or one minted for another scope', async () => {
    const f = fixture();
    const minted = await f.dispatcher.query(
      'core.integration.list',
      { pageSize: 1, scope: { workspaceId: 'ws-1' } },
      { caller: CALLER },
    );
    const cursor = minted.nextCursor ?? '';
    const other = fixture();
    const attempts: Array<[Record<string, unknown>, typeof f]> = [
      [{ cursor: 'not-a-cursor' }, f],
      [
        {
          cursor: `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`,
          scope: { workspaceId: 'ws-1' },
        },
        f,
      ],
      [{ cursor: cursor.replace(/^1\./, '0.') }, f],
      // Another scope, or another process's handlers.
      [{ cursor, scope: { workspaceId: 'ws-2' } }, f],
      [{ cursor }, f],
      [{ cursor, scope: { workspaceId: 'ws-1' } }, other],
    ];
    for (const [params, target] of attempts)
      await expect(
        target.dispatcher
          .query('core.integration.list', params, { caller: CALLER })
          .catch(payloadOf),
      ).resolves.toMatchObject({
        kind: 'invalid_argument',
        code: 'core.integration.list.invalidCursor',
      });
    await expect(
      f.dispatcher.query(
        'core.integration.list',
        { cursor, scope: { workspaceId: 'ws-1' } },
        { caller: CALLER },
      ),
    ).resolves.toMatchObject({ nextCursor: null });
  });
});

describe('parseGitHubCliStatusOutput', () => {
  it.each<[string, string, GitHubCliObservation]>([
    ['non-JSON output', 'not json', { kind: 'unparseable-output' }],
    ['a JSON value without hosts', '[]', cliHosts()],
    ['hosts that are not an object', '{"hosts":[]}', cliHosts()],
    [
      'github.com entries that are not a list',
      '{"hosts":{"github.com":{}}}',
      cliHosts(),
    ],
    [
      'entries for other hosts only',
      '{"hosts":{"ghe.example.com":[{"active":true,"host":"ghe.example.com","login":"o","tokenSource":"keyring"}]}}',
      cliHosts(),
    ],
    [
      'well-formed entries, dropping malformed ones and extra fields',
      JSON.stringify({
        hosts: {
          'github.com': [
            { active: true, host: 'github.com' },
            {
              state: 'error',
              active: true,
              host: 'github.com',
              login: 'octo',
              tokenSource: 'keyring',
              token: 'gho_secret',
            },
          ],
        },
      }),
      cliHosts({ active: true, login: 'octo', tokenSource: 'keyring' }),
    ],
  ])('reads %s', (_label, stdout, expected) => {
    expect(parseGitHubCliStatusOutput(stdout)).toEqual(expected);
  });
});

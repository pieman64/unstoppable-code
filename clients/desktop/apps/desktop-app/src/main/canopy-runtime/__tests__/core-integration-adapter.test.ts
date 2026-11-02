import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type {
  CoreIntegrationHost,
  GitHubCliObservation,
} from '@canopy/core-runtime/node/github';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  desktopCoreIntegrationHost,
  queryGitHubCliStatusForLegacyIpc,
} from '../core-integration-adapter';
import { getGitHubCliStatus } from '../github-integration-dispatch';
import {
  describeGitHubCredential,
  observeGitHubCli,
} from '../../lib/github-auth';

jest.mock('../../services/files-service', () => ({
  listFileTreeRoots: jest.fn(),
  listFileTreeDirectory: jest.fn(),
}));
// The real legacy mapping over a controlled observation; the credential
// resolution is a spy so a read through the handle is visible.
jest.mock('../../lib/github-auth', () => ({
  ...jest.requireActual<object>('../../lib/github-auth'),
  observeGitHubCli: jest.fn(),
  describeGitHubCredential: jest.fn(),
}));

const mockedObserve = jest.mocked(observeGitHubCli);
const mockedDescribe = jest.mocked(describeGitHubCredential);

const CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read', 'core.workspace.read'],
};
const READER: CanopyCallerDescriptor = {
  ...CALLER,
  grants: ['core.integration.read'],
};
const PATH_SOURCE = '/Users/octo/.config/gh/hosts.yml';
const PATH_HOSTS: GitHubCliObservation = {
  kind: 'hosts',
  entries: [{ active: true, login: 'octo', tokenSource: PATH_SOURCE }],
};

let runtime: DesktopCanopyDispatcher | undefined;

function start(integrationHost?: CoreIntegrationHost): DesktopCanopyDispatcher {
  runtime = createDesktopRuntime({
    shutdownTimeoutMs: 1_000,
    ...(integrationHost ? { integrationHost } : {}),
  });
  return runtime;
}

beforeEach(() => {
  mockedObserve.mockReset();
  mockedDescribe.mockReset();
  mockedObserve.mockResolvedValue(PATH_HOSTS);
  mockedDescribe.mockResolvedValue({
    tokenSource: 'pat',
    storedCredential: 'present',
  });
});

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
});

describe('desktop core.integration composition', () => {
  it('serves both GitHub connections in process over the desktop host', async () => {
    const dispatcher = start();
    const listed = await dispatcher.query(
      'core.integration.list',
      {},
      { caller: READER },
    );
    expect(listed).toEqual({
      items: [
        {
          integrationId: 'github',
          kind: 'github',
          accountLabel: '',
          state: 'connected',
          capabilities: ['pull-requests', 'repositories'],
          revision: 0,
          githubCredential: { tokenSource: 'pat', storedCredential: 'present' },
        },
        {
          integrationId: 'github-cli',
          kind: 'github-cli',
          accountLabel: 'octo',
          state: 'connected',
          capabilities: ['token-source'],
          revision: 0,
          githubCli: {
            login: 'octo',
            tokenSourceKind: 'config-file',
            environmentVariable: null,
            hasCredentialStoreLogin: true,
            unavailableReason: null,
          },
        },
      ],
      nextCursor: null,
    });
    // Configured state only: no host path or token crosses.
    expect(JSON.stringify(listed)).not.toContain(PATH_SOURCE);
  });

  it('denies a desktop caller that lacks core.integration.read', async () => {
    const dispatcher = start();
    await expect(
      dispatcher.query(
        'core.integration.get',
        { integrationId: 'github' },
        { caller: CALLER },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(mockedDescribe).not.toHaveBeenCalled();
  });

  it('uses an injected host', async () => {
    const host: CoreIntegrationHost = {
      authorityId: 'local-desktop',
      github: {
        describe: () =>
          Promise.resolve({ tokenSource: 'none', storedCredential: 'absent' }),
        getPullRequest: () => Promise.reject(new Error('unused')),
        listPullRequests: () => Promise.reject(new Error('unused')),
        listRepositories: () => Promise.reject(new Error('unused')),
        getBranchHead: () => Promise.reject(new Error('unused')),
        createPullRequest: () => Promise.reject(new Error('unused')),
        findOpenPullRequest: () => Promise.reject(new Error('unused')),
        updatePullRequest: () => Promise.reject(new Error('unused')),
      },
      observeGitHubCli: () => Promise.resolve({ kind: 'not-installed' }),
    };
    const dispatcher = start(host);
    await expect(
      dispatcher.query(
        'core.integration.get',
        { integrationId: 'github' },
        { caller: READER },
      ),
    ).resolves.toMatchObject({ state: 'disconnected' });
    expect(mockedDescribe).not.toHaveBeenCalled();
  });
});

describe('settings:github-cli-status projection', () => {
  it('returns the legacy status computed from the same observation', async () => {
    const dispatcher = start();
    const projected = await queryGitHubCliStatusForLegacyIpc(dispatcher, {
      caller: READER,
    });
    expect(projected).toEqual({
      canonicalResult: expect.objectContaining({
        integrationId: 'github-cli',
        githubCli: expect.objectContaining({
          tokenSourceKind: 'config-file',
        }) as unknown,
      }) as unknown,
      legacyResult: {
        authenticated: true,
        username: 'octo',
        error: null,
        tokenSource: PATH_SOURCE,
        envOverride: false,
        envOverrideName: null,
        hasCredentialStoreLogin: true,
      },
    });
    expect(mockedObserve).toHaveBeenCalledTimes(1);
    // Never Canopy's credential: no gh auth token, no secure-store read.
    expect(mockedDescribe).not.toHaveBeenCalled();
  });

  it('keeps the legacy status when the canonical result is invalid', async () => {
    const login = 'o'.repeat(257);
    mockedObserve.mockResolvedValue({
      kind: 'hosts',
      entries: [{ active: true, login, tokenSource: 'keyring' }],
    });
    const dispatcher = start();
    await expect(
      queryGitHubCliStatusForLegacyIpc(dispatcher, { caller: READER }),
    ).resolves.toEqual({
      canonicalResult: null,
      legacyResult: expect.objectContaining({ username: login }) as unknown,
    });
  });

  it('rethrows a host failure as the cause the legacy handler threw', async () => {
    const cause = new Error('gh exploded');
    mockedObserve.mockRejectedValue(cause);
    const dispatcher = start();
    await expect(getGitHubCliStatus(dispatcher, CALLER)).rejects.toBe(cause);
  });

  it('fails closed when an injected host captures nothing', async () => {
    const dispatcher = start({
      ...desktopCoreIntegrationHost,
      observeGitHubCli: () => Promise.resolve({ kind: 'failed' }),
    });
    await expect(
      queryGitHubCliStatusForLegacyIpc(dispatcher, { caller: READER }),
    ).rejects.toThrow('GitHub CLI status projection was not captured.');
  });

  it('captures nothing for other dispatcher callers', async () => {
    const dispatcher = start();
    const [projected, direct] = await Promise.all([
      queryGitHubCliStatusForLegacyIpc(dispatcher, { caller: READER }),
      dispatcher.query(
        'core.integration.get',
        { integrationId: 'github-cli' },
        { caller: READER },
      ),
    ]);
    expect(projected.legacyResult.tokenSource).toBe(PATH_SOURCE);
    expect(JSON.stringify(direct)).not.toContain(PATH_SOURCE);
    expect(direct).not.toHaveProperty('legacyResult');
  });
});

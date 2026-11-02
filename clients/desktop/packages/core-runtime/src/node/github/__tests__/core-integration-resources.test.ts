/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import {
  CORE_INTEGRATION_QUERIES,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../runtime/errors';
import {
  createCoreIntegrationHandlers,
  GitHubRequestError,
  type GitHubRepositoryRecord,
  type GitHubRepositorySnapshot,
} from '..';

const READER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.integration.read'],
};

const unused = (): Promise<never> => Promise.reject(new Error('unused'));

function repository(index: number): GitHubRepositoryRecord {
  return {
    fullName: `acme/repo-${index}`,
    webUrl: `https://github.com/acme/repo-${index}`,
    permissions: index % 2 === 0 ? ['admin', 'pull'] : [],
    updatedAt: '2026-10-30T12:00:00Z',
  };
}

function setup(snapshots: GitHubRepositorySnapshot[] | Error) {
  const listRepositories = jest.fn(() => {
    if (snapshots instanceof Error) return Promise.reject(snapshots);
    const next = snapshots.length > 1 ? snapshots.shift() : snapshots[0];
    return next ? Promise.resolve(next) : Promise.reject(new Error('none'));
  });
  const dispatcher = createCanopyDispatcher({
    profile: 'core+worker',
    definitions: {
      queries: CORE_INTEGRATION_QUERIES,
      instructions: {},
      streams: {},
    },
    handlers: {
      queries: createCoreIntegrationHandlers({
        authorityId: 'local-desktop',
        github: {
          describe: unused,
          getPullRequest: unused,
          listPullRequests: unused,
          listRepositories,
          getBranchHead: unused,
          createPullRequest: unused,
          findOpenPullRequest: unused,
          updatePullRequest: unused,
        },
        observeGitHubCli: unused,
      }),
      instructions: {},
      streams: {},
    },
  });
  return { dispatcher, listRepositories };
}

const params = (overrides: Record<string, unknown> = {}) => ({
  integrationId: 'github',
  kinds: ['repository' as const],
  query: null,
  cursor: null,
  limit: 200,
  ...overrides,
});

async function failure(
  promise: Promise<unknown>,
): Promise<CanopyOperationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CanopyOperationError) return error;
    throw error;
  }
  throw new Error('resolved');
}

describe('core.integration.resource.list', () => {
  it('pages the snapshot as repository resources', async () => {
    const repositories = Array.from({ length: 300 }, (_, index) =>
      repository(index),
    );
    const { dispatcher } = setup([{ snapshotId: 's1', repositories }]);

    const first = await dispatcher.query(
      'core.integration.resource.list',
      params(),
      { caller: READER },
    );
    expect(first.resources).toHaveLength(200);
    expect(first.resources[0]).toEqual({
      integrationId: 'github',
      resourceId: expect.stringMatching(/^github-repository\./),
      kind: 'repository',
      name: 'acme/repo-0',
      locator: 'https://github.com/acme/repo-0',
      capabilities: ['pull', 'admin'],
      updatedAt: '2026-10-30T12:00:00Z',
    });
    expect(first.resources[1].capabilities).toEqual([]);
    const second = await dispatcher.query(
      'core.integration.resource.list',
      params({ cursor: first.nextCursor }),
      { caller: READER },
    );
    expect(second.resources.map((resource) => resource.name)).toEqual(
      repositories.slice(200).map((entry) => entry.fullName),
    );
    expect(second.nextCursor).toBeNull();
  });

  it('leaves out a repository GitHub listed without an update time', async () => {
    const { dispatcher } = setup([
      {
        snapshotId: 's1',
        repositories: [{ ...repository(0), updatedAt: null }, repository(1)],
      },
    ]);
    const result = await dispatcher.query(
      'core.integration.resource.list',
      params(),
      { caller: READER },
    );
    expect(result.resources.map((resource) => resource.name)).toEqual([
      'acme/repo-1',
    ]);
  });

  it('refuses a cursor once its snapshot is replaced, or for other params', async () => {
    const repositories = [repository(0), repository(1), repository(2)];
    const { dispatcher } = setup([
      { snapshotId: 's1', repositories },
      { snapshotId: 's1', repositories },
      { snapshotId: 's2', repositories },
    ]);
    const first = await dispatcher.query(
      'core.integration.resource.list',
      params({ limit: 1 }),
      { caller: READER },
    );
    const cursor = first.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    await expect(
      dispatcher.query(
        'core.integration.resource.list',
        params({ limit: 1, cursor }),
        { caller: READER },
      ),
    ).resolves.toMatchObject({ resources: [{ name: 'acme/repo-1' }] });
    const replaced = await failure(
      dispatcher.query(
        'core.integration.resource.list',
        params({ limit: 1, cursor }),
        { caller: READER },
      ),
    );
    expect(replaced.payload.code).toBe(
      'core.integration.resource.invalidCursor',
    );
    const forged = await failure(
      dispatcher.query(
        'core.integration.resource.list',
        params({ cursor: 'MQ.forged' }),
        { caller: READER },
      ),
    );
    expect(forged.payload.code).toBe('core.integration.resource.invalidCursor');
  });

  it.each([
    [
      'another integration',
      { integrationId: 'github-cli' },
      'core.integration.notFound',
    ],
    ['no kinds', { kinds: [] }, 'core.integration.resource.kindUnsupported'],
    [
      'another kind',
      { kinds: ['repository', 'issue'] },
      'core.integration.resource.kindUnsupported',
    ],
    [
      'a query',
      { query: 'canopy' },
      'core.integration.resource.queryUnsupported',
    ],
  ])('refuses %s before any read', async (_label, change, code) => {
    const { dispatcher, listRepositories } = setup([
      { snapshotId: 's1', repositories: [] },
    ]);
    const error = await failure(
      dispatcher.query('core.integration.resource.list', params(change), {
        caller: READER,
      }),
    );
    expect(error.payload.code).toBe(code);
    expect(listRepositories).not.toHaveBeenCalled();
  });

  it('maps a missing credential, keeping the host error as the runtime cause', async () => {
    const cause = new Error('No GitHub token is available.');
    const { dispatcher } = setup(
      new GitHubRequestError('not_authenticated', 'handle', { cause }),
    );
    const error = await failure(
      dispatcher.query('core.integration.resource.list', params(), {
        caller: READER,
      }),
    );
    expect(error.payload).toMatchObject({
      kind: 'failed_precondition',
      code: 'core.integration.notAuthenticated',
    });
    expect(error.runtimeCause).toBe(cause);
  });
});

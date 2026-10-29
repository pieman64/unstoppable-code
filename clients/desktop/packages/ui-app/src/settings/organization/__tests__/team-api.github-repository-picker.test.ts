/**
 * The repository picker route answers 409 for several distinct states
 * (`github-not-connected`, `github-installation-suspended`, ...) and 429 for
 * a rate limit. The client must keep the structured `code` so the picker can
 * show state-specific guidance instead of one generic message.
 *
 * Reading `code` off the response body (top level, or `details.code`) is the
 * settings transport's job; this module maps the transport's `serverCode`
 * onto `TeamApiError.code`.
 */
import { createFakeSettingsClient } from '../../__tests__/helpers/test-settings-host';
import { listOrganizationGitHubRepositories, TeamApiError } from '../team-api';
import { failWith, respondWith } from './helpers/settings-responses';

const ORG_ID = '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';
const OPERATION = 'organization.github.repositories';

async function captureError(promise: Promise<unknown>): Promise<TeamApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TeamApiError) return error;
    throw error;
  }
  throw new Error('Expected the request to reject');
}

function failingClient(
  status: number,
  body: { error?: string; code?: string },
): ReturnType<typeof createFakeSettingsClient> {
  return createFakeSettingsClient({ [OPERATION]: failWith(status, body) });
}

function pageClient(
  body: unknown,
): ReturnType<typeof createFakeSettingsClient> {
  return createFakeSettingsClient({
    [OPERATION]: respondWith(OPERATION, body),
  });
}

describe('listOrganizationGitHubRepositories', (): void => {
  it('keeps the picker error code so 409 states stay distinguishable', async (): Promise<void> => {
    const notConnected = await captureError(
      listOrganizationGitHubRepositories(
        failingClient(409, {
          error: 'Connect GitHub to pick a repository.',
          code: 'github-not-connected',
        }),
        ORG_ID,
      ),
    );
    expect(notConnected.status).toBe(409);
    expect(notConnected.code).toBe('github-not-connected');
    expect(notConnected.serverDetail).toBe(
      'Connect GitHub to pick a repository.',
    );
  });

  it('keeps the suspended installation error code', async (): Promise<void> => {
    const suspended = await captureError(
      listOrganizationGitHubRepositories(
        failingClient(409, {
          error: 'The GitHub installation is suspended.',
          code: 'github-installation-suspended',
        }),
        ORG_ID,
      ),
    );
    expect(suspended.status).toBe(409);
    expect(suspended.code).toBe('github-installation-suspended');
  });

  it('leaves the code undefined when the route publishes none', async (): Promise<void> => {
    const error = await captureError(
      listOrganizationGitHubRepositories(
        failingClient(500, { error: 'Something went wrong.' }),
        ORG_ID,
      ),
    );
    expect(error.status).toBe(500);
    expect(error.code).toBeUndefined();
    expect(error.serverDetail).toBe('Something went wrong.');
  });

  it('carries no detail when the route sends no message', async (): Promise<void> => {
    const error = await captureError(
      listOrganizationGitHubRepositories(failingClient(429, {}), ORG_ID),
    );
    expect(error.status).toBe(429);
    expect(error.serverDetail).toBeUndefined();
  });

  it('forwards the cursor and query and parses a page', async (): Promise<void> => {
    const client = pageClient({
      repositories: [],
      nextCursor: null,
      repositorySelection: 'selected',
    });
    const page = await listOrganizationGitHubRepositories(client, ORG_ID, {
      cursor: 'c2',
      query: 'web',
    });
    expect(page.repositorySelection).toBe('selected');
    expect(client.calls).toEqual([
      {
        operation: OPERATION,
        input: { organizationId: ORG_ID, cursor: 'c2', query: 'web' },
      },
    ]);
  });

  it('omits an empty cursor and query', async (): Promise<void> => {
    const client = pageClient({
      repositories: [],
      nextCursor: null,
      repositorySelection: 'all',
    });
    await listOrganizationGitHubRepositories(client, ORG_ID, {
      cursor: '',
      query: '',
    });
    expect(client.calls[0]?.input).toEqual({ organizationId: ORG_ID });
  });

  it.each(['all', null])(
    'accepts repository selection %s',
    async (repositorySelection): Promise<void> => {
      const page = await listOrganizationGitHubRepositories(
        pageClient({ repositories: [], nextCursor: null, repositorySelection }),
        ORG_ID,
      );
      expect(page.repositorySelection).toBe(repositorySelection);
    },
  );

  it.each([{}, { repositorySelection: 'invalid' }])(
    'rejects missing or invalid repository selection: %j',
    async (fields): Promise<void> => {
      await expect(
        listOrganizationGitHubRepositories(
          pageClient({ repositories: [], nextCursor: null, ...fields }),
          ORG_ID,
        ),
      ).rejects.toMatchObject({ serverDetail: 'Invalid server response' });
    },
  );
});

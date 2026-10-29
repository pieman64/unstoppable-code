/** @jest-environment ./packages/ui-app/src/settings/github/__tests__/helpers/web-fetch-jsdom-environment.ts */
/* eslint-disable @typescript-eslint/require-await -- act() callbacks stay async so React flushes the settled promises they trigger. */
import { act, useEffect, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  GitHubCloudRepositoryDto,
  GitHubCloudRepositoryPageDto,
} from '@canopy/protocol/settings/github-cloud-repository-listing';
import { cloudRepositoryFailureCopy } from '@canopy/protocol/settings/cloud-repository-errors';
import { GITHUB_CLOUD_REPOSITORY_ACTION_ERROR_COPY } from '../github-cloud-api';
import {
  useGitHubCloudRepositories,
  useGitHubRepositoryCreationCapability,
  type GitHubCloudRepositories,
  type GitHubRepositoryCreationCapabilityCheck,
  type UseGitHubCloudRepositoriesOptions,
  type UseGitHubRepositoryCreationCapabilityOptions,
} from '../use-github-cloud-repositories';

import {
  createFetchBackedGitHubPorts,
  GitHubTestHost,
  type TestBackendFetch,
  type TestLinkSocial,
} from './helpers/github-test-host';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

// ---------------------------------------------------------------------------
// Every request stays pending until the test answers it.
// ---------------------------------------------------------------------------

interface PendingRequest {
  readonly path: string;
  readonly signal: AbortSignal | null;
  respond(status: number, body: unknown): Promise<void>;
}

// The backend the GitHub host's repository transport reaches.
const fetchMock = jest.fn<
  ReturnType<TestBackendFetch>,
  Parameters<TestBackendFetch>
>();
const github = createFetchBackedGitHubPorts(
  fetchMock,
  jest.fn<ReturnType<TestLinkSocial>, Parameters<TestLinkSocial>>(),
);
let requests: PendingRequest[] = [];

beforeEach(() => {
  requests = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((path, init) => {
    let resolve: (response: Response) => void = () => undefined;
    const promise = new Promise<Response>((res) => {
      resolve = res;
    });
    requests.push({
      path,
      signal: init?.signal ?? null,
      respond: (status, body) =>
        act(async () => {
          // A real Response whose body reads in microtasks, so fake timers
          // never stall it.
          const response = Response.json(body, { status });
          Object.defineProperty(response, 'json', {
            value: (): Promise<unknown> => Promise.resolve(body),
          });
          resolve(response);
          for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
        }),
    });
    return promise;
  });
});

function query(request: PendingRequest): URLSearchParams {
  return new URL(request.path, 'https://canopy.test').searchParams;
}

function listings(): PendingRequest[] {
  return requests.filter((request) =>
    request.path.startsWith('/cloud/github/repositories?'),
  );
}

function repository(id: string): GitHubCloudRepositoryDto {
  return {
    providerRepoId: id,
    ownerLogin: 'octocat',
    ownerType: 'User',
    name: `repo-${id}`,
    fullName: `octocat/repo-${id}`,
    private: false,
    visibility: 'public',
    archived: false,
    permission: 'write',
    description: null,
    defaultBranch: 'main',
    updatedAt: null,
  };
}

function page(
  ids: readonly string[],
  overrides: Partial<GitHubCloudRepositoryPageDto> = {},
): GitHubCloudRepositoryPageDto {
  return {
    installationId: '1001',
    repositories: ids.map(repository),
    repositorySelection: 'all',
    totalCount: 250,
    nextCursor: null,
    searchIncomplete: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
let listing: GitHubCloudRepositories | null = null;
let capability: GitHubRepositoryCreationCapabilityCheck | null = null;

function ListingProbe(props: UseGitHubCloudRepositoriesOptions): JSX.Element {
  const value = useGitHubCloudRepositories(props);
  useEffect(() => {
    listing = value;
  });
  return <div />;
}

function CapabilityProbe(
  props: UseGitHubRepositoryCreationCapabilityOptions,
): JSX.Element {
  const value = useGitHubRepositoryCreationCapability(props);
  useEffect(() => {
    capability = value;
  });
  return <div />;
}

const BASE: UseGitHubCloudRepositoriesOptions = {
  userId: 'user-1',
  installationId: '1001',
  connectionGeneration: 'g1',
  query: '',
  enabled: true,
};

async function renderListing(
  overrides: Partial<UseGitHubCloudRepositoriesOptions> = {},
): Promise<void> {
  await act(async () => {
    root.render(
      <GitHubTestHost github={github}>
        <ListingProbe {...BASE} {...overrides} />
      </GitHubTestHost>,
    );
  });
}

function current(): GitHubCloudRepositories {
  if (listing === null) throw new Error('the listing hook did not render');
  return listing;
}

function ids(): string[] {
  return current().repositories.map((row) => row.providerRepoId);
}

beforeEach(() => {
  jest.useFakeTimers();
  listing = null;
  capability = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

async function wait(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

describe('useGitHubCloudRepositories', () => {
  it('asks for nothing until the selected account is ready', async () => {
    await renderListing({ enabled: false });
    expect(listings()).toEqual([]);
    expect(current().loading).toBe(false);

    await renderListing({ installationId: null });
    expect(listings()).toEqual([]);

    await renderListing();
    expect(listings()).toHaveLength(1);
    expect(current().loading).toBe(true);
    expect(query(listings()[0]).toString()).toBe('installationId=1001');

    await listings()[0].respond(200, page(['1', '2'], { nextCursor: 2 }));
    expect(current().loading).toBe(false);
    expect(current().loaded).toBe(true);
    expect(ids()).toEqual(['1', '2']);
    expect(current().totalCount).toBe(250);
    expect(current().nextCursor).toBe(2);
  });

  it('waits 300 ms after the last keystroke before it searches', async () => {
    await renderListing();
    await listings()[0].respond(200, page(['1']));

    await renderListing({ query: 'w' });
    await wait(200);
    await renderListing({ query: 'wi' });
    await wait(200);
    await renderListing({ query: 'wid' });
    await wait(299);
    expect(listings()).toHaveLength(1);
    // The rows still answer the query that was asked.
    expect(current().appliedQuery).toBe('');

    await wait(1);
    expect(listings()).toHaveLength(2);
    expect(query(listings()[1]).get('q')).toBe('wid');
    expect(current().appliedQuery).toBe('wid');
    expect(current().repositories).toEqual([]);
    expect(current().loading).toBe(true);
  });

  it('ignores a stale search answer and aborts the request it replaced', async () => {
    await renderListing({ query: 'a' });
    const first = listings()[0];

    await renderListing({ query: 'ab' });
    await wait(300);
    const second = listings()[1];
    expect(first.signal?.aborted).toBe(true);

    await second.respond(200, page(['2']));
    await first.respond(200, page(['1']));

    expect(ids()).toEqual(['2']);
    expect(current().appliedQuery).toBe('ab');
  });

  it('appends Load more pages, deduped by repository id', async () => {
    await renderListing();
    await listings()[0].respond(
      200,
      page(['1', '2'], { nextCursor: 2, searchIncomplete: true }),
    );

    await act(async () => current().loadMore());
    expect(current().loadingMore).toBe(true);
    expect(query(listings()[1]).get('cursor')).toBe('2');
    // A second press while one is in flight asks for nothing more.
    await act(async () => current().loadMore());
    expect(listings()).toHaveLength(2);

    await listings()[1].respond(200, page(['2', '3'], { nextCursor: null }));
    expect(current().loadingMore).toBe(false);
    expect(ids()).toEqual(['1', '2', '3']);
    expect(current().nextCursor).toBeNull();
    expect(current().searchIncomplete).toBe(false);
  });

  it('keeps the cursor when a page fails, so its error and Try again stay', async () => {
    await renderListing({ query: 'x' });
    await listings()[0].respond(
      200,
      page([], { nextCursor: 4, searchIncomplete: true }),
    );
    // An empty answer with a cursor is not the end of the listing.
    expect(current().repositories).toEqual([]);
    expect(current().nextCursor).toBe(4);

    await act(async () => current().loadMore());
    await listings()[1].respond(502, {
      error: { code: 'github-unavailable', message: 'x' },
    });

    expect(current().loadingMore).toBe(false);
    expect(current().nextCursor).toBe(4);
    expect(current().pageFailure).toEqual({
      code: 'github-unavailable',
      message: cloudRepositoryFailureCopy('github-unavailable'),
    });

    await act(async () => current().loadMore());
    expect(query(listings()[2]).get('cursor')).toBe('4');
    expect(current().pageFailure).toBeNull();
    await listings()[2].respond(200, page(['9'], { nextCursor: null }));
    expect(ids()).toEqual(['9']);
  });

  it('drops a page that answers after the search changed', async () => {
    await renderListing();
    await listings()[0].respond(200, page(['1'], { nextCursor: 2 }));
    await act(async () => current().loadMore());
    const more = listings()[1];

    await renderListing({ query: 'z' });
    await wait(300);
    expect(more.signal?.aborted).toBe(true);
    await more.respond(200, page(['2']));

    expect(ids()).toEqual([]);
    expect(current().loadingMore).toBe(false);
    await listings()[2].respond(200, page(['3']));
    expect(ids()).toEqual(['3']);
  });

  it('drops a page that answers after the account stopped being ready', async () => {
    await renderListing();
    await listings()[0].respond(200, page(['1'], { nextCursor: 2 }));
    await act(async () => current().loadMore());
    const more = listings()[1];

    await renderListing({ enabled: false });
    expect(more.signal?.aborted).toBe(true);
    await more.respond(200, page(['2']));
    await renderListing();

    expect(ids()).toEqual(['1']);
    expect(current().loadingMore).toBe(false);
    expect(current().nextCursor).toBe(2);
  });

  it.each([
    ['another account', { userId: 'user-2' }],
    ['another installation', { installationId: '2002' }],
    ['a new connection generation', { connectionGeneration: 'g2' }],
  ] as const)('starts over for %s', async (_label, change) => {
    await renderListing();
    await listings()[0].respond(200, page(['1'], { nextCursor: 2 }));
    await act(async () => current().loadMore());
    const more = listings()[1];

    await renderListing(change);

    expect(more.signal?.aborted).toBe(true);
    expect(current().repositories).toEqual([]);
    expect(current().loading).toBe(true);
    expect(listings()).toHaveLength(3);
    expect(query(listings()[2]).get('cursor')).toBeNull();
  });

  it('shows a first-page failure with fixed copy and asks again only on Retry', async () => {
    await renderListing();
    await listings()[0].respond(429, {
      error: { code: 'github-rate-limited', message: 'provider text' },
    });

    expect(current().failure).toEqual({
      code: 'github-rate-limited',
      message: cloudRepositoryFailureCopy('github-rate-limited'),
    });
    // Never re-sent by itself, however long the page stays open.
    await wait(120_000);
    expect(listings()).toHaveLength(1);

    await act(async () => current().retry());
    expect(listings()).toHaveLength(2);
    expect(current().failure).toBeNull();
    expect(current().loading).toBe(true);
    await listings()[1].respond(200, { not: 'a page' });
    expect(current().failure?.message).toBe(
      GITHUB_CLOUD_REPOSITORY_ACTION_ERROR_COPY.list,
    );
  });

  it('aborts on unmount and when the account stops being ready', async () => {
    await renderListing();
    const first = listings()[0];
    await renderListing({ enabled: false });
    expect(first.signal?.aborted).toBe(true);
    expect(current().loading).toBe(false);

    await renderListing();
    expect(listings()).toHaveLength(2);
    const second = listings()[1];
    act(() => root.unmount());
    expect(second.signal?.aborted).toBe(true);
    // A fresh root for afterEach.
    root = createRoot(container);
  });
});

// ---------------------------------------------------------------------------
// Creation capability
// ---------------------------------------------------------------------------

const CAPABILITY_BASE: UseGitHubRepositoryCreationCapabilityOptions = {
  userId: 'user-1',
  installationId: '1001',
  connectionGeneration: 'g1',
  enabled: true,
};

async function renderCapability(
  overrides: Partial<UseGitHubRepositoryCreationCapabilityOptions> = {},
): Promise<void> {
  await act(async () => {
    root.render(
      <GitHubTestHost github={github}>
        <CapabilityProbe {...CAPABILITY_BASE} {...overrides} />
      </GitHubTestHost>,
    );
  });
}

function capabilityRequests(): PendingRequest[] {
  return requests.filter((request) =>
    request.path.startsWith('/cloud/github/repositories/creation-capability'),
  );
}

function check(): GitHubRepositoryCreationCapabilityCheck {
  if (capability === null)
    throw new Error('the capability hook did not render');
  return capability;
}

function answer(installationId: string, state: string): unknown {
  return { installationId, state, checkedAt: '2026-10-05T10:00:00.000Z' };
}

describe('useGitHubRepositoryCreationCapability', () => {
  it('checks the selected installation only while it is enabled', async () => {
    await renderCapability({ enabled: false });
    expect(capabilityRequests()).toEqual([]);
    expect(check().status).toBe('idle');

    await renderCapability();
    expect(check().status).toBe('checking');
    expect(query(capabilityRequests()[0]).get('installationId')).toBe('1001');
    await capabilityRequests()[0].respond(
      200,
      answer('1001', 'NEEDS_APPROVAL'),
    );

    expect(check().status).toBe('answered');
    expect(check().capability?.state).toBe('NEEDS_APPROVAL');
  });

  it('drops the answer for an installation the user moved away from', async () => {
    await renderCapability();
    const first = capabilityRequests()[0];
    await renderCapability({ installationId: '2002' });
    expect(first.signal?.aborted).toBe(true);
    expect(check().capability).toBeNull();

    await capabilityRequests()[1].respond(200, answer('2002', 'READY'));
    await first.respond(200, answer('1001', 'OWNER_MISMATCH'));

    expect(check().capability).toEqual(
      expect.objectContaining({ installationId: '2002', state: 'READY' }),
    );
  });

  it('checks again only when asked, keeping the request versioned', async () => {
    await renderCapability();
    await capabilityRequests()[0].respond(502, {
      error: { code: 'github-unavailable', message: 'x' },
    });
    expect(check().status).toBe('failed');
    expect(check().failure?.message).toBe(
      cloudRepositoryFailureCopy('github-unavailable'),
    );
    await wait(60_000);
    expect(capabilityRequests()).toHaveLength(1);

    await act(async () => check().check());
    expect(check().status).toBe('checking');
    await act(async () => check().check());
    // The second press replaced the first; only its answer counts.
    expect(capabilityRequests()[1].signal?.aborted).toBe(true);
    await capabilityRequests()[2].respond(200, answer('1001', 'READY'));
    await capabilityRequests()[1].respond(200, answer('1001', 'NEEDS_INSTALL'));
    expect(check().capability?.state).toBe('READY');
  });

  it('starts over for a new connection generation', async () => {
    await renderCapability();
    await capabilityRequests()[0].respond(
      200,
      answer('1001', 'NEEDS_APPROVAL'),
    );
    await renderCapability({ connectionGeneration: 'g2' });
    expect(check().capability).toBeNull();
    expect(capabilityRequests()).toHaveLength(2);
  });
});

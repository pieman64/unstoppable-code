import type { GitHubCloudRepositoryDto } from '@canopy/protocol/settings/github-cloud-repository-listing';
import {
  describeRepositoryListing,
  GITHUB_CLOUD_PARTIAL_NO_MATCH_MESSAGE,
  GITHUB_CLOUD_REPOSITORY_SEARCH_DEBOUNCE_MS,
  GITHUB_CLOUD_REPOSITORY_UNAVAILABLE_COPY,
  GITHUB_CLOUD_SEARCH_LIMIT_NOTICE,
  GITHUB_CLOUD_SELECTED_INSTALL_NOTICE,
  mergeRepositoryPage,
  repositoryPickerRow,
  repositoryUnavailableReason,
} from '../github-cloud-repository-pages';

function repository(
  providerRepoId: string,
  overrides: Partial<GitHubCloudRepositoryDto> = {},
): GitHubCloudRepositoryDto {
  const name = overrides.name ?? `repo-${providerRepoId}`;
  return {
    providerRepoId,
    ownerLogin: 'octocat',
    ownerType: 'User',
    name,
    fullName: `octocat/${name}`,
    private: false,
    visibility: 'public',
    archived: false,
    permission: 'write',
    description: null,
    defaultBranch: 'main',
    updatedAt: null,
    ...overrides,
  };
}

describe('the search debounce', () => {
  it('waits 300 ms after the last keystroke', () => {
    expect(GITHUB_CLOUD_REPOSITORY_SEARCH_DEBOUNCE_MS).toBe(300);
  });
});

describe('mergeRepositoryPage', () => {
  it('appends a page in order, skipping rows offset paging repeated', () => {
    const first = [repository('1'), repository('2'), repository('3')];
    const second = [repository('3'), repository('4'), repository('2')];

    const merged = mergeRepositoryPage(first, second);

    expect(merged.map((row) => row.providerRepoId)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    // Ids are unique, so the picker's keys and its selection stay stable.
    expect(new Set(merged.map((row) => row.providerRepoId)).size).toBe(
      merged.length,
    );
  });

  it('keeps the first copy of a row, so a row never jumps under the pointer', () => {
    const merged = mergeRepositoryPage(
      [repository('1', { description: 'first' })],
      [repository('1', { description: 'later' })],
    );
    expect(merged).toEqual([repository('1', { description: 'first' })]);
  });

  it('dedupes within one page too', () => {
    expect(
      mergeRepositoryPage([], [repository('7'), repository('7')]).map(
        (row) => row.providerRepoId,
      ),
    ).toEqual(['7']);
  });
});

describe('repositoryUnavailableReason', () => {
  it('leaves a writable repository available, also when GitHub sent no permission', () => {
    expect(repositoryUnavailableReason(repository('1'))).toBeNull();
    expect(
      repositoryUnavailableReason(repository('1', { permission: 'admin' })),
    ).toBeNull();
    // `none` also means GitHub omitted it; the server rechecks on submit.
    expect(
      repositoryUnavailableReason(repository('1', { permission: 'none' })),
    ).toBeNull();
  });

  it('explains an archived repository and a read-only one with fixed copy', () => {
    expect(
      repositoryUnavailableReason(repository('1', { archived: true })),
    ).toBe(GITHUB_CLOUD_REPOSITORY_UNAVAILABLE_COPY.archived);
    expect(
      repositoryUnavailableReason(repository('1', { permission: 'read' })),
    ).toBe(GITHUB_CLOUD_REPOSITORY_UNAVAILABLE_COPY.readOnly);
    // Archived wins: unarchiving is the first thing to fix.
    expect(
      repositoryUnavailableReason(
        repository('1', { archived: true, permission: 'read' }),
      ),
    ).toBe(GITHUB_CLOUD_REPOSITORY_UNAVAILABLE_COPY.archived);
  });
});

describe('repositoryPickerRow', () => {
  it('keys the row by the immutable repository id and shows the full name', () => {
    expect(
      repositoryPickerRow(
        repository('9007199254740993', {
          name: 'widgets',
          fullName: 'octocat/widgets',
          private: true,
          visibility: 'private',
          description: 'Widget factory',
        }),
      ),
    ).toEqual({
      id: '9007199254740993',
      fullName: 'octocat/widgets',
      description: 'Widget factory',
      private: true,
      archived: false,
    });
  });

  it('carries the unavailable reason only for a row that cannot be chosen', () => {
    expect(repositoryPickerRow(repository('1', { archived: true }))).toEqual(
      expect.objectContaining({
        archived: true,
        unavailableReason: GITHUB_CLOUD_REPOSITORY_UNAVAILABLE_COPY.archived,
      }),
    );
    expect(repositoryPickerRow(repository('1'))).not.toHaveProperty(
      'unavailableReason',
    );
  });
});

describe('describeRepositoryListing', () => {
  const base = {
    nextCursor: null,
    searchIncomplete: false,
    repositorySelection: 'all',
    query: '',
  } as const;

  it('offers Load more and says only the loaded pages were searched while a cursor remains', () => {
    const view = describeRepositoryListing({
      ...base,
      nextCursor: 4,
      searchIncomplete: true,
      query: 'widgets',
    });
    expect(view.hasMore).toBe(true);
    expect(view.noMatchMessage).toBe(GITHUB_CLOUD_PARTIAL_NO_MATCH_MESSAGE);
    expect(view.notice).toBeUndefined();
  });

  it('says the search hit its limit, with URL as the way on, when no cursor remains but pages do', () => {
    const view = describeRepositoryListing({
      ...base,
      nextCursor: null,
      searchIncomplete: true,
      query: 'widgets',
    });
    expect(view.hasMore).toBe(false);
    expect(view.noMatchMessage).toBe(GITHUB_CLOUD_PARTIAL_NO_MATCH_MESSAGE);
    expect(view.notice).toBe(GITHUB_CLOUD_SEARCH_LIMIT_NOTICE);
    expect(GITHUB_CLOUD_SEARCH_LIMIT_NOTICE).toMatch(/\bURL\b/);
    expect(GITHUB_CLOUD_SEARCH_LIMIT_NOTICE).toContain('10,000');
  });

  it('is definitive only once the listing is exhausted', () => {
    expect(
      describeRepositoryListing({ ...base, query: 'widgets' }).noMatchMessage,
    ).toBe('No repositories match “widgets”.');
    expect(describeRepositoryListing(base)).toEqual({
      hasMore: false,
      noMatchMessage: 'No repositories returned from GitHub.',
      notice: undefined,
    });
  });

  it('says only granted repositories show for a selected-repositories install', () => {
    expect(
      describeRepositoryListing({ ...base, repositorySelection: 'selected' })
        .notice,
    ).toBe(
      'Only repositories the app was granted show here. Manage access on GitHub to add more.',
    );
    expect(
      describeRepositoryListing({
        ...base,
        repositorySelection: 'selected',
        searchIncomplete: true,
      }).notice,
    ).toBe(
      `${GITHUB_CLOUD_SEARCH_LIMIT_NOTICE} ${GITHUB_CLOUD_SELECTED_INSTALL_NOTICE}`,
    );
  });
});

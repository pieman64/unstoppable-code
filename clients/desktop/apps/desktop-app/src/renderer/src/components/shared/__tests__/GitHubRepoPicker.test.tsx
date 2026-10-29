/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GitHubRepoSummary } from '@canopy/desktop-shared/types';
import { GitHubRepoPicker } from '@/components/shared/GitHubRepoPicker';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function repo(overrides: Partial<GitHubRepoSummary> = {}): GitHubRepoSummary {
  return {
    fullName: 'acme/api',
    ownerLogin: 'acme',
    name: 'api',
    description: 'The public API',
    cloneUrl: 'https://github.com/acme/api.git',
    sshUrl: 'git@github.com:acme/api.git',
    htmlUrl: 'https://github.com/acme/api',
    isPrivate: false,
    isFork: false,
    isArchived: false,
    defaultBranch: 'main',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const PRIVATE_API = repo({ isPrivate: true });
const ARCHIVED_SITE = repo({
  fullName: 'acme/legacy-site',
  name: 'legacy-site',
  description: 'Frozen marketing site',
  isArchived: true,
});
const NO_DESCRIPTION = repo({
  fullName: 'acme/docs',
  name: 'docs',
  description: null,
});

describe('desktop GitHubRepoPicker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function render(
    overrides: Partial<Parameters<typeof GitHubRepoPicker>[0]> = {},
  ): Parameters<typeof GitHubRepoPicker>[0] {
    const props: Parameters<typeof GitHubRepoPicker>[0] = {
      repos: [PRIVATE_API, ARCHIVED_SITE, NO_DESCRIPTION],
      totalCount: 3,
      loading: false,
      error: '',
      search: '',
      onSearchChange: jest.fn(),
      selectedFullName: null,
      onSelect: jest.fn(),
      onRetry: jest.fn(),
      testId: 'add-workspace-github-repo-list',
      ...overrides,
    };
    const element: JSX.Element = <GitHubRepoPicker {...props} />;
    act(() => root.render(element));
    return props;
  }

  function list(): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      '[data-testid="add-workspace-github-repo-list"]',
    );
    if (!element) throw new Error('List missing');
    return element;
  }

  function row(fullName: string): HTMLButtonElement {
    const found = Array.from(
      list().querySelectorAll<HTMLButtonElement>('li button'),
    ).find((button) => button.textContent?.includes(fullName));
    if (!found) throw new Error(`Row missing: ${fullName}`);
    return found;
  }

  it('shows each summary as a row with its privacy, archive state and description', () => {
    render();

    expect(row('acme/api').textContent).toContain('Private');
    expect(row('acme/api').textContent).toContain('The public API');
    expect(row('acme/legacy-site').textContent).toContain('Archived');
    expect(row('acme/legacy-site').textContent).not.toContain('Private');
    expect(row('acme/docs').textContent).not.toContain('Archived');
    expect(row('acme/docs').querySelector('.line-clamp-2')).toBeNull();
  });

  it('reports a selection as the full name, archived repositories included', () => {
    const { onSelect } = render();

    act(() => row('acme/legacy-site').click());
    act(() => row('acme/api').click());

    expect(onSelect).toHaveBeenNthCalledWith(1, 'acme/legacy-site');
    expect(onSelect).toHaveBeenNthCalledWith(2, 'acme/api');
    expect(row('acme/legacy-site').disabled).toBe(false);
  });

  it('marks the repository named by selectedFullName', () => {
    render({ selectedFullName: 'acme/legacy-site' });

    expect(row('acme/legacy-site').getAttribute('aria-pressed')).toBe('true');
    expect(
      row('acme/legacy-site').querySelector(
        '[data-picker-selected-check="true"] svg',
      ),
    ).not.toBeNull();
    expect(row('acme/api').getAttribute('aria-pressed')).toBe('false');
    expect(
      row('acme/api').querySelector('[data-picker-selected-check="true"]'),
    ).toBeNull();
  });

  it('keeps the empty copy keyed on totalCount, with the search shown in no-match', () => {
    render({ repos: [], totalCount: 0 });
    expect(list().textContent).toBe('No repositories returned from GitHub.');

    render({ repos: [], totalCount: 5, search: 'zzz' });
    expect(list().textContent).toBe('No matches for “zzz”.');
  });

  it('forwards loading, error with retry, and the search box', () => {
    const props = render({ error: 'GitHub is unreachable.' });
    expect(list().textContent).toContain('GitHub is unreachable.');
    act(() => list().querySelector('button')?.click());
    expect(props.onRetry).toHaveBeenCalledTimes(1);

    render({ loading: true });
    expect(list().textContent).toContain('Loading your GitHub repositories…');

    render({ search: 'ap' });
    const input = container.querySelector('input');
    expect(input?.placeholder).toBe('Search your repositories');
    expect(input?.value).toBe('ap');
  });
});

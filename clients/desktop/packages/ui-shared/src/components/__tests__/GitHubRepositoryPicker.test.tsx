/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  GitHubRepositoryPicker,
  type GitHubRepositoryPickerPaging,
  type GitHubRepositoryPickerProps,
  type GitHubRepositoryPickerRow,
} from '../GitHubRepositoryPicker';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const API: GitHubRepositoryPickerRow = {
  id: 'acme/api',
  fullName: 'acme/api',
  description: 'The public API',
  private: true,
  archived: false,
};
const LEGACY: GitHubRepositoryPickerRow = {
  id: 'acme/legacy',
  fullName: 'acme/legacy',
  description: 'Frozen marketing site',
  private: false,
  archived: true,
};
const DOCS: GitHubRepositoryPickerRow = {
  id: 'acme/docs',
  fullName: 'acme/docs',
  description: null,
  private: false,
  archived: false,
};

function setInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  );
  // `this` is bound explicitly by the call below.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = descriptor?.set;
  if (!setter) throw new Error('Native value setter not found');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('GitHubRepositoryPicker', () => {
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
    overrides: Partial<GitHubRepositoryPickerProps> = {},
  ): GitHubRepositoryPickerProps {
    const props: GitHubRepositoryPickerProps = {
      repositories: [API, LEGACY, DOCS],
      totalCount: 3,
      loading: false,
      error: '',
      search: '',
      onSearchChange: jest.fn(),
      selectedId: null,
      onSelect: jest.fn(),
      onRetry: jest.fn(),
      testId: 'picker-list',
      ...overrides,
    };
    const element: JSX.Element = <GitHubRepositoryPicker {...props} />;
    act(() => root.render(element));
    return props;
  }

  function list(): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      '[data-testid="picker-list"]',
    );
    if (!element) throw new Error('List missing');
    return element;
  }

  function rows(): HTMLButtonElement[] {
    return Array.from(list().querySelectorAll<HTMLButtonElement>('li button'));
  }

  function row(fullName: string): HTMLButtonElement {
    const found = rows().find((button) =>
      button.textContent?.includes(fullName),
    );
    if (!found) throw new Error(`Row missing: ${fullName}`);
    return found;
  }

  function searchInput(): HTMLInputElement {
    const input = container.querySelector('input');
    if (!input) throw new Error('Search input missing');
    return input;
  }

  it('labels the search box and keeps the list on the supplied test id', () => {
    render({ search: 'ap' });

    expect(container.textContent).toContain('Repository');
    const input = searchInput();
    expect(input.type).toBe('text');
    expect(input.placeholder).toBe('Search your repositories');
    expect(input.value).toBe('ap');
    expect(input.closest('label')).not.toBeNull();
    expect(list()).not.toBeNull();
  });

  it('omits the test id when none is supplied', () => {
    render({ testId: undefined });

    expect(container.querySelector('[data-testid]')).toBeNull();
  });

  it('lists every repository with its Private and Archived badges and description', () => {
    render();

    expect(rows().map((button) => button.type)).toEqual([
      'button',
      'button',
      'button',
    ]);
    expect(row('acme/api').textContent).toContain('Private');
    expect(row('acme/api').textContent).not.toContain('Archived');
    expect(row('acme/api').textContent).toContain('The public API');
    expect(row('acme/legacy').textContent).toContain('Archived');
    expect(row('acme/legacy').textContent).not.toContain('Private');
    expect(row('acme/docs').textContent).not.toContain('Private');
    expect(row('acme/docs').textContent).not.toContain('Archived');
    // No description: no description line at all.
    expect(row('acme/docs').querySelector('.line-clamp-2')).toBeNull();
  });

  it('chooses a repository by its id, archived or not, and never disables a row', () => {
    const { onSelect } = render();

    for (const button of rows()) {
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-disabled')).toBeNull();
    }
    act(() => row('acme/legacy').click());
    act(() => row('acme/api').click());

    expect(onSelect).toHaveBeenNthCalledWith(1, 'acme/legacy');
    expect(onSelect).toHaveBeenNthCalledWith(2, 'acme/api');
  });

  it('moves the decorative checkmark with selection without a persistent row highlight', () => {
    render({ selectedId: 'acme/legacy' });

    const check = '[data-picker-selected-check="true"]';
    expect(row('acme/legacy').querySelector(`${check} svg`)).not.toBeNull();
    expect(
      row('acme/legacy').querySelector(check)?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(row('acme/api').querySelector(check)).toBeNull();
    expect(row('acme/docs').querySelector(check)).toBeNull();
    for (const button of rows()) {
      expect(button.className).not.toContain('bg-accent-subtle');
    }

    render({ selectedId: 'acme/api' });
    expect(row('acme/api').querySelector(`${check} svg`)).not.toBeNull();
    expect(row('acme/api').getAttribute('aria-pressed')).toBe('true');
    expect(row('acme/legacy').querySelector(check)).toBeNull();
    expect(row('acme/legacy').getAttribute('aria-pressed')).toBe('false');
  });

  it('reports each search edit without owning the text', () => {
    const { onSearchChange } = render({ search: 'ap' });

    act(() => setInputValue(searchInput(), 'api'));

    expect(onSearchChange).toHaveBeenCalledWith('api');
    // Controlled: the value stays the host's until it re-renders.
    expect(searchInput().value).toBe('ap');
  });

  it('says it is loading, and nothing else, while loading', () => {
    render({ loading: true, error: 'ignored', repositories: [API] });

    expect(list().textContent).toContain('Loading your GitHub repositories…');
    expect(rows()).toHaveLength(0);
    expect(list().textContent).not.toContain('ignored');
    expect(list().textContent).not.toContain('No repositories');
  });

  it('shows the error with a Retry button instead of the list', () => {
    const { onRetry } = render({ error: 'GitHub is unreachable.' });

    expect(list().textContent).toContain('GitHub is unreachable.');
    expect(rows()).toHaveLength(0);
    const retry = list().querySelector('button');
    expect(retry?.textContent).toBe('Retry');
    expect(retry?.type).toBe('button');
    act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('says no repositories were returned when the account has none', () => {
    render({ repositories: [], totalCount: 0 });

    expect(list().textContent).toBe('No repositories returned from GitHub.');
  });

  it('keys the empty copy on the total, not on the search', () => {
    render({ repositories: [], totalCount: 0, search: 'anything' });

    expect(list().textContent).toBe('No repositories returned from GitHub.');
  });

  it('quotes the search when it matches nothing out of a non-empty total', () => {
    render({ repositories: [], totalCount: 3, search: 'zzz' });

    expect(list().textContent).toBe('No matches for “zzz”.');
  });

  it('does not render stale copy next to a list', () => {
    render();

    expect(list().textContent).not.toContain('No repositories');
    expect(list().textContent).not.toContain('No matches');
    expect(list().querySelector('[aria-label="Loading"]')).toBeNull();
  });

  it('gives the host a stable row identity that is not the visible name', () => {
    const { onSelect } = render({
      repositories: [
        {
          id: '1296269',
          fullName: 'acme/api',
          description: null,
          private: false,
          archived: false,
        },
      ],
      totalCount: 1,
      selectedId: '1296269',
    });

    expect(row('acme/api').getAttribute('aria-pressed')).toBe('true');
    act(() => row('acme/api').click());
    expect(onSelect).toHaveBeenCalledWith('1296269');
  });
});

describe('GitHubRepositoryPicker cloud behavior', () => {
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
    overrides: Partial<GitHubRepositoryPickerProps> = {},
  ): GitHubRepositoryPickerProps {
    const props: GitHubRepositoryPickerProps = {
      repositories: [API, LEGACY, DOCS],
      totalCount: 3,
      loading: false,
      error: '',
      search: '',
      onSearchChange: jest.fn(),
      selectedId: null,
      onSelect: jest.fn(),
      onRetry: jest.fn(),
      testId: 'picker-list',
      ...overrides,
    };
    const element: JSX.Element = <GitHubRepositoryPicker {...props} />;
    act(() => root.render(element));
    return props;
  }

  function paging(
    overrides: Partial<GitHubRepositoryPickerPaging> = {},
  ): GitHubRepositoryPickerPaging {
    return {
      hasMore: true,
      loadingMore: false,
      onLoadMore: jest.fn(),
      ...overrides,
    };
  }

  function list(): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      '[data-testid="picker-list"]',
    );
    if (!element) throw new Error('List missing');
    return element;
  }

  function rows(): HTMLButtonElement[] {
    return Array.from(list().querySelectorAll<HTMLButtonElement>('li button'));
  }

  function row(fullName: string): HTMLButtonElement {
    const found = rows().find((button) =>
      button.textContent?.includes(fullName),
    );
    if (!found) throw new Error(`Row missing: ${fullName}`);
    return found;
  }

  function searchInput(): HTMLInputElement {
    const input = container.querySelector('input');
    if (!input) throw new Error('Search input missing');
    return input;
  }

  function loadMore(): HTMLButtonElement | null {
    return list().querySelector<HTMLButtonElement>(
      '[data-testid="picker-list-load-more"]',
    );
  }

  function requireLoadMore(): HTMLButtonElement {
    const button = loadMore();
    if (!button) throw new Error('Load more missing');
    return button;
  }

  describe('unavailable repositories', () => {
    const BLOCKED: GitHubRepositoryPickerRow = {
      ...LEGACY,
      unavailableReason: 'Archived repositories cannot be used here.',
    };

    it('explains why a repository cannot be chosen, on the row, in text', () => {
      render({ repositories: [API, BLOCKED, DOCS] });

      const blocked = row('acme/legacy');
      expect(blocked.textContent).toContain(
        'Archived repositories cannot be used here.',
      );
      expect(blocked.getAttribute('aria-disabled')).toBe('true');
      const describedBy = blocked.getAttribute('aria-describedby');
      expect(describedBy).not.toBeNull();
      expect(
        describedBy === null
          ? null
          : document.getElementById(describedBy)?.textContent,
      ).toBe('Archived repositories cannot be used here.');
    });

    it('keeps an unavailable row in the tab order and out of selection', () => {
      const { onSelect } = render({ repositories: [API, BLOCKED, DOCS] });

      const blocked = row('acme/legacy');
      // aria-disabled, not disabled: keyboard and screen reader users can
      // reach the row and hear the reason.
      expect(blocked.disabled).toBe(false);
      expect(blocked.tabIndex).toBe(0);
      act(() => blocked.focus());
      expect(document.activeElement).toBe(blocked);
      act(() => blocked.click());

      expect(onSelect).not.toHaveBeenCalled();
      act(() => row('acme/api').click());
      expect(onSelect).toHaveBeenCalledWith('acme/api');
    });

    it('disables only rows with a reason: an archived row without one stays selectable', () => {
      const { onSelect } = render({ repositories: [API, LEGACY, DOCS] });

      expect(row('acme/legacy').getAttribute('aria-disabled')).toBeNull();
      expect(row('acme/legacy').getAttribute('aria-describedby')).toBeNull();
      act(() => row('acme/legacy').click());
      expect(onSelect).toHaveBeenCalledWith('acme/legacy');
    });

    it('can block a repository that is not archived, for any host reason', () => {
      const { onSelect } = render({
        repositories: [
          { ...API, unavailableReason: 'Read-only access.' },
          LEGACY,
        ],
      });

      expect(row('acme/api').getAttribute('aria-disabled')).toBe('true');
      act(() => row('acme/api').click());
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('does not paint the hover or selected surface on an unavailable row', () => {
      render({ repositories: [API, BLOCKED], selectedId: 'acme/api' });

      expect(row('acme/legacy').className).not.toContain('hover:bg-secondary');
      expect(row('acme/legacy').className).toContain('cursor-not-allowed');
      expect(row('acme/api').getAttribute('aria-pressed')).toBe('true');
    });

    it('treats an empty reason as no reason', () => {
      const { onSelect } = render({
        repositories: [{ ...API, unavailableReason: '' }],
      });

      expect(row('acme/api').getAttribute('aria-disabled')).toBeNull();
      act(() => row('acme/api').click());
      expect(onSelect).toHaveBeenCalledWith('acme/api');
    });
  });

  describe('selection state', () => {
    it('exposes which row is chosen to assistive technology', () => {
      render({ selectedId: 'acme/legacy' });

      expect(row('acme/legacy').getAttribute('aria-pressed')).toBe('true');
      expect(row('acme/api').getAttribute('aria-pressed')).toBe('false');
      expect(row('acme/docs').getAttribute('aria-pressed')).toBe('false');
    });

    it('does not claim listbox semantics', () => {
      render();

      expect(container.querySelector('[role="listbox"]')).toBeNull();
      expect(container.querySelector('[role="option"]')).toBeNull();
      expect(container.querySelector('[aria-selected]')).toBeNull();
    });
  });

  describe('search field', () => {
    it('uses the shared text field recipe', () => {
      render();

      const input = searchInput();
      expect(input.className).toContain('shadow-field');
      expect(input.className).toContain('focus-visible:shadow-field-focus');
      expect(input.className).not.toContain('focus-ring');
      expect(input.className).not.toMatch(/\bborder\b/);
      expect(input.type).toBe('text');
      expect(input.closest('label')?.textContent).toContain('Repository');
    });

    it('turns off browser completion, correction and capitalization', () => {
      render();

      const input = searchInput();
      expect(input.autocomplete).toBe('off');
      expect(input.getAttribute('spellcheck')).toBe('false');
      expect(input.getAttribute('autocapitalize')).toBe('off');
      expect(input.getAttribute('enterkeyhint')).toBe('search');
    });

    it('keeps Enter from submitting an enclosing form', () => {
      const onSubmit = jest.fn((event: { preventDefault: () => void }) =>
        event.preventDefault(),
      );
      const element: JSX.Element = (
        <form onSubmit={onSubmit}>
          <GitHubRepositoryPicker
            repositories={[API]}
            totalCount={1}
            loading={false}
            error=""
            search=""
            onSearchChange={jest.fn()}
            selectedId={null}
            onSelect={jest.fn()}
            onRetry={jest.fn()}
          />
        </form>
      );
      act(() => root.render(element));

      const enter = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        searchInput().dispatchEvent(enter);
      });
      expect(enter.defaultPrevented).toBe(true);

      const other = new KeyboardEvent('keydown', {
        key: 'a',
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        searchInput().dispatchEvent(other);
      });
      expect(other.defaultPrevented).toBe(false);
    });

    it('stays focused while the matching rows change', () => {
      render({ search: '' });
      act(() => searchInput().focus());
      expect(document.activeElement).toBe(searchInput());

      render({ search: 'doc', repositories: [DOCS] });
      expect(document.activeElement).toBe(searchInput());
      render({ search: 'zzz', repositories: [], totalCount: 3 });
      expect(document.activeElement).toBe(searchInput());
    });
  });

  describe('host copy', () => {
    it('lets the host name the field and the empty states', () => {
      render({
        label: 'Repository in this installation',
        searchPlaceholder: 'Search this installation',
        repositories: [],
        totalCount: 0,
        emptyMessage: 'This installation has no repositories.',
      });

      expect(container.textContent).toContain(
        'Repository in this installation',
      );
      expect(searchInput().placeholder).toBe('Search this installation');
      expect(list().textContent).toBe('This installation has no repositories.');

      render({
        repositories: [],
        totalCount: 4,
        search: 'zzz',
        noMatchMessage: 'Nothing in the pages loaded so far matches.',
      });
      expect(list().textContent).toBe(
        'Nothing in the pages loaded so far matches.',
      );
    });

    it('shows a host notice under the list, and nothing without one', () => {
      render();
      expect(
        container.querySelector('[data-testid="picker-list-notice"]'),
      ).toBeNull();

      render({ notice: 'Only the first 300 repositories were searched.' });
      const notice = container.querySelector(
        '[data-testid="picker-list-notice"]',
      );
      expect(notice?.textContent).toContain(
        'Only the first 300 repositories were searched.',
      );
      // Outside the scrolling list, so it never scrolls away with the rows.
      expect(list().contains(notice)).toBe(false);
    });
  });

  describe('paging', () => {
    it('offers Load more only when the host has more', () => {
      render({ paging: paging({ hasMore: false }) });
      expect(loadMore()).toBeNull();

      render();
      expect(loadMore()).toBeNull();

      render({ paging: paging() });
      expect(requireLoadMore().textContent).toBe('Load more');
      expect(requireLoadMore().type).toBe('button');
    });

    it('pins the Load more row to the bottom of the scrolling list', () => {
      render({ paging: paging() });

      const footer = requireLoadMore().parentElement;
      expect(footer?.className).toContain('sticky');
      expect(footer?.className).toContain('bottom-0');
      expect(footer?.className).toContain('bg-base');
    });

    it('asks the host for the next page and keeps the rows it has', () => {
      const pager = paging();
      render({ paging: pager });

      act(() => requireLoadMore().click());

      expect(pager.onLoadMore).toHaveBeenCalledTimes(1);
      expect(rows()).toHaveLength(3);
    });

    it('shows progress on the button while loading, without a second request', () => {
      const pager = paging({ loadingMore: true });
      render({ paging: pager });

      const button = requireLoadMore();
      expect(rows()).toHaveLength(3);
      expect(button.textContent).toContain('Loading more');
      expect(button.getAttribute('aria-busy')).toBe('true');
      expect(button.getAttribute('aria-disabled')).toBe('true');
      // Not natively disabled: focus stays where the user left it.
      expect(button.disabled).toBe(false);
      act(() => button.click());
      expect(pager.onLoadMore).not.toHaveBeenCalled();
    });

    it('reports a failed page next to a Try again button', () => {
      const pager = paging({ error: 'GitHub is slow to respond.' });
      render({ paging: pager });

      const alert = list().querySelector('[role="alert"]');
      expect(alert?.textContent).toBe('GitHub is slow to respond.');
      expect(requireLoadMore().textContent).toBe('Try again');
      act(() => requireLoadMore().click());
      expect(pager.onLoadMore).toHaveBeenCalledTimes(1);
      expect(rows()).toHaveLength(3);
    });

    it('keeps offering more when a search matches nothing yet', () => {
      const pager = paging();
      render({
        repositories: [],
        totalCount: 250,
        search: 'zzz',
        paging: pager,
      });

      expect(list().textContent).toContain('No matches for \u201Czzz\u201D.');
      act(() => requireLoadMore().click());
      expect(pager.onLoadMore).toHaveBeenCalledTimes(1);
    });

    it('hides Load more while the first page loads or has failed', () => {
      render({ loading: true, paging: paging() });
      expect(loadMore()).toBeNull();

      render({ error: 'GitHub is unreachable.', paging: paging() });
      expect(loadMore()).toBeNull();
    });

    it('derives the button test id from the list test id', () => {
      render({ paging: paging(), testId: 'picker-list' });
      expect(requireLoadMore().getAttribute('data-testid')).toBe(
        'picker-list-load-more',
      );

      render({ paging: paging(), testId: undefined });
      expect(container.querySelector('[data-testid]')).toBeNull();
    });
  });

  describe('focus while paging', () => {
    const MORE: GitHubRepositoryPickerRow = {
      id: 'acme/more',
      fullName: 'acme/more',
      description: null,
      private: false,
      archived: false,
    };

    function renderPaging(
      repositories: readonly GitHubRepositoryPickerRow[],
      pager: GitHubRepositoryPickerPaging,
    ): void {
      render({ repositories, totalCount: 10, paging: pager });
    }

    it('keeps focus on Load more when another page is still available', () => {
      const onLoadMore = jest.fn();
      renderPaging([API], paging({ onLoadMore }));
      act(() => requireLoadMore().focus());
      act(() => requireLoadMore().click());
      renderPaging([API], paging({ onLoadMore, loadingMore: true }));
      expect(document.activeElement).toBe(requireLoadMore());

      renderPaging([API, MORE], paging({ onLoadMore }));

      expect(document.activeElement).toBe(requireLoadMore());
    });

    it('moves focus to the first new row when the last page removes Load more', () => {
      const onLoadMore = jest.fn();
      renderPaging([API], paging({ onLoadMore }));
      act(() => requireLoadMore().focus());
      act(() => requireLoadMore().click());
      renderPaging([API], paging({ onLoadMore, loadingMore: true }));

      renderPaging([API, MORE], paging({ onLoadMore, hasMore: false }));

      expect(loadMore()).toBeNull();
      expect(document.activeElement).toBe(row('acme/more'));
    });

    it('does not take focus from where the user moved while a page loaded', () => {
      const onLoadMore = jest.fn();
      renderPaging([API], paging({ onLoadMore }));
      act(() => requireLoadMore().click());
      renderPaging([API], paging({ onLoadMore, loadingMore: true }));
      act(() => searchInput().focus());

      renderPaging([API, MORE], paging({ onLoadMore, hasMore: false }));

      expect(document.activeElement).toBe(searchInput());
    });

    it('lands on the last row when the final page adds nothing', () => {
      const onLoadMore = jest.fn();
      renderPaging([API], paging({ onLoadMore }));
      act(() => requireLoadMore().focus());
      act(() => requireLoadMore().click());
      renderPaging([API], paging({ onLoadMore, loadingMore: true }));

      renderPaging([API], paging({ onLoadMore, hasMore: false }));

      expect(document.activeElement).toBe(row('acme/api'));
    });
  });

  describe('announcements', () => {
    function status(): HTMLElement {
      const element = container.querySelector<HTMLElement>(
        '[data-testid="picker-list"] [role="status"]',
      );
      if (!element) throw new Error('Status region missing');
      return element;
    }

    it('keeps one status region mounted so changes are announced', () => {
      render();
      const first = status();
      render({ repositories: [API], search: 'api' });
      expect(status()).toBe(first);
      render({ repositories: [], totalCount: 3, search: 'zzz' });
      expect(status()).toBe(first);
    });

    it('announces how many repositories are shown, in the right number', () => {
      render();
      expect(status().textContent).toBe('3 repositories');
      render({ repositories: [API], totalCount: 3, search: 'api' });
      expect(status().textContent).toBe('1 repository');
    });

    it('announces empty and no-match states through the same region', () => {
      render({ repositories: [], totalCount: 0 });
      expect(status().textContent).toBe(
        'No repositories returned from GitHub.',
      );
      render({ repositories: [], totalCount: 3, search: 'zzz' });
      expect(status().textContent).toBe('No matches for \u201Czzz\u201D.');
    });

    it('announces a page being loaded', () => {
      render({ paging: paging({ loadingMore: true }) });
      expect(status().textContent).toContain('Loading more repositories');
    });

    it('marks the list busy while the first page loads and announces failures at once', () => {
      render({ loading: true });
      expect(list().getAttribute('aria-busy')).toBe('true');

      render({ error: 'GitHub is unreachable.' });
      expect(list().getAttribute('aria-busy')).toBeNull();
      expect(list().querySelector('[role="alert"]')?.textContent).toContain(
        'GitHub is unreachable.',
      );
    });
  });
});

/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  HomeBranchPicker,
  WorktreeBranchTargetPicker,
} from '@/components/home/HomeBranchPicker';
import {
  expectReplayBlocksOnlyValue,
  outermostReplayBlock,
} from '@/test-utils/replay';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  GITHUB_CONNECTION_CHANGED_EVENT,
  LINEAR_CONNECTION_CHANGED_EVENT,
} from '@/lib/integrationConnectionEvents';
import type { HomeBranchTarget } from '@/stores/homeComposerStore';
import type {
  PullRequestSummary,
  RepoSlug,
} from '@canopy/desktop-shared/types';

const mockSetBranchTarget = jest.fn();
const mockSelectWorkspace = jest.fn();
const mockSetPendingCreateFromReference = jest.fn();
let mockBranchTarget: HomeBranchTarget = { kind: 'new-worktree' };
let mockPendingCreateFromReference: string | null = null;
let mockPendingBranchPickerRequest: {
  tab: 'issues';
  nonce: number;
} | null = null;
const mockConsumeBranchPickerRequest = jest.fn((): void => {
  mockPendingBranchPickerRequest = null;
});

const WS1_PROJECT = {
  id: 'ws-1',
  name: 'Workspace',
  type: 'single-repo',
  repoPath: '/repos/ws-1',
  color: '#888888',
  collapsed: false,
  order: 0,
  worktrees: [
    { id: 'wt-1', branchName: 'feature/alpha', createdAt: 1 },
    { id: 'wt-2', branchName: 'feature/beta', createdAt: 2 },
  ],
};

// A sibling single-repo workspace, added to `mockProjectsState.projects` only
// by the cross-repo auto-switch tests below (reset to just WS1 in beforeEach).
const WS2_PROJECT = {
  id: 'ws-2',
  name: 'Other Workspace',
  type: 'single-repo',
  repoPath: '/repos/ws-2',
  color: '#444444',
  collapsed: false,
  order: 1,
  worktrees: [],
};

const mockProjectsState: { projects: unknown[] } = {
  projects: [WS1_PROJECT],
};

const mockComposerState = {
  workspaceId: 'ws-1',
  branchTargets: {
    supported: true,
    branches: [
      {
        name: 'main',
        isRemote: false,
        isCurrent: false,
        isUsedByWorktree: false,
        hasLocalRef: true,
        hasRemoteRef: false,
      },
    ],
  },
  setBranchTarget: mockSetBranchTarget,
};

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown): unknown =>
    selector(mockProjectsState),
}));

jest.mock('@/stores/homeComposerStore', () => {
  const readState = (): unknown => ({
    ...mockComposerState,
    branchTarget: mockBranchTarget,
    selectWorkspace: mockSelectWorkspace,
    pendingCreateFromReference: mockPendingCreateFromReference,
    setPendingCreateFromReference: mockSetPendingCreateFromReference,
    pendingBranchPickerRequest: mockPendingBranchPickerRequest,
    consumeBranchPickerRequest: mockConsumeBranchPickerRequest,
  });
  // `getState` is what the picker uses for the cross-repo auto-switch
  // (`useHomeComposerStore.getState().selectWorkspace(...)`); `Object.assign`
  // attaches it to the hook function without a type assertion.
  const useHomeComposerStore = Object.assign(
    (selector: (state: unknown) => unknown): unknown => selector(readState()),
    { getState: readState },
  );
  return { useHomeComposerStore };
});

const mockLoadLinearToken = jest.fn();
const mockValidateLinearToken = jest.fn();
const mockListPullRequests = jest.fn();
const mockResolvePullRequest = jest.fn();
const mockSearchPullRequests = jest.fn();
const mockSearchLinearIssues = jest.fn();
const mockLoadGitHubPat = jest.fn();
const mockGetGitHubCliStatus = jest.fn();
const mockGetRepoSlug = jest.fn();
const mockSetWorkspaceContext = jest.fn();

// PropertyDescriptor.value is untyped, so this stubs `window.api` with just the
// methods the picker touches without a type assertion.
Object.defineProperty(window, 'api', {
  configurable: true,
  writable: true,
  value: {
    loadLinearToken: mockLoadLinearToken,
    validateLinearToken: mockValidateLinearToken,
    listPullRequests: mockListPullRequests,
    resolvePullRequest: mockResolvePullRequest,
    searchPullRequests: mockSearchPullRequests,
    searchLinearIssues: mockSearchLinearIssues,
    loadGitHubPat: mockLoadGitHubPat,
    getGitHubCliStatus: mockGetGitHubCliStatus,
    getRepoSlug: mockGetRepoSlug,
    workspaceContext: {
      set: mockSetWorkspaceContext,
    },
  },
});

describe('HomeBranchPicker', () => {
  let container: HTMLDivElement;
  let root: Root;

  function query<T extends Element>(testId: string): T | null {
    return document.body.querySelector<T>(`[data-testid="${testId}"]`);
  }

  function openPicker(): void {
    act(() => {
      query<HTMLButtonElement>('home-branch-picker-button')?.click();
    });
  }

  function clickTab(testId: string): void {
    act(() => {
      query<HTMLButtonElement>(testId)?.click();
    });
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  /**
   * React installs its own `value` setter on the input node, so assigning
   * `input.value` directly leaves its change tracker thinking nothing changed
   * and `onChange` never fires. Go through the native setter instead.
   */
  function typeSearch(input: HTMLInputElement, value: string): void {
    const setValue =
      // eslint-disable-next-line @typescript-eslint/unbound-method -- always invoked with an explicit receiver below
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setValue?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function pressKey(target: HTMLElement, key: string): void {
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
    });
  }

  function searchInput(): HTMLInputElement {
    const input = query<HTMLInputElement>('home-branch-picker-search');
    if (!input) throw new Error('search input missing');
    return input;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockSetBranchTarget.mockClear();
    mockSelectWorkspace.mockClear();
    mockSetPendingCreateFromReference.mockClear();
    mockProjectsState.projects = [WS1_PROJECT];
    mockComposerState.workspaceId = 'ws-1';
    mockBranchTarget = { kind: 'new-worktree' };
    mockPendingCreateFromReference = null;
    mockPendingBranchPickerRequest = null;
    mockComposerState.branchTargets = {
      supported: true,
      branches: [
        {
          name: 'main',
          isRemote: false,
          isCurrent: false,
          isUsedByWorktree: false,
          hasLocalRef: true,
          hasRemoteRef: false,
        },
      ],
    };
    mockConsumeBranchPickerRequest.mockClear();
    // Default: the current workspace's origin slug matches the `acme/app` PR
    // URLs used across these tests, so the cross-repo auto-switch never fires
    // for existing cases.
    mockGetRepoSlug
      .mockReset()
      .mockResolvedValue({ owner: 'acme', repo: 'app' });
    // Linear stays unavailable by default (empty token → no validate call).
    mockLoadLinearToken.mockReset().mockResolvedValue('');
    mockValidateLinearToken.mockReset().mockResolvedValue({
      authenticated: false,
      displayName: null,
      error: null,
    });
    mockListPullRequests.mockReset().mockResolvedValue({ pullRequests: [] });
    mockResolvePullRequest.mockReset();
    mockSearchPullRequests.mockReset().mockResolvedValue({ pullRequests: [] });
    mockSearchLinearIssues.mockReset().mockResolvedValue([]);
    mockSetWorkspaceContext.mockReset().mockImplementation(() =>
      Promise.resolve({
        ...useWorkspaceContextStore.getState().state,
        context: { kind: 'personal' as const },
        revision: useWorkspaceContextStore.getState().state.revision + 1,
      }),
    );
    useWorkspaceContextStore.setState({
      state: { context: { kind: 'personal' }, revision: 0, organizations: [] },
      hydrated: true,
      accountEpoch: 0,
      appliedGeneration: 0,
    });
    // GitHub defaults to connected (signed-in gh CLI) so PR fetch-error tests
    // that don't care about auth keep rendering the raw error, not the connect
    // prompt. Auth-specific tests below override these per case.
    mockLoadGitHubPat.mockReset().mockResolvedValue('');
    mockGetGitHubCliStatus.mockReset().mockResolvedValue({
      authenticated: true,
      username: 'octocat',
      error: null,
    });
    // The navigation store is a module-level singleton; reset the settings
    // overlay flags each test so connect-row assertions start from a clean slate.
    act(() => {
      useNavigationStore.getState().closeSettings();
      useNavigationStore.getState().closeAddWorkspaceModal();
    });
    act(() => {
      root.render(createElement(HomeBranchPicker));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('switches an existing worktree without a trigger, the Worktrees tab, or the Home draft', () => {
    const onSelect = jest.fn();
    const onOpenChange = jest.fn();
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    mockPendingCreateFromReference = 'https://github.com/acme/app/pull/7';
    act(() => {
      root.render(
        createElement(WorktreeBranchTargetPicker, {
          workspaceId: 'ws-1',
          currentBranch: 'feature/alpha',
          branchTargets: {
            supported: true,
            defaultBranch: 'main',
            branches: [
              {
                name: 'release',
                isRemote: true,
                isCurrent: false,
                isUsedByWorktree: false,
                hasLocalRef: false,
                hasRemoteRef: true,
              },
            ],
          },
          onSelect,
          open: true,
          onOpenChange,
          anchorRef: { current: anchor },
          'data-testid': 'worktree-branch-picker-menu',
        }),
      );
    });

    expect(query('home-branch-picker-button')).toBeNull();
    expect(query('worktree-branch-picker-menu')).not.toBeNull();
    expect(query('home-branch-picker-tab-new')).toBeNull();
    expect(
      query('home-branch-picker-tab-branches')?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(query('home-branch-picker-tab-prs')).not.toBeNull();
    expect(query('home-branch-picker-tab-issues')).not.toBeNull();
    expect(document.activeElement).toBe(searchInput());
    // The Home draft's pending reference handoff is not consumed.
    expect(mockSetPendingCreateFromReference).not.toHaveBeenCalled();

    act(() => {
      query<HTMLButtonElement>('home-branch-picker-branch-release')?.click();
    });
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'branch',
      branchName: 'release',
      isRemote: true,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(anchor);
    expect(mockSetBranchTarget).not.toHaveBeenCalled();
    anchor.remove();
  });

  it('opens on the New worktree tab with the pinned option and worktrees', () => {
    openPicker();
    expect(
      query('home-branch-picker-tab-new')?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(query('home-branch-picker-new-worktree')).not.toBeNull();
    expect(query('home-branch-picker-worktree-wt-1')).not.toBeNull();
    expect(query('home-branch-picker-worktree-wt-2')).not.toBeNull();
  });

  it('renders compact, complete tabs in order with shared picker styling', () => {
    openPicker();
    expect(query('home-branch-picker-menu')?.getAttribute('style')).toContain(
      '--canopy-picker-minimum-width: 18.5rem',
    );
    expect(
      document.body
        .querySelector('[role="tablist"]')
        ?.getAttribute('aria-label'),
    ).toBe('Branch target sources');
    const tabs = Array.from(document.body.querySelectorAll('[role="tab"]'));
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Worktrees',
      'PRs',
      'Branches',
      'Issues',
    ]);
    expect(tabs[0]?.getAttribute('aria-label')).toBe('Worktrees');
    for (const tab of tabs) {
      expect(tab.className).toContain('canopy-picker-menu-tab');
      expect(tab.className).toContain('h-8');
      expect(tab.className).toContain('text-xs');
      expect(tab.className).toContain('whitespace-nowrap');
      expect(tab.className).not.toContain('truncate');
    }
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual([
      '0',
      '-1',
      '-1',
      '-1',
    ]);
    expect(tabs[0]?.getAttribute('aria-controls')).toBe(
      'home-branch-picker-options',
    );
    expect(
      document.body.querySelector('[role="tablist"]')?.className,
    ).toContain('canopy-picker-menu-tabs');
    expect(
      document.body.querySelector('[role="tablist"]')?.className,
    ).not.toContain('pt-1');
  });

  it('uses roving tab focus with wrapping arrow, Home, and End navigation', () => {
    openPicker();
    const newTab = query<HTMLButtonElement>('home-branch-picker-tab-new');
    if (!newTab) throw new Error('Worktrees tab missing');
    newTab?.focus();

    pressKey(newTab, 'ArrowRight');
    const prsTab = query<HTMLButtonElement>('home-branch-picker-tab-prs');
    if (!prsTab) throw new Error('Pull requests tab missing');
    expect(document.activeElement).toBe(prsTab);
    expect(prsTab?.getAttribute('aria-selected')).toBe('true');
    expect(prsTab?.getAttribute('tabindex')).toBe('0');
    expect(newTab?.getAttribute('tabindex')).toBe('-1');

    pressKey(prsTab, 'End');
    const issuesTab = query<HTMLButtonElement>('home-branch-picker-tab-issues');
    if (!issuesTab) throw new Error('Issues tab missing');
    expect(document.activeElement).toBe(issuesTab);
    expect(issuesTab?.getAttribute('aria-selected')).toBe('true');

    pressKey(issuesTab, 'ArrowRight');
    expect(document.activeElement).toBe(newTab);
    expect(newTab?.getAttribute('aria-selected')).toBe('true');

    pressKey(newTab, 'End');
    pressKey(issuesTab, 'Home');
    expect(document.activeElement).toBe(newTab);
  });

  it('labels the trigger with the selected target', () => {
    const trigger = query('home-branch-picker-button');
    const label = trigger?.querySelector('.truncate');
    expect(label?.textContent).toBe(trigger?.getAttribute('aria-label'));
  });

  it('records the portaled picker, which lists PR and issue titles', () => {
    openPicker();
    const menu = query('home-branch-picker-menu');
    expect(menu?.getAttribute('role')).toBe('dialog');
    expect(container.contains(menu)).toBe(false);
    expect(menu?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
  });

  it('focuses the search input when the picker expands', () => {
    openPicker();
    expect(document.activeElement).toBe(searchInput());
    expect(query('home-branch-picker-menu')?.className).toContain(
      'canopy-floating-menu',
    );
    expect(container.contains(query('home-branch-picker-menu'))).toBe(false);
  });

  it('uses the borderless composer capsule trigger', () => {
    const trigger = query<HTMLButtonElement>('home-branch-picker-button');

    expect(trigger?.className).toContain('h-8');
    expect(trigger?.className).toContain('rounded-full');
    expect(trigger?.className).toContain('border-0');
    expect(trigger?.className).toContain('bg-transparent');
    expect(trigger?.className).toContain('fg-primary');
    expect(trigger?.className).toContain('hover:bg-subtle');
    expect(query('home-branch-picker-source-icons')).not.toBeNull();
    expect(
      query('home-branch-picker-source-icons')?.querySelectorAll('svg'),
    ).toHaveLength(1);
    expect(
      query('home-branch-picker-source-icons')?.getAttribute('data-icon'),
    ).toBe('worktree');
  });

  it('shows a source icon that reflects the selected target', () => {
    const iconFor = (target: HomeBranchTarget): string | null | undefined => {
      mockBranchTarget = target;
      act(() => {
        root.render(createElement(HomeBranchPicker));
      });
      return query('home-branch-picker-source-icons')?.getAttribute(
        'data-icon',
      );
    };

    expect(iconFor({ kind: 'new-worktree' })).toBe('worktree');
    expect(iconFor({ kind: 'worktree', worktreeId: 'wt-1' })).toBe('worktree');
    expect(
      iconFor({ kind: 'branch', branchName: 'main', isRemote: false }),
    ).toBe('branch');
    expect(
      iconFor({
        kind: 'pr',
        number: 12,
        title: 'Add feature',
        headRefName: 'feat/add',
        url: 'https://example.test/12',
      }),
    ).toBe('pr');
    expect(
      iconFor({
        kind: 'linear-issue',
        identifier: 'ECW-1',
        title: 'Issue',
        branchName: 'ecw-1-issue',
      }),
    ).toBe('linear');
  });

  it('uses the shared portaled semantic layer', () => {
    openPicker();
    const popover = query<HTMLDivElement>('home-branch-picker-menu');
    expect(popover).not.toBeNull();
    expect(popover?.getAttribute('role')).toBe('dialog');
    expect(popover?.classList).toContain('canopy-floating-menu');
    expect(popover?.classList).toContain('canopy-picker-menu');
    expect(popover?.classList).toContain('bg-quaternary');
    expect(container.contains(popover)).toBe(false);
    expect(
      query('home-branch-picker-new-worktree')?.className.split(' '),
    ).toEqual(
      expect.arrayContaining(['min-h-8', 'py-2', 'rounded-md', 'text-s']),
    );
  });

  it('shares the flagship picker anatomy with search above tabs', () => {
    openPicker();
    const search = query<HTMLInputElement>('home-branch-picker-search');
    const tablist = document.body.querySelector('[role="tablist"]');
    const row = query<HTMLButtonElement>('home-branch-picker-worktree-wt-1');
    const selectedRow = query<HTMLButtonElement>(
      'home-branch-picker-new-worktree',
    );

    expect(
      search?.closest('.canopy-picker-menu-search-field')?.className,
    ).toContain('h-8');
    expect(search?.className).not.toContain('h-8');
    expect(search?.className).toContain('border-0');
    expect(search?.className).toContain('bg-transparent');
    expect(search?.className).toContain('fg-primary');
    expect(search?.className).toContain('placeholder:fg-tertiary');
    expect(
      search
        ?.closest('.canopy-picker-menu-search')
        ?.compareDocumentPosition(tablist ?? document.body) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(row?.className.split(' ')).toEqual(
      expect.arrayContaining([
        'canopy-picker-menu-option',
        'min-h-8',
        'py-2',
        'min-w-0',
        'gap-2',
        'px-2',
        'rounded-md',
      ]),
    );
    expect(row?.querySelector('.h-4.w-4.shrink-0')).not.toBeNull();
    expect(row?.querySelector('.min-w-0.flex-1')).not.toBeNull();
    // Unselected rows omit the check rail; selecting mounts it on the right,
    // replacing any status icon in that slot.
    expect(row?.querySelector('[data-picker-selected-check]')).toBeNull();
    expect(
      selectedRow?.querySelector('[data-picker-selected-check="true"]'),
    ).not.toBeNull();
    expect(row?.textContent).toContain('feature/alpha');
    expect(row?.querySelector('.canopy-picker-menu-section-label')).toBeNull();
    const sectionLabel = document.body.querySelector<HTMLElement>(
      '.canopy-picker-menu-section-label',
    );
    expect(sectionLabel?.textContent).toContain('Existing worktrees');
    expect(sectionLabel?.className).toContain('normal-case');
    expect(sectionLabel?.className).toContain('font-normal');
    expect(sectionLabel?.className).not.toContain('uppercase');
    expect(
      row?.querySelector('.canopy-picker-menu-option-label.font-mono'),
    ).toBeNull();
  });

  describe('active row scrolling', () => {
    let scrollIntoView: jest.Mock;

    beforeEach(() => {
      scrollIntoView = jest.fn();
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: scrollIntoView,
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    });

    it('does not scroll when pointer hover changes the active row', () => {
      openPicker();
      scrollIntoView.mockClear();

      const row = query<HTMLButtonElement>('home-branch-picker-worktree-wt-2');
      if (!row) throw new Error('worktree row missing');
      act(() => {
        row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      });

      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('scrolls when keyboard navigation changes the active row', () => {
      openPicker();
      scrollIntoView.mockClear();

      const search = query<HTMLInputElement>('home-branch-picker-search');
      if (!search) throw new Error('search input missing');
      pressKey(search, 'ArrowDown');

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    });
  });

  it('filters the existing worktree list by the search query', () => {
    openPicker();
    expect(query('home-branch-picker-worktree-wt-1')).not.toBeNull();
    expect(query('home-branch-picker-worktree-wt-2')).not.toBeNull();

    typeSearch(searchInput(), 'beta');

    expect(query('home-branch-picker-worktree-wt-1')).toBeNull();
    expect(query('home-branch-picker-worktree-wt-2')).not.toBeNull();

    typeSearch(searchInput(), 'nothing-matches');
    expect(query('home-branch-picker-empty')).not.toBeNull();
  });

  it('arrows through the New worktree tab and selects the active row with Enter', () => {
    openPicker();
    const input = searchInput();

    // Navigation order on the New tab: New worktree, wt-1, wt-2.
    pressKey(input, 'ArrowDown');
    pressKey(input, 'ArrowDown');
    expect(
      query('home-branch-picker-worktree-wt-2')?.getAttribute('data-active'),
    ).toBe('true');

    pressKey(input, 'Enter');
    expect(mockSetBranchTarget).toHaveBeenCalledWith({
      kind: 'worktree',
      worktreeId: 'wt-2',
    });
  });

  it('wraps ArrowUp from the first row to the last option', () => {
    openPicker();
    pressKey(searchInput(), 'ArrowUp');
    expect(
      query('home-branch-picker-worktree-wt-2')?.getAttribute('data-active'),
    ).toBe('true');
  });

  it('restores the selected row after closing with a filtered query', () => {
    mockBranchTarget = { kind: 'worktree', worktreeId: 'wt-2' };
    act(() => {
      root.render(createElement(HomeBranchPicker));
    });

    openPicker();
    typeSearch(searchInput(), 'nothing-matches');
    pressKey(searchInput(), 'Escape');
    openPicker();

    expect(searchInput().value).toBe('');
    expect(
      query('home-branch-picker-worktree-wt-2')?.getAttribute('data-active'),
    ).toBe('true');
  });

  it('closes when Escape is pressed on the open trigger', () => {
    openPicker();
    const trigger = query<HTMLButtonElement>('home-branch-picker-button');
    if (!trigger) throw new Error('branch picker trigger missing');

    trigger.focus();
    pressKey(trigger, 'Escape');

    expect(query('home-branch-picker-search')).toBeNull();
  });

  it('keeps the search header outside the sole gutter-owning option viewport', () => {
    openPicker();

    const list = query<HTMLDivElement>('home-branch-picker-list');
    expect(list).not.toBeNull();
    expect(
      searchInput().closest('[data-testid="home-branch-picker-list"]'),
    ).toBeNull();
    expect(
      query<HTMLButtonElement>('home-branch-picker-new-worktree')?.closest(
        '[data-testid="home-branch-picker-list"]',
      ),
    ).toBe(list);
    expect(
      query<HTMLButtonElement>('home-branch-picker-worktree-wt-1')?.closest(
        '[data-testid="home-branch-picker-list"]',
      ),
    ).toBe(list);
    expect(list?.className).toContain('canopy-picker-menu-list');
    expect(list?.className).toContain('overflow-y-auto');
  });

  it('selects a branch from the Branches tab', () => {
    openPicker();
    clickTab('home-branch-picker-tab-branches');

    const row = query<HTMLButtonElement>('home-branch-picker-branch-main');
    expect(row).not.toBeNull();
    act(() => row?.click());

    expect(mockSetBranchTarget).toHaveBeenCalledWith({
      kind: 'branch',
      branchName: 'main',
      isRemote: false,
    });
  });

  it('shows a local-branch tooltip for local-only provenance', () => {
    mockComposerState.branchTargets = {
      supported: true,
      branches: [
        {
          name: 'main',
          isRemote: false,
          isCurrent: false,
          isUsedByWorktree: false,
          hasLocalRef: true,
          hasRemoteRef: false,
        },
      ],
    };

    openPicker();
    clickTab('home-branch-picker-tab-branches');

    const localRow = query<HTMLButtonElement>('home-branch-picker-branch-main');
    expect(
      localRow?.querySelector(
        '.canopy-picker-menu-option-trailing[aria-label="Local branch"]',
      ),
    ).not.toBeNull();
    expect(localRow?.textContent).not.toMatch(/\blocal\b/);
    expect(
      localRow
        ?.querySelector('.canopy-picker-menu-option-trailing')
        ?.className.split(/\s+/),
    ).toEqual(expect.arrayContaining(['fg-quaternary', 'hover:fg-secondary']));

    act(() => {
      localRow?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      localRow?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    const badge = query('home-branch-picker-local-badge-main');
    expect(badge).not.toBeNull();
    act(() => {
      badge?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      badge?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    const tip = document.body.querySelector('[role="tooltip"]');
    expect(tip?.textContent).toContain('Local branch');
    expect(tip?.className).toContain('bg-tooltip-inverse');
  });

  it('shows a remote-branch tooltip for remote-only provenance', () => {
    mockComposerState.branchTargets = {
      supported: true,
      branches: [
        {
          name: 'release/0.26',
          isRemote: true,
          isCurrent: false,
          isUsedByWorktree: false,
          hasLocalRef: false,
          hasRemoteRef: true,
        },
        {
          name: 'experiment/slate-perf',
          isRemote: false,
          isCurrent: false,
          isUsedByWorktree: false,
          hasLocalRef: true,
          hasRemoteRef: true,
        },
      ],
    };

    openPicker();
    clickTab('home-branch-picker-tab-branches');

    const remoteRow = query<HTMLButtonElement>(
      'home-branch-picker-branch-release/0.26',
    );
    const bothRow = query<HTMLButtonElement>(
      'home-branch-picker-branch-experiment/slate-perf',
    );

    expect(
      remoteRow?.querySelector(
        '.canopy-picker-menu-option-trailing[aria-label="Remote branch"]',
      ),
    ).not.toBeNull();
    expect(remoteRow?.textContent).not.toMatch(/\bremote\b/);
    expect(
      bothRow?.querySelector('.canopy-picker-menu-option-trailing'),
    ).toBeNull();
    expect(
      remoteRow
        ?.querySelector('.canopy-picker-menu-option-trailing')
        ?.className.split(/\s+/),
    ).toEqual(expect.arrayContaining(['fg-quaternary', 'hover:fg-secondary']));

    act(() => {
      remoteRow?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      remoteRow?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    const badge = query('home-branch-picker-remote-badge-release/0.26');
    expect(badge).not.toBeNull();
    act(() => {
      badge?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      badge?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    const tip = document.body.querySelector('[role="tooltip"]');
    expect(tip?.textContent).toContain('Remote branch');
    expect(tip?.className).toContain('bg-tooltip-inverse');
  });

  it('lists PRs and selects one with the right target while disabling fork rows', async () => {
    mockListPullRequests.mockResolvedValue({
      pullRequests: [
        {
          number: 12,
          title: 'Add feature',
          headRefName: 'feat/add',
          baseRefName: 'main',
          url: 'https://example.test/12',
          authorLogin: 'alice',
          isDraft: false,
          isCrossRepo: false,
        },
        {
          number: 21,
          title: 'WIP polish',
          headRefName: 'wip/polish',
          baseRefName: 'main',
          url: 'https://example.test/21',
          authorLogin: 'carol',
          isDraft: true,
          isCrossRepo: false,
        },
        {
          number: 34,
          title: 'From a fork',
          headRefName: 'fork/thing',
          baseRefName: 'main',
          url: 'https://example.test/34',
          authorLogin: 'bob',
          isDraft: false,
          isCrossRepo: true,
        },
      ],
    });

    openPicker();
    clickTab('home-branch-picker-tab-prs');
    await flush();
    await flush();

    expect(mockListPullRequests).toHaveBeenCalledWith({
      repoPath: '/repos/ws-1',
    });

    const forkRow = query<HTMLButtonElement>('home-branch-picker-pr-34');
    expect(forkRow?.disabled).toBe(true);
    // An unavailable row stays readable in the quaternary ink (not the faded
    // control ink), and its rail and description follow through the group.
    expect(forkRow?.className.split(' ')).toContain('disabled:fg-quaternary');
    expect(forkRow?.className.split(' ')).toContain('disabled:opacity-100');
    expect(
      forkRow?.querySelector('.h-4.w-4.shrink-0')?.className.split(' '),
    ).toContain('group-disabled/picker-option:fg-quaternary');
    expect(
      forkRow?.querySelector('.leading-3')?.className.split(' '),
    ).toContain('group-disabled/picker-option:fg-quaternary');
    expect(
      forkRow
        ?.querySelector(
          '.canopy-picker-menu-option-trailing[aria-label="Fork"]',
        )
        ?.className.split(' '),
    ).toContain('fg-quaternary');
    expect(forkRow?.querySelector('[data-picker-selected-check]')).toBeNull();

    act(() => {
      const wrapper = forkRow?.parentElement;
      wrapper?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      wrapper?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    const tip = document.body.querySelector('[role="tooltip"]');
    expect(tip?.textContent).toContain("Can't create a worktree from a fork");
    expect(tip?.className).toContain('bg-tooltip-inverse');

    const prRow = query<HTMLButtonElement>('home-branch-picker-pr-12');
    expect(prRow).not.toBeNull();
    // Session replay blocks each author login, not the clickable row, its
    // title, or its number.
    for (const login of ['alice', 'carol', 'bob']) {
      expectReplayBlocksOnlyValue(document.body, login);
    }
    expect(outermostReplayBlock(prRow)).toBeNull();
    expect(prRow?.textContent).toContain('Add feature');
    expect(prRow?.textContent).toContain('#12 · alice');
    act(() => prRow?.click());

    expect(mockSetBranchTarget).toHaveBeenCalledWith({
      kind: 'pr',
      number: 12,
      title: 'Add feature',
      headRefName: 'feat/add',
      url: 'https://example.test/12',
    });
  });

  it('shows a draft tooltip on draft PR rows', async () => {
    mockListPullRequests.mockResolvedValue({
      pullRequests: [
        {
          number: 21,
          title: 'WIP polish',
          headRefName: 'wip/polish',
          baseRefName: 'main',
          url: 'https://example.test/21',
          authorLogin: 'carol',
          isDraft: true,
          isCrossRepo: false,
        },
      ],
    });

    openPicker();
    clickTab('home-branch-picker-tab-prs');
    await flush();
    await flush();

    const draftRow = query<HTMLButtonElement>('home-branch-picker-pr-21');
    expect(draftRow?.disabled).toBe(false);
    expect(
      draftRow
        ?.querySelector(
          '.canopy-picker-menu-option-trailing[aria-label="Draft"]',
        )
        ?.className.split(' '),
    ).toContain('fg-quaternary');

    act(() => {
      const wrapper = draftRow?.parentElement;
      wrapper?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      wrapper?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    const tip = document.body.querySelector('[role="tooltip"]');
    expect(tip?.textContent).toContain('Draft PR');
    expect(tip?.className).toContain('bg-tooltip-inverse');

    act(() => draftRow?.click());
    expect(mockSetBranchTarget).toHaveBeenCalledWith({
      kind: 'pr',
      number: 21,
      title: 'WIP polish',
      headRefName: 'wip/polish',
      url: 'https://example.test/21',
    });

    mockBranchTarget = {
      kind: 'pr',
      number: 21,
      title: 'WIP polish',
      headRefName: 'wip/polish',
      url: 'https://example.test/21',
    };
    act(() => root.render(createElement(HomeBranchPicker)));
    openPicker();
    clickTab('home-branch-picker-tab-prs');
    await flush();
    await flush();

    const selectedDraft = query<HTMLButtonElement>('home-branch-picker-pr-21');
    expect(
      selectedDraft?.querySelector(
        '.canopy-picker-menu-option-trailing[aria-label="Draft"]',
      ),
    ).toBeNull();
    expect(
      selectedDraft?.querySelector('[data-picker-selected-check="true"]'),
    ).not.toBeNull();

    act(() => {
      const wrapper = selectedDraft?.parentElement;
      wrapper?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      wrapper?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    expect(
      document.body.querySelector('[role="tooltip"]')?.textContent,
    ).toContain('Draft PR');
  });

  it('matches a pasted same-repo PR URL against the loaded PR list', async () => {
    mockListPullRequests.mockResolvedValue({
      pullRequests: [
        {
          number: 12,
          title: 'Add feature',
          headRefName: 'feat/add',
          baseRefName: 'main',
          url: 'https://github.com/acme/app/pull/12',
          authorLogin: 'alice',
          isDraft: false,
          isCrossRepo: false,
        },
      ],
    });

    openPicker();
    clickTab('home-branch-picker-tab-prs');
    await flush();
    await flush();

    typeSearch(searchInput(), 'https://github.com/acme/app/pull/12');
    await flush();
    await flush();

    expect(query('home-branch-picker-pr-12')).not.toBeNull();
    expect(query('home-branch-picker-pr-empty')).toBeNull();
    expect(query('home-branch-picker-pr-resolve')).toBeNull();

    const prRow = query<HTMLButtonElement>('home-branch-picker-pr-12');
    act(() => prRow?.click());

    expect(mockSetBranchTarget).toHaveBeenCalledWith({
      kind: 'pr',
      number: 12,
      title: 'Add feature',
      headRefName: 'feat/add',
      url: 'https://github.com/acme/app/pull/12',
    });
  });

  it('treats a foreign-repo PR URL as not-in-list and shows the add-workspace offer row instead of the same-numbered local PR', async () => {
    mockListPullRequests.mockResolvedValue({
      pullRequests: [
        {
          number: 12,
          title: 'Local twelve',
          headRefName: 'feat/local',
          baseRefName: 'main',
          url: 'https://github.com/acme/app/pull/12',
          authorLogin: 'alice',
          isDraft: false,
          isCrossRepo: false,
        },
      ],
    });

    openPicker();
    clickTab('home-branch-picker-tab-prs');
    await flush();
    await flush();

    // A different owner/repo, same number as the workspace's own open PR.
    typeSearch(searchInput(), 'https://github.com/other/repo/pull/12');
    await flush();
    await flush();
    await flush();

    // The local #12 must NOT be offered as a match for a foreign-repo URL…
    expect(query('home-branch-picker-pr-12')).toBeNull();
    expect(query('home-branch-picker-pr-empty')).toBeNull();
    // …and since no workspace owns `other/repo`, the add-workspace offer row
    // replaces the dead-end resolve row.
    expect(query('home-branch-picker-pr-add-workspace')).not.toBeNull();
    expect(query('home-branch-picker-pr-resolve')).toBeNull();
  });

  it('auto-switches to a sibling project when a pasted foreign PR URL matches its repo slug', async () => {
    mockProjectsState.projects = [WS1_PROJECT, WS2_PROJECT];
    mockGetRepoSlug.mockImplementation(
      ({ repoPath }: { repoPath: string }): Promise<RepoSlug> =>
        Promise.resolve(
          repoPath === '/repos/ws-2'
            ? { owner: 'other', repo: 'repo' }
            : { owner: 'acme', repo: 'app' },
        ),
    );

    openPicker();
    clickTab('home-branch-picker-tab-prs');
    await flush();
    await flush();

    typeSearch(searchInput(), 'https://github.com/other/repo/pull/9');
    await flush();
    await flush();
    await flush();

    // The composer switches to the workspace that owns `other/repo`…
    expect(mockSelectWorkspace).toHaveBeenCalledWith('ws-2');
    // …while the pasted search text and the PRs tab are preserved.
    expect(searchInput().value).toBe('https://github.com/other/repo/pull/9');
    expect(
      query('home-branch-picker-tab-prs')?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('does not switch projects when a pasted foreign PR URL matches no sibling repo', async () => {
    mockListPullRequests.mockResolvedValue({
      pullRequests: [
        {
          number: 12,
          title: 'Local twelve',
          headRefName: 'feat/local',
          baseRefName: 'main',
          url: 'https://github.com/acme/app/pull/12',
          authorLogin: 'alice',
          isDraft: false,
          isCrossRepo: false,
        },
      ],
    });

    openPicker();
    clickTab('home-branch-picker-tab-prs');
    await flush();
    await flush();

    // Only WS1 (acme/app) exists, so a foreign `other/repo` URL matches nothing.
    typeSearch(searchInput(), 'https://github.com/other/repo/pull/12');
    await flush();
    await flush();
    await flush();

    expect(mockSelectWorkspace).not.toHaveBeenCalled();
    // Nothing switches: the add-workspace offer row replaces the resolve row.
    expect(query('home-branch-picker-pr-add-workspace')).not.toBeNull();
    expect(query('home-branch-picker-pr-resolve')).toBeNull();
  });

  it('offers to add a project for a foreign PR URL and hands off to the modal on activation', async () => {
    mockListPullRequests.mockResolvedValue({ pullRequests: [] });

    openPicker();
    clickTab('home-branch-picker-tab-prs');
    await flush();
    await flush();

    // A foreign owner/repo owned by no eligible workspace.
    typeSearch(searchInput(), 'https://github.com/other/repo/pull/9');
    await flush();
    await flush();
    await flush();

    const offerRow = query<HTMLButtonElement>(
      'home-branch-picker-pr-add-workspace',
    );
    expect(offerRow).not.toBeNull();
    expect(offerRow?.getAttribute('role')).toBe('option');
    expect(offerRow?.textContent).toContain('Add other/repo as a project');
    // The offer row REPLACES the dead-end resolve row.
    expect(query('home-branch-picker-pr-resolve')).toBeNull();

    act(() => offerRow?.click());

    // The pasted reference is stashed for the post-create resume…
    expect(mockSetPendingCreateFromReference).toHaveBeenCalledWith(
      'https://github.com/other/repo/pull/9',
    );
    // …the Add Workspace modal opens pre-filled with the repo URL…
    expect(useNavigationStore.getState().addWorkspaceModalOpen).toBe(true);
    expect(useNavigationStore.getState().addWorkspaceInitialRepoUrl).toBe(
      'https://github.com/other/repo',
    );
    // …and the picker closes.
    expect(query('home-branch-picker-search')).toBeNull();
  });

  it('switches an organization context to Personal before opening the prefilled clone dialog', async () => {
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'organization', organizationId: 'org-a' },
        revision: 1,
        organizations: [{ id: 'org-a', name: 'Acme', role: 'MEMBER' }],
      },
    });
    mockListPullRequests.mockResolvedValue({ pullRequests: [] });

    openPicker();
    clickTab('home-branch-picker-tab-prs');
    await flush();
    await flush();
    typeSearch(searchInput(), 'https://github.com/other/repo/pull/9');
    await flush();
    await flush();
    await flush();

    act(() =>
      query<HTMLButtonElement>('home-branch-picker-pr-add-workspace')?.click(),
    );
    expect(useNavigationStore.getState().addWorkspaceModalOpen).toBe(false);

    await flush();

    expect(mockSetWorkspaceContext).toHaveBeenCalledWith({
      context: { kind: 'personal' },
      expectedRevision: 1,
    });
    expect(useWorkspaceContextStore.getState().state.context).toEqual({
      kind: 'personal',
    });
    expect(useNavigationStore.getState().addWorkspaceModalOpen).toBe(true);
    expect(useNavigationStore.getState().addWorkspaceInitialRepoUrl).toBe(
      'https://github.com/other/repo',
    );
  });

  it('resumes on the PRs tab with the reference seeded once a create-from reference is pending and a project is selected', async () => {
    mockPendingCreateFromReference = 'https://github.com/acme/app/pull/5';
    mockListPullRequests.mockResolvedValue({ pullRequests: [] });

    // Re-render so the pending reference is present at mount, driving the
    // resume effect (workspace `ws-1` differs from the null resume origin).
    act(() => {
      root.render(createElement(HomeBranchPicker));
    });
    await flush();
    await flush();

    // The picker auto-opened on the PRs tab with the reference in the search…
    expect(query('home-branch-picker-search')).not.toBeNull();
    expect(searchInput().value).toBe('https://github.com/acme/app/pull/5');
    expect(
      query('home-branch-picker-tab-prs')?.getAttribute('aria-selected'),
    ).toBe('true');
    // …and the stash was consumed exactly once.
    expect(mockSetPendingCreateFromReference).toHaveBeenCalledWith(null);
  });

  it('does not switch after the search changes before the slug lookups resolve', async () => {
    mockProjectsState.projects = [WS1_PROJECT, WS2_PROJECT];

    let resolveSiblingSlug: (slug: RepoSlug) => void = (): void => {};
    const siblingSlug = new Promise<RepoSlug>((resolve) => {
      resolveSiblingSlug = resolve;
    });
    mockGetRepoSlug.mockImplementation(
      ({ repoPath }: { repoPath: string }): Promise<RepoSlug> =>
        repoPath === '/repos/ws-2'
          ? siblingSlug
          : Promise.resolve({ owner: 'acme', repo: 'app' }),
    );

    openPicker();
    clickTab('home-branch-picker-tab-prs');
    await flush();
    await flush();

    // Paste a foreign URL — the sibling slug lookup is now pending.
    typeSearch(searchInput(), 'https://github.com/other/repo/pull/9');
    await flush();
    await flush();

    // Change the search before the lookup resolves: the in-flight run is stale.
    typeSearch(searchInput(), 'plain-branch-text');
    await flush();

    // The sibling now resolves to a matching slug, but the run was cancelled.
    await act(async () => {
      resolveSiblingSlug({ owner: 'other', repo: 'repo' });
      await Promise.resolve();
    });
    await flush();
    await flush();

    expect(mockSelectWorkspace).not.toHaveBeenCalled();
  });

  it('drops a PR lookup that finishes after the worktree picker is dismissed', async () => {
    mockListPullRequests.mockRejectedValue(new Error('offline'));
    let finishLookup: () => void = () => undefined;
    mockResolvePullRequest.mockReturnValue(
      new Promise((resolve) => {
        finishLookup = (): void =>
          resolve({
            number: 7,
            title: 'Resolved seven',
            headRefName: 'feat/seven',
            baseRefName: 'main',
            url: 'https://github.com/acme/app/pull/7',
          });
      }),
    );
    const onSelect = jest.fn();
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const render = (open: boolean): void =>
      act(() => {
        root.render(
          createElement(WorktreeBranchTargetPicker, {
            workspaceId: 'ws-1',
            currentBranch: 'feature/alpha',
            branchTargets: {
              supported: true,
              defaultBranch: 'main',
              branches: [],
            },
            onSelect,
            open,
            onOpenChange: () => undefined,
            anchorRef: { current: anchor },
          }),
        );
      });
    render(true);
    clickTab('home-branch-picker-tab-prs');
    await flush();
    await flush();
    typeSearch(searchInput(), '#7');
    await flush();
    await flush();
    act(() =>
      query<HTMLButtonElement>('home-branch-picker-pr-resolve')?.click(),
    );
    expect(mockResolvePullRequest).toHaveBeenCalled();

    render(false);
    finishLookup();
    await flush();
    await flush();

    expect(onSelect).not.toHaveBeenCalled();
    anchor.remove();
  });

  it('renders a selectable resolve row in the PR fetch-error state', async () => {
    mockListPullRequests.mockRejectedValue(new Error('offline'));
    mockResolvePullRequest.mockResolvedValue({
      number: 7,
      title: 'Resolved seven',
      headRefName: 'feat/seven',
      baseRefName: 'main',
      url: 'https://github.com/acme/app/pull/7',
    });

    openPicker();
    clickTab('home-branch-picker-tab-prs');
    await flush();
    await flush();

    // The fetch failed: the error message is shown.
    expect(query('home-branch-picker-pr-error')?.textContent).toContain(
      'offline',
    );

    // Pasting a PR reference offline still surfaces the resolve row…
    typeSearch(searchInput(), '#7');
    await flush();
    await flush();

    const resolveRow = query<HTMLButtonElement>(
      'home-branch-picker-pr-resolve',
    );
    expect(resolveRow).not.toBeNull();

    // …and it is selectable, driving the cross-repo-aware resolver.
    act(() => resolveRow?.click());
    await flush();
    await flush();

    expect(mockResolvePullRequest).toHaveBeenCalledWith({
      repoPath: '/repos/ws-1',
      reference: '#7',
    });
    expect(mockSetBranchTarget).toHaveBeenCalledWith({
      kind: 'pr',
      number: 7,
      title: 'Resolved seven',
      headRefName: 'feat/seven',
      url: 'https://github.com/acme/app/pull/7',
    });
  });

  it('auto-switches to the PRs tab on a pasted PR URL and keeps a manual tab click sticky', async () => {
    openPicker();
    expect(
      query('home-branch-picker-tab-new')?.getAttribute('aria-selected'),
    ).toBe('true');

    typeSearch(searchInput(), 'https://github.com/acme/app/pull/9');
    await flush();
    await flush();

    expect(
      query('home-branch-picker-tab-prs')?.getAttribute('aria-selected'),
    ).toBe('true');

    // A manual click back to Branches sticks: nothing re-detects on click.
    clickTab('home-branch-picker-tab-branches');
    expect(
      query('home-branch-picker-tab-branches')?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      query('home-branch-picker-tab-prs')?.getAttribute('aria-selected'),
    ).toBe('false');
  });

  it('auto-switches to the PRs tab on an explicit #-prefixed number', async () => {
    openPicker();
    expect(
      query('home-branch-picker-tab-new')?.getAttribute('aria-selected'),
    ).toBe('true');

    typeSearch(searchInput(), '#123');
    await flush();
    await flush();

    expect(
      query('home-branch-picker-tab-prs')?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('does not auto-switch to the PRs tab when a bare number is typed on the Issues tab', () => {
    // A bare number is ambiguous — it could be a Linear ticket number typed
    // on the Issues tab — so it must stay filter text instead of yanking the
    // user to PRs on the first digit.
    openPicker();
    clickTab('home-branch-picker-tab-issues');
    expect(
      query('home-branch-picker-tab-issues')?.getAttribute('aria-selected'),
    ).toBe('true');

    typeSearch(searchInput(), '8121');

    expect(
      query('home-branch-picker-tab-issues')?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      query('home-branch-picker-tab-prs')?.getAttribute('aria-selected'),
    ).toBe('false');
    expect(searchInput().value).toBe('8121');
  });

  it('does not auto-switch to the PRs tab when a bare number is typed on the Branches tab', () => {
    openPicker();
    clickTab('home-branch-picker-tab-branches');
    expect(
      query('home-branch-picker-tab-branches')?.getAttribute('aria-selected'),
    ).toBe('true');

    typeSearch(searchInput(), '8121');

    expect(
      query('home-branch-picker-tab-branches')?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      query('home-branch-picker-tab-prs')?.getAttribute('aria-selected'),
    ).toBe('false');
    expect(searchInput().value).toBe('8121');
  });

  it('keeps the Issues tab enabled without Linear and offers a connect row that opens Settings → Account', () => {
    openPicker();
    const issuesTab = query<HTMLButtonElement>('home-branch-picker-tab-issues');
    expect(issuesTab).not.toBeNull();
    expect(issuesTab?.disabled).toBe(false);

    clickTab('home-branch-picker-tab-issues');
    expect(
      query('home-branch-picker-tab-issues')?.getAttribute('aria-selected'),
    ).toBe('true');

    const connectRow = query<HTMLButtonElement>(
      'home-branch-picker-issues-connect',
    );
    expect(connectRow).not.toBeNull();
    expect(connectRow?.getAttribute('role')).toBe('option');
    expect(connectRow?.className.split(' ')).toContain('fg-accent');
    expect(connectRow?.getAttribute('data-tone')).toBe('accent');
    expect(
      connectRow?.querySelector('.h-4.w-4.shrink-0')?.className.split(' '),
    ).toContain('group-data-[tone=accent]/picker-option:fg-accent');

    act(() => connectRow?.click());

    // The connect row opens Settings on the Account section and closes the picker.
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
    expect(useNavigationStore.getState().settingsInitialSection).toBe(
      'account',
    );
    expect(query('home-branch-picker-search')).toBeNull();
  });

  it('switches to the Issues tab and shows the connect row when a Linear id is pasted while Linear is unavailable', () => {
    openPicker();
    expect(
      query('home-branch-picker-tab-new')?.getAttribute('aria-selected'),
    ).toBe('true');

    typeSearch(searchInput(), 'ECW-8121');

    expect(
      query('home-branch-picker-tab-issues')?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(query('home-branch-picker-issues-connect')).not.toBeNull();
  });

  it('shows the GitHub connect state on a PR fetch error when neither a PAT nor the gh CLI is authenticated', async () => {
    mockListPullRequests.mockRejectedValue(new Error('Not Found'));
    mockResolvePullRequest.mockResolvedValue({
      number: 7,
      title: 'Resolved seven',
      headRefName: 'feat/seven',
      baseRefName: 'main',
      url: 'https://github.com/acme/app/pull/7',
    });
    mockLoadGitHubPat.mockResolvedValue('');
    mockGetGitHubCliStatus.mockResolvedValue({
      authenticated: false,
      username: null,
      error: null,
    });

    openPicker();
    clickTab('home-branch-picker-tab-prs');
    await flush();
    await flush();
    // Let the lazy GitHub connectivity check resolve.
    await flush();
    await flush();

    const connectRow = query<HTMLButtonElement>(
      'home-branch-picker-pr-connect',
    );
    expect(connectRow).not.toBeNull();
    expect(connectRow?.getAttribute('role')).toBe('option');
    expect(connectRow?.textContent).toContain('Connect GitHub');
    expect(connectRow?.textContent).not.toContain('Settings');
    expect(connectRow?.className.split(' ')).toContain('fg-accent');
    expect(connectRow?.getAttribute('data-tone')).toBe('accent');
    expect(
      connectRow?.querySelector('.h-4.w-4.shrink-0')?.className.split(' '),
    ).toContain('group-data-[tone=accent]/picker-option:fg-accent');
    // The raw fetch error is replaced by the connect guidance.
    expect(query('home-branch-picker-pr-error')).toBeNull();

    // A pasted PR reference still surfaces the resolve row alongside the prompt.
    typeSearch(searchInput(), '#7');
    await flush();
    await flush();
    expect(query('home-branch-picker-pr-resolve')).not.toBeNull();

    // The connect row opens Settings → Account and closes the picker.
    act(() => connectRow?.click());
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
    expect(useNavigationStore.getState().settingsInitialSection).toBe(
      'account',
    );
    expect(query('home-branch-picker-search')).toBeNull();
  });

  // A staged branch-picker request opens the requested tab with a transient
  // highlight and is consumed exactly once.
  it('opens on the Issues tab from a staged branch-picker request when Linear is available', async () => {
    mockLoadLinearToken.mockResolvedValue('lin_api_connected');
    mockValidateLinearToken.mockResolvedValue({
      authenticated: true,
      displayName: 'Ryan',
      error: null,
    });
    act(() => {
      window.dispatchEvent(new Event(LINEAR_CONNECTION_CHANGED_EVENT));
    });
    await flush();
    await flush();

    mockPendingBranchPickerRequest = { tab: 'issues', nonce: 1 };
    act(() => {
      root.render(createElement(HomeBranchPicker));
    });
    await flush();

    expect(mockConsumeBranchPickerRequest).toHaveBeenCalledTimes(1);
    expect(query('home-branch-picker-menu')).not.toBeNull();
    const issuesTab = query('home-branch-picker-tab-issues');
    expect(issuesTab?.getAttribute('aria-selected')).toBe('true');
    expect(issuesTab?.getAttribute('data-highlighted')).toBe('true');
  });

  it('falls back to the New tab for a staged Issues request when Linear is unavailable', async () => {
    // Linear stays unavailable (beforeEach default: empty token).
    mockPendingBranchPickerRequest = { tab: 'issues', nonce: 1 };
    act(() => {
      root.render(createElement(HomeBranchPicker));
    });
    await flush();

    expect(mockConsumeBranchPickerRequest).toHaveBeenCalledTimes(1);
    expect(query('home-branch-picker-menu')).not.toBeNull();
    expect(
      query('home-branch-picker-tab-new')?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      query('home-branch-picker-tab-issues')?.getAttribute('data-highlighted'),
    ).toBeNull();
  });

  it('switches an already-open picker to Issues when Linear is available', async () => {
    mockLoadLinearToken.mockResolvedValue('lin_api_connected');
    mockValidateLinearToken.mockResolvedValue({
      authenticated: true,
      displayName: 'Ryan',
      error: null,
    });
    act(() => {
      window.dispatchEvent(new Event(LINEAR_CONNECTION_CHANGED_EVENT));
    });
    await flush();
    await flush();

    openPicker();
    mockPendingBranchPickerRequest = { tab: 'issues', nonce: 1 };
    act(() => {
      root.render(createElement(HomeBranchPicker));
    });
    await flush();

    expect(mockConsumeBranchPickerRequest).toHaveBeenCalledTimes(1);
    const issuesTab = query('home-branch-picker-tab-issues');
    expect(issuesTab?.getAttribute('aria-selected')).toBe('true');
    expect(issuesTab?.getAttribute('data-highlighted')).toBe('true');
  });

  /**
   * Remounts the picker with the Linear token read held pending, so the
   * component is in the genuinely-unsettled window a fresh mount hits right
   * when a staged request is made before availability settles.
   */
  function remountWithPendingLinearToken(): (token: string) => void {
    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    let resolveToken: (token: string) => void = () => undefined;
    mockLoadLinearToken.mockReset().mockReturnValue(
      new Promise<string>((resolve) => {
        resolveToken = resolve;
      }),
    );
    return resolveToken;
  }

  it('lands a staged Issues request optimistically while availability is loading', async () => {
    const resolveToken = remountWithPendingLinearToken();
    mockValidateLinearToken.mockReset().mockResolvedValue({
      authenticated: true,
      displayName: 'Ryan',
      error: null,
    });
    mockPendingBranchPickerRequest = { tab: 'issues', nonce: 1 };
    act(() => {
      root.render(createElement(HomeBranchPicker));
    });
    await flush();

    // Optimistic landing: Issues shown (the request only fires from
    // connected states), but no highlight until the grant.
    expect(mockConsumeBranchPickerRequest).toHaveBeenCalledTimes(1);
    expect(
      query('home-branch-picker-tab-issues')?.getAttribute('aria-selected'),
    ).toBe('true');

    await act(async () => {
      resolveToken('lin_api_connected');
      await Promise.resolve();
    });
    await flush();
    await flush();

    expect(
      query('home-branch-picker-tab-issues')?.getAttribute('data-highlighted'),
    ).toBe('true');
  });

  it('falls back to New when a deferred grant settles unavailable', async () => {
    const resolveToken = remountWithPendingLinearToken();
    mockPendingBranchPickerRequest = { tab: 'issues', nonce: 1 };
    act(() => {
      root.render(createElement(HomeBranchPicker));
    });
    await flush();
    expect(
      query('home-branch-picker-tab-issues')?.getAttribute('aria-selected'),
    ).toBe('true');

    // Empty token → settled unavailable: same outcome as an immediate
    // unavailable decision.
    await act(async () => {
      resolveToken('');
      await Promise.resolve();
    });
    await flush();

    expect(
      query('home-branch-picker-tab-new')?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('uses New for an already-open picker consuming an Issues request while Linear is unavailable', async () => {
    // Linear stays unavailable (beforeEach default: empty token).
    openPicker();
    mockPendingBranchPickerRequest = { tab: 'issues', nonce: 1 };
    act(() => {
      root.render(createElement(HomeBranchPicker));
    });
    await flush();

    expect(mockConsumeBranchPickerRequest).toHaveBeenCalledTimes(1);
    // Same grant rule as the fresh-open path: fall back to 'new', no
    // highlight.
    expect(
      query('home-branch-picker-tab-new')?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      query('home-branch-picker-tab-issues')?.getAttribute('data-highlighted'),
    ).toBeNull();
  });

  // Regression: the picker outlives the Settings overlay, so connecting Linear
  // there used to leave it serving its mount-time "no key" snapshot forever.
  it('drops the Linear connect row once a key is connected after mount', async () => {
    openPicker();
    clickTab('home-branch-picker-tab-issues');
    await flush();
    expect(query('home-branch-picker-issues-connect')).not.toBeNull();

    mockLoadLinearToken.mockResolvedValue('lin_api_connected');
    mockValidateLinearToken.mockResolvedValue({
      authenticated: true,
      displayName: 'Ryan',
      error: null,
    });
    act(() => {
      window.dispatchEvent(new Event(LINEAR_CONNECTION_CHANGED_EVENT));
    });
    await flush();
    await flush();

    expect(query('home-branch-picker-issues-connect')).toBeNull();
    expect(query('home-branch-picker-tab-issues')).not.toBeNull();
  });

  // Same class of staleness on the GitHub side: the PR list is fetched at most
  // once per workspace per picker lifetime, so a fetch that only failed for
  // lack of auth stayed failed for the whole session.
  it('refetches pull requests after GitHub is connected', async () => {
    mockListPullRequests.mockRejectedValue(new Error('Not Found'));
    mockLoadGitHubPat.mockResolvedValue('');
    mockGetGitHubCliStatus.mockResolvedValue({
      authenticated: false,
      username: null,
      error: null,
    });

    openPicker();
    clickTab('home-branch-picker-tab-prs');
    await flush();
    await flush();
    await flush();
    await flush();
    expect(query('home-branch-picker-pr-connect')).not.toBeNull();

    mockListPullRequests.mockResolvedValue({
      pullRequests: [
        {
          number: 12,
          title: 'Add the thing',
          headRefName: 'feat/thing',
          baseRefName: 'main',
          url: 'https://github.com/acme/app/pull/12',
          isCrossRepo: false,
        },
      ],
    });
    mockLoadGitHubPat.mockResolvedValue('ghp_connected');
    act(() => {
      window.dispatchEvent(new Event(GITHUB_CONNECTION_CHANGED_EVENT));
    });
    await flush();
    await flush();
    await flush();
    await flush();

    expect(query('home-branch-picker-pr-connect')).toBeNull();
    expect(query('home-branch-picker-pr-12')).not.toBeNull();
  });

  it('keeps the raw PR error when the gh CLI is authenticated', async () => {
    mockListPullRequests.mockRejectedValue(new Error('Not Found'));
    mockLoadGitHubPat.mockResolvedValue('');
    mockGetGitHubCliStatus.mockResolvedValue({
      authenticated: true,
      username: 'octocat',
      error: null,
    });

    openPicker();
    clickTab('home-branch-picker-tab-prs');
    await flush();
    await flush();
    await flush();
    await flush();

    expect(query('home-branch-picker-pr-error')?.textContent).toContain(
      'Not Found',
    );
    expect(query('home-branch-picker-pr-connect')).toBeNull();
  });

  describe('GitHub title search fallback', () => {
    function makePr(
      number: number,
      title: string,
      overrides: Partial<PullRequestSummary> = {},
    ): PullRequestSummary {
      return {
        number,
        title,
        headRefName: `feat/pr-${number}`,
        baseRefName: 'main',
        url: `https://github.com/acme/app/pull/${number}`,
        authorLogin: `author${number}`,
        isDraft: false,
        isCrossRepo: false,
        ...overrides,
      };
    }

    function deferred<T>(): {
      promise: Promise<T>;
      resolve: (value: T) => void;
      reject: (reason: unknown) => void;
    } {
      let resolve: (value: T) => void = () => undefined;
      let reject: (reason: unknown) => void = () => undefined;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    function advance(ms: number): void {
      act(() => {
        jest.advanceTimersByTime(ms);
      });
    }

    async function openPrsTab(): Promise<void> {
      openPicker();
      clickTab('home-branch-picker-tab-prs');
      await flush();
      await flush();
    }

    async function settleSearch(): Promise<void> {
      advance(300);
      await flush();
      await flush();
    }

    const FILLER = makePr(1, 'Recent filler work');

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
      mockListPullRequests.mockResolvedValue({ pullRequests: [FILLER] });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('searches GitHub after the debounce when no loaded PR matches and selects a result', async () => {
      const older = makePr(113, 'Older login rework', {
        headRefName: 'feat/older-login',
      });
      mockSearchPullRequests.mockResolvedValue({ pullRequests: [older] });
      await openPrsTab();

      typeSearch(searchInput(), 'login rework');
      // Loading shows from the first keystroke, never the empty state.
      expect(query('home-branch-picker-pr-search-loading')?.textContent).toBe(
        'Searching GitHub…',
      );
      expect(query('home-branch-picker-pr-empty')).toBeNull();
      advance(299);
      expect(mockSearchPullRequests).not.toHaveBeenCalled();
      await settleSearch();

      expect(mockSearchPullRequests).toHaveBeenCalledTimes(1);
      expect(mockSearchPullRequests).toHaveBeenCalledWith({
        repoPath: '/repos/ws-1',
        query: 'login rework',
      });
      expect(query('home-branch-picker-pr-search-loading')).toBeNull();
      const section = query('home-branch-picker-pr-search-results');
      expect(section?.textContent).toContain('From GitHub');
      const row = query<HTMLButtonElement>('home-branch-picker-pr-113');
      expect(section?.contains(row)).toBe(true);
      expect(row?.textContent).toContain('#113 · author113');
      expectReplayBlocksOnlyValue(document.body, 'author113');

      act(() => row?.click());
      expect(mockSetBranchTarget).toHaveBeenCalledWith({
        kind: 'pr',
        number: 113,
        title: 'Older login rework',
        headRefName: 'feat/older-login',
        url: 'https://github.com/acme/app/pull/113',
      });
    });

    it('searches when the loaded list is empty', async () => {
      mockListPullRequests.mockResolvedValue({ pullRequests: [] });
      mockSearchPullRequests.mockResolvedValue({
        pullRequests: [makePr(7, 'Stale cleanup')],
      });
      await openPrsTab();
      expect(query('home-branch-picker-pr-empty')?.textContent).toBe(
        'No open pull requests',
      );

      typeSearch(searchInput(), 'cleanup');
      await settleSearch();

      expect(mockSearchPullRequests).toHaveBeenCalledTimes(1);
      expect(query('home-branch-picker-pr-7')).not.toBeNull();
    });

    it('issues only the final request for rapid edits', async () => {
      await openPrsTab();
      typeSearch(searchInput(), 'lo');
      advance(100);
      typeSearch(searchInput(), 'log');
      advance(100);
      typeSearch(searchInput(), 'login');
      await settleSearch();

      expect(mockSearchPullRequests).toHaveBeenCalledTimes(1);
      expect(mockSearchPullRequests).toHaveBeenCalledWith({
        repoPath: '/repos/ws-1',
        query: 'login',
      });
    });

    it('does not search for local matches, references, or short input', async () => {
      await openPrsTab();

      typeSearch(searchInput(), 'filler');
      await settleSearch();
      expect(query('home-branch-picker-pr-1')).not.toBeNull();

      typeSearch(searchInput(), '#99');
      await settleSearch();
      expect(query('home-branch-picker-pr-resolve')).not.toBeNull();

      typeSearch(searchInput(), 'https://github.com/acme/app/pull/99');
      await settleSearch();

      typeSearch(searchInput(), 'z');
      await settleSearch();
      expect(query('home-branch-picker-pr-search-loading')).toBeNull();
      expect(query('home-branch-picker-pr-empty')?.textContent).toBe(
        'No open pull requests',
      );

      expect(mockSearchPullRequests).not.toHaveBeenCalled();
    });

    it('does not search while the list is loading or after it failed', async () => {
      const listing = deferred<{ pullRequests: PullRequestSummary[] }>();
      mockListPullRequests.mockReturnValue(listing.promise);
      openPicker();
      clickTab('home-branch-picker-tab-prs');
      typeSearch(searchInput(), 'login');
      await settleSearch();
      expect(query('home-branch-picker-pr-loading')).not.toBeNull();
      expect(mockSearchPullRequests).not.toHaveBeenCalled();

      await act(async () => {
        listing.reject(new Error('Not Found'));
        await listing.promise.catch(() => undefined);
      });
      await settleSearch();
      expect(query('home-branch-picker-pr-error')?.textContent).toContain(
        'Not Found',
      );
      expect(query('home-branch-picker-pr-search-loading')).toBeNull();
      expect(mockSearchPullRequests).not.toHaveBeenCalled();
    });

    it('clears obsolete results immediately and ignores a late response for an earlier query', async () => {
      const first = deferred<{ pullRequests: PullRequestSummary[] }>();
      mockSearchPullRequests
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce({ pullRequests: [makePr(20, 'Second match')] })
        .mockResolvedValueOnce({ pullRequests: [makePr(30, 'Third match')] });
      await openPrsTab();

      typeSearch(searchInput(), 'alpha');
      await settleSearch();
      typeSearch(searchInput(), 'beta');
      await settleSearch();
      expect(query('home-branch-picker-pr-20')).not.toBeNull();

      // A late response for the earlier query never renders.
      await act(async () => {
        first.resolve({ pullRequests: [makePr(10, 'Stale alpha')] });
        await first.promise;
      });
      expect(query('home-branch-picker-pr-10')).toBeNull();
      expect(query('home-branch-picker-pr-20')).not.toBeNull();

      // The previous results disappear as soon as the query changes.
      typeSearch(searchInput(), 'gamma');
      expect(query('home-branch-picker-pr-20')).toBeNull();
      expect(query('home-branch-picker-pr-search-loading')).not.toBeNull();
      expect(searchInput().getAttribute('aria-activedescendant')).toBeNull();
      await settleSearch();
      expect(query('home-branch-picker-pr-30')).not.toBeNull();

      // Clearing the input restores the normal list.
      typeSearch(searchInput(), '');
      expect(query('home-branch-picker-pr-30')).toBeNull();
      expect(query('home-branch-picker-pr-search-loading')).toBeNull();
      expect(query('home-branch-picker-pr-1')).not.toBeNull();
    });

    it('ignores a late response after the query returns to an earlier value', async () => {
      const first = deferred<{ pullRequests: PullRequestSummary[] }>();
      mockSearchPullRequests
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce({ pullRequests: [makePr(20, 'Fresh match')] });
      await openPrsTab();

      typeSearch(searchInput(), 'alpha');
      await settleSearch();
      typeSearch(searchInput(), 'alphab');
      typeSearch(searchInput(), 'alpha');
      await act(async () => {
        first.resolve({ pullRequests: [makePr(10, 'Stale alpha')] });
        await first.promise;
      });
      expect(query('home-branch-picker-pr-10')).toBeNull();
      expect(query('home-branch-picker-pr-search-loading')).not.toBeNull();

      await settleSearch();
      expect(mockSearchPullRequests).toHaveBeenCalledTimes(2);
      expect(query('home-branch-picker-pr-20')).not.toBeNull();
    });

    it('ignores late successes and failures after closing or a GitHub connection change', async () => {
      const beforeClose = deferred<{ pullRequests: PullRequestSummary[] }>();
      const beforeReconnect = deferred<{
        pullRequests: PullRequestSummary[];
      }>();
      mockSearchPullRequests
        .mockReturnValueOnce(beforeClose.promise)
        .mockReturnValueOnce(beforeReconnect.promise)
        .mockResolvedValue({ pullRequests: [] });
      await openPrsTab();

      typeSearch(searchInput(), 'alpha');
      await settleSearch();
      act(() => {
        query<HTMLButtonElement>('home-branch-picker-button')?.click();
      });
      await openPrsTab();
      typeSearch(searchInput(), 'alpha');
      await act(async () => {
        beforeClose.resolve({ pullRequests: [makePr(10, 'Stale alpha')] });
        await beforeClose.promise;
      });
      expect(query('home-branch-picker-pr-10')).toBeNull();
      expect(query('home-branch-picker-pr-search-loading')).not.toBeNull();

      await settleSearch();
      act(() => {
        window.dispatchEvent(new Event(GITHUB_CONNECTION_CHANGED_EVENT));
      });
      await act(async () => {
        beforeReconnect.reject(new Error('Bad credentials'));
        await beforeReconnect.promise.catch(() => undefined);
      });
      expect(query('home-branch-picker-pr-search-error')).toBeNull();
    });

    it('renders duplicates once and keeps a result that only the unfiltered list holds', async () => {
      mockListPullRequests.mockResolvedValue({
        pullRequests: [FILLER, makePr(5, 'Fix sign in')],
      });
      mockSearchPullRequests.mockResolvedValue({
        pullRequests: [
          makePr(5, 'Fix sign in'),
          makePr(77, 'Auth tokens'),
          makePr(77, 'Auth tokens'),
        ],
      });
      await openPrsTab();
      typeSearch(searchInput(), 'authentication');
      await settleSearch();

      expect(
        document.body.querySelectorAll(
          '[data-testid="home-branch-picker-pr-5"]',
        ),
      ).toHaveLength(1);
      expect(
        document.body.querySelectorAll(
          '[data-testid="home-branch-picker-pr-77"]',
        ),
      ).toHaveLength(1);
    });

    it('disables fork results, skips them with the keyboard, and commits with Enter', async () => {
      mockSearchPullRequests.mockResolvedValue({
        pullRequests: [
          makePr(80, 'Forked login', { isCrossRepo: true }),
          makePr(81, 'Login one'),
          makePr(82, 'Login two', { headRefName: 'feat/login-two' }),
        ],
      });
      await openPrsTab();
      const input = searchInput();
      typeSearch(input, 'login');
      await settleSearch();

      expect(
        query<HTMLButtonElement>('home-branch-picker-pr-80')?.disabled,
      ).toBe(true);
      expect(input.getAttribute('aria-activedescendant')).toBe(
        'home-branch-picker-option-pr:81',
      );
      pressKey(input, 'ArrowDown');
      expect(input.getAttribute('aria-activedescendant')).toBe(
        'home-branch-picker-option-pr:82',
      );
      pressKey(input, 'Enter');
      expect(mockSetBranchTarget).toHaveBeenCalledWith({
        kind: 'pr',
        number: 82,
        title: 'Login two',
        headRefName: 'feat/login-two',
        url: 'https://github.com/acme/app/pull/82',
      });
    });

    it('shows one matching-specific empty state, an error without it, and retries', async () => {
      mockSearchPullRequests
        .mockResolvedValueOnce({ pullRequests: [] })
        .mockRejectedValueOnce(
          new Error(
            "Error invoking remote method 'github:search-pull-requests': Error: API rate limit exceeded",
          ),
        )
        .mockResolvedValueOnce({ pullRequests: [makePr(9, 'Rate retry')] });
      await openPrsTab();

      typeSearch(searchInput(), 'nothing');
      await settleSearch();
      expect(query('home-branch-picker-pr-empty')?.textContent).toBe(
        'No matching open pull requests',
      );
      expect(query('home-branch-picker-pr-search-error')).toBeNull();

      typeSearch(searchInput(), 'retry');
      await settleSearch();
      expect(query('home-branch-picker-pr-search-error')?.textContent).toBe(
        'API rate limit exceeded',
      );
      expect(query('home-branch-picker-pr-empty')).toBeNull();
      expect(query('home-branch-picker-pr-search-loading')).toBeNull();

      typeSearch(searchInput(), 'retr');
      typeSearch(searchInput(), 'retry');
      await settleSearch();
      expect(query('home-branch-picker-pr-search-error')).toBeNull();
      expect(query('home-branch-picker-pr-9')).not.toBeNull();
    });

    it('rejects over-long input without a request', async () => {
      await openPrsTab();
      typeSearch(searchInput(), 'word '.repeat(25));
      await settleSearch();

      expect(mockSearchPullRequests).not.toHaveBeenCalled();
      expect(query('home-branch-picker-pr-search-error')?.textContent).toBe(
        'Shorten the pull request search to 100 characters or fewer.',
      );
      expect(query('home-branch-picker-pr-empty')).toBeNull();
    });

    it('clears results and restarts the debounce even for equivalent normalized input', async () => {
      mockSearchPullRequests.mockResolvedValue({
        pullRequests: [makePr(10, 'Login match')],
      });
      await openPrsTab();
      typeSearch(searchInput(), 'login');
      await settleSearch();
      expect(query('home-branch-picker-pr-10')).not.toBeNull();

      typeSearch(searchInput(), ' login ');
      expect(query('home-branch-picker-pr-10')).toBeNull();
      expect(query('home-branch-picker-pr-search-loading')).not.toBeNull();
      advance(299);
      expect(mockSearchPullRequests).toHaveBeenCalledTimes(1);
      advance(1);
      await flush();
      expect(mockSearchPullRequests).toHaveBeenCalledTimes(2);
      expect(query('home-branch-picker-pr-10')).not.toBeNull();
    });

    it.each(['success', 'failure'])(
      'ignores a late %s after a quote-only edit with equivalent tokens',
      async (outcome) => {
        const stale = deferred<{ pullRequests: PullRequestSummary[] }>();
        mockSearchPullRequests.mockReturnValueOnce(stale.promise);
        await openPrsTab();
        typeSearch(searchInput(), 'login');
        await settleSearch();
        typeSearch(searchInput(), '"login"');
        await act(async () => {
          if (outcome === 'success') {
            stale.resolve({ pullRequests: [makePr(10, 'Stale login')] });
          } else {
            stale.reject(new Error('Stale credentials'));
          }
          await stale.promise.catch(() => undefined);
        });
        expect(query('home-branch-picker-pr-10')).toBeNull();
        expect(query('home-branch-picker-pr-search-error')).toBeNull();
        expect(query('home-branch-picker-pr-search-loading')).not.toBeNull();
      },
    );

    it('reloads the initial list when the same workspace changes repository', async () => {
      mockListPullRequests
        .mockResolvedValueOnce({ pullRequests: [makePr(10, 'Login match')] })
        .mockResolvedValueOnce({ pullRequests: [FILLER] });
      await openPrsTab();
      typeSearch(searchInput(), 'login');
      await settleSearch();
      expect(mockSearchPullRequests).not.toHaveBeenCalled();

      mockProjectsState.projects = [{ ...WS1_PROJECT, repoPath: '/repos/new' }];
      act(() => root.render(createElement(HomeBranchPicker)));
      expect(query('home-branch-picker-pr-10')).toBeNull();
      await flush();
      await settleSearch();
      expect(mockListPullRequests).toHaveBeenLastCalledWith({
        repoPath: '/repos/new',
      });
      expect(mockSearchPullRequests).toHaveBeenCalledWith({
        repoPath: '/repos/new',
        query: 'login',
      });
    });

    it.each(['success', 'failure'])(
      'ignores an initial-list %s from the previous GitHub connection',
      async (outcome) => {
        const stale = deferred<{ pullRequests: PullRequestSummary[] }>();
        mockListPullRequests
          .mockReturnValueOnce(stale.promise)
          .mockResolvedValueOnce({ pullRequests: [FILLER] });
        await openPrsTab();
        act(() => {
          window.dispatchEvent(new Event(GITHUB_CONNECTION_CHANGED_EVENT));
        });
        await flush();
        expect(query('home-branch-picker-pr-1')).not.toBeNull();

        await act(async () => {
          if (outcome === 'success') {
            stale.resolve({ pullRequests: [makePr(10, 'Stale login')] });
          } else {
            stale.reject(new Error('Stale credentials'));
          }
          await stale.promise.catch(() => undefined);
        });
        expect(query('home-branch-picker-pr-1')).not.toBeNull();
        expect(query('home-branch-picker-pr-10')).toBeNull();
        expect(query('home-branch-picker-pr-error')).toBeNull();
        typeSearch(searchInput(), 'login');
        await settleSearch();
        expect(mockSearchPullRequests).toHaveBeenCalledTimes(1);
      },
    );

    it.each(
      [
        'tab',
        'workspace',
        'repository',
        'missing repository',
        'local match',
        'credentials',
        'unmount',
      ].flatMap((context) =>
        ['success', 'failure'].map((outcome) => ({ context, outcome })),
      ),
    )(
      'ignores late search $outcome after changing $context',
      async ({ context, outcome }) => {
        const pending = deferred<{ pullRequests: PullRequestSummary[] }>();
        mockSearchPullRequests.mockReturnValueOnce(pending.promise);
        await openPrsTab();
        typeSearch(searchInput(), 'alpha');
        await settleSearch();

        act(() => {
          if (context === 'tab') {
            query<HTMLButtonElement>(
              'home-branch-picker-tab-branches',
            )?.click();
          } else if (context === 'workspace') {
            mockProjectsState.projects = [WS1_PROJECT, WS2_PROJECT];
            mockComposerState.workspaceId = 'ws-2';
            root.render(createElement(HomeBranchPicker));
          } else if (
            context === 'repository' ||
            context === 'missing repository'
          ) {
            mockProjectsState.projects = [
              {
                ...WS1_PROJECT,
                repoPath: context === 'repository' ? '/repos/new' : null,
              },
            ];
            root.render(createElement(HomeBranchPicker));
          } else if (context === 'local match') {
            typeSearch(searchInput(), 'filler');
          } else if (context === 'credentials') {
            window.dispatchEvent(new Event(GITHUB_CONNECTION_CHANGED_EVENT));
          } else {
            root.render(null);
          }
        });
        await act(async () => {
          if (outcome === 'success') {
            pending.resolve({ pullRequests: [makePr(10, 'Stale alpha')] });
          } else {
            pending.reject(new Error('Stale search error'));
          }
          await pending.promise.catch(() => undefined);
        });
        expect(query('home-branch-picker-pr-10')).toBeNull();
        expect(query('home-branch-picker-pr-search-error')).toBeNull();
      },
    );

    it('keeps a disabled-only response nonempty and caps visible results at 20', async () => {
      mockSearchPullRequests
        .mockResolvedValueOnce({
          pullRequests: [makePr(80, 'Forked login', { isCrossRepo: true })],
        })
        .mockResolvedValueOnce({
          pullRequests: Array.from({ length: 25 }, (_, index) =>
            makePr(index + 100, 'Search result'),
          ),
        });
      await openPrsTab();
      typeSearch(searchInput(), 'login');
      await settleSearch();
      expect(query('home-branch-picker-pr-80')).not.toBeNull();
      expect(query('home-branch-picker-pr-empty')).toBeNull();
      expect(searchInput().getAttribute('aria-activedescendant')).toBeNull();

      typeSearch(searchInput(), 'results');
      await settleSearch();
      expect(
        query('home-branch-picker-pr-search-results')?.querySelectorAll(
          '[data-testid^="home-branch-picker-pr-"]',
        ),
      ).toHaveLength(20);
    });

    it('never searches for empty, tokenless, numeric or inactive input', async () => {
      await openPrsTab();
      for (const value of ['', ' ', '"" \\', '99']) {
        typeSearch(searchInput(), value);
        await settleSearch();
      }
      clickTab('home-branch-picker-tab-branches');
      typeSearch(searchInput(), 'login');
      await settleSearch();
      expect(mockSearchPullRequests).not.toHaveBeenCalled();
    });

    it.each(['close', 'unmount'])(
      'cancels a queued debounce on %s before any request is issued',
      async (context) => {
        await openPrsTab();
        typeSearch(searchInput(), 'login');
        advance(299);
        act(() => {
          if (context === 'close') {
            query<HTMLButtonElement>('home-branch-picker-button')?.click();
          } else {
            root.render(null);
          }
        });
        await settleSearch();
        expect(mockSearchPullRequests).not.toHaveBeenCalled();
      },
    );
  });
});

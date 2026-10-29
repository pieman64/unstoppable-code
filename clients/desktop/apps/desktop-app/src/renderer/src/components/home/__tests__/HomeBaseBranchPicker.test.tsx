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
import { HomeBaseBranchPicker } from '../HomeBaseBranchPicker';
import {
  expectReplayBlocksOnlyValue,
  outermostReplayBlock,
} from '@/test-utils/replay';
import type { HomeNewWorktreeBaseTarget } from '@/stores/homeComposerStore';
import type * as ExperimentalFeaturesModule from '@/stores/labsExperimentsStore';

let mockEarlyAccess = false;
jest.mock('@/stores/labsExperimentsStore', () => ({
  ...jest.requireActual<typeof ExperimentalFeaturesModule>(
    '@/stores/labsExperimentsStore',
  ),
  useLabsExperimentEnabled: (): boolean => mockEarlyAccess,
}));

const mockSetBaseTarget = jest.fn();
let mockBaseTarget: HomeNewWorktreeBaseTarget | null = {
  kind: 'branch',
  branchName: 'main',
  isRemote: false,
};
let mockProjectType: 'single-repo' | 'multi-repo' = 'single-repo';

const mockProject = {
  id: 'ws-1',
  name: 'Workspace',
  type: 'single-repo',
  repoPath: '/repos/ws-1',
  sourceRepoPath: '/repos/ws-1',
  color: '#888',
  collapsed: false,
  order: 0,
  repos: [],
  worktrees: [
    { id: 'wt-1', branchName: 'feature/one', createdAt: '2026-01-01' },
  ],
};

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown): unknown =>
    selector({ projects: [{ ...mockProject, type: mockProjectType }] }),
}));

jest.mock('@/stores/homeComposerStore', () => ({
  useHomeComposerStore: (selector: (state: unknown) => unknown): unknown =>
    selector({
      workspaceId: 'ws-1',
      branchTargets: {
        supported: true,
        defaultBranch: 'main',
        branches: [
          {
            name: 'main',
            isRemote: false,
            isCurrent: true,
            isUsedByWorktree: false,
            hasLocalRef: true,
            hasRemoteRef: true,
          },
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
      newWorktreeBaseTarget: mockBaseTarget,
      setNewWorktreeBaseTarget: mockSetBaseTarget,
    }),
}));

const mockListPullRequests = jest.fn();
Object.defineProperty(window, 'api', {
  configurable: true,
  value: { listPullRequests: mockListPullRequests },
});

describe('HomeBaseBranchPicker', () => {
  let container: HTMLDivElement;
  let root: Root;

  let pendingFrames: FrameRequestCallback[] = [];

  const query = <T extends Element>(testId: string): T | null =>
    document.body.querySelector<T>(`[data-testid="${testId}"]`);

  /** Runs queued animation frames until the picker stops scheduling more. */
  const flushFrames = (): void => {
    for (let pass = 0; pass < 10 && pendingFrames.length > 0; pass += 1) {
      const frames = pendingFrames;
      pendingFrames = [];
      act(() => frames.forEach((frame) => frame(0)));
    }
  };

  const openPicker = (): void => {
    act(() =>
      query<HTMLButtonElement>('home-base-branch-picker-button')?.click(),
    );
    flushFrames();
  };

  const selectTab = (tab: string): void => {
    act(() =>
      query<HTMLButtonElement>(`home-base-branch-picker-tab-${tab}`)?.click(),
    );
    flushFrames();
  };

  beforeEach(() => {
    mockEarlyAccess = false;
    pendingFrames = [];
    jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((frame: FrameRequestCallback): number => {
        pendingFrames.push(frame);
        return pendingFrames.length;
      });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      pendingFrames = [];
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockProjectType = 'single-repo';
    mockBaseTarget = {
      kind: 'branch',
      branchName: 'main',
      isRemote: false,
    };
    mockSetBaseTarget.mockClear();
    mockListPullRequests.mockReset().mockResolvedValue({ pullRequests: [] });
    act(() => root.render(createElement(HomeBaseBranchPicker)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.restoreAllMocks();
  });

  it('defers branch rows without a Labs opt-in', () => {
    act(() =>
      query<HTMLButtonElement>('home-base-branch-picker-button')?.click(),
    );

    expect(query('home-base-branch-picker-skeleton')).not.toBeNull();
    flushFrames();
    expect(query('home-base-branch-picker-branch-main-local')).not.toBeNull();
  });

  it('opens at once with skeleton rows, then swaps in the branch list', () => {
    mockEarlyAccess = true;
    act(() => root.render(createElement(HomeBaseBranchPicker)));
    act(() =>
      query<HTMLButtonElement>('home-base-branch-picker-button')?.click(),
    );

    expect(query('home-base-branch-picker-menu')).not.toBeNull();
    expect(query('home-base-branch-picker-skeleton')).not.toBeNull();
    expect(query('home-base-branch-picker-branch-main-local')).toBeNull();

    flushFrames();

    expect(query('home-base-branch-picker-skeleton')).toBeNull();
    expect(query('home-base-branch-picker-branch-main-local')).not.toBeNull();
  });

  it('shows skeleton rows while switching to a tab', () => {
    mockEarlyAccess = true;
    act(() => root.render(createElement(HomeBaseBranchPicker)));
    openPicker();
    act(() =>
      query<HTMLButtonElement>(
        'home-base-branch-picker-tab-worktrees',
      )?.click(),
    );

    expect(query('home-base-branch-picker-skeleton')).not.toBeNull();
    expect(query('home-base-branch-picker-worktree-wt-1')).toBeNull();

    flushFrames();

    expect(query('home-base-branch-picker-worktree-wt-1')).not.toBeNull();
  });

  it('defaults to the selected branch and offers only Worktrees, PRs, and Branches', () => {
    expect(query('home-base-branch-picker-button')?.textContent).toContain(
      'main',
    );
    openPicker();

    expect(
      query('home-base-branch-picker-tab-branches')?.getAttribute(
        'aria-selected',
      ),
    ).toBe('true');
    expect(
      Array.from(document.body.querySelectorAll('[role="tab"]')).map(
        (tab) => tab.textContent,
      ),
    ).toEqual(['Worktrees', 'PRs', 'Branches']);
    expect(query('home-base-branch-picker-tab-issues')).toBeNull();
    expect(query('home-base-branch-picker-new-worktree')).toBeNull();
    expect(query('home-base-branch-picker-branch-main-local')).not.toBeNull();
    expect(
      query('home-base-branch-picker-branch-release')?.querySelector(
        '.canopy-picker-menu-option-trailing[aria-label="Remote branch"]',
      ),
    ).not.toBeNull();
    expect(
      query('home-base-branch-picker-branch-release')
        ?.querySelector('.canopy-picker-menu-option-trailing')
        ?.className.split(/\s+/),
    ).toEqual(expect.arrayContaining(['fg-quaternary', 'hover:fg-secondary']));
    expect(
      query('home-base-branch-picker-remote-badge-release'),
    ).not.toBeNull();
    expect(
      query('home-base-branch-picker-branch-main-local')?.querySelector(
        '.canopy-picker-menu-option-trailing',
      ),
    ).toBeNull();
  });

  it('records the portaled picker, which lists PR titles', () => {
    act(() =>
      query<HTMLButtonElement>('home-base-branch-picker-button')?.click(),
    );

    const menu = query('home-base-branch-picker-menu');
    expect(menu?.getAttribute('role')).toBe('dialog');
    expect(container.contains(menu)).toBe(false);
    expect(menu?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
  });

  it('marks a coalesced branch row selected when its remote ref is the default base', () => {
    mockBaseTarget = { kind: 'branch', branchName: 'main', isRemote: true };
    act(() => root.render(createElement(HomeBaseBranchPicker)));
    openPicker();

    const remote = query<HTMLButtonElement>(
      'home-base-branch-picker-branch-main-remote',
    );
    expect(remote?.getAttribute('aria-selected')).toBe('true');
    expect(
      query('home-base-branch-picker-branch-main-local')?.getAttribute(
        'aria-selected',
      ),
    ).toBe('false');
    act(() => remote?.click());
    expect(mockSetBaseTarget).toHaveBeenCalledWith({
      kind: 'branch',
      branchName: 'main',
      isRemote: true,
    });
  });

  it('commits the remote ref from the keyboard on a coalesced branch', () => {
    mockBaseTarget = { kind: 'branch', branchName: 'main', isRemote: true };
    act(() => root.render(createElement(HomeBaseBranchPicker)));
    openPicker();

    const search = query<HTMLInputElement>('home-base-branch-picker-search');
    act(() => {
      search?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    act(() => {
      search?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    expect(mockSetBaseTarget).toHaveBeenCalledWith({
      kind: 'branch',
      branchName: 'main',
      isRemote: true,
    });
  });

  it('opens on the PRs tab when the current base is a pull request', () => {
    mockBaseTarget = {
      kind: 'pr',
      number: 42,
      title: 'Release',
      headRefName: 'release/pr-42',
      url: 'https://github.test/example/repo/pull/42',
    };
    act(() => root.render(createElement(HomeBaseBranchPicker)));
    openPicker();

    expect(
      query('home-base-branch-picker-tab-prs')?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('selects an existing worktree as the creation base', () => {
    openPicker();
    selectTab('worktrees');
    act(() =>
      query<HTMLButtonElement>(
        'home-base-branch-picker-worktree-wt-1',
      )?.click(),
    );

    expect(mockSetBaseTarget).toHaveBeenCalledWith({
      kind: 'worktree',
      worktreeId: 'wt-1',
    });
  });

  it('distinguishes branch and pull request targets with their icons', () => {
    expect(
      query('home-base-branch-picker-selected-icon-branch'),
    ).not.toBeNull();

    openPicker();
    expect(
      query('home-base-branch-picker-option-icon-branch-main'),
    ).not.toBeNull();

    mockBaseTarget = {
      kind: 'pr',
      number: 42,
      title: 'Release',
      headRefName: 'release/pr-42',
      url: 'https://github.test/example/repo/pull/42',
    };
    act(() => root.render(createElement(HomeBaseBranchPicker)));
    expect(query('home-base-branch-picker-selected-icon-pr')).not.toBeNull();
  });

  it('does not reopen the tooltip when selection restores trigger focus', () => {
    openPicker();
    act(() =>
      query<HTMLButtonElement>(
        'home-base-branch-picker-branch-release',
      )?.click(),
    );

    expect(query('home-base-branch-picker-tooltip')).toBeNull();
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'home-base-branch-picker-button',
    );
  });

  it('shows an inverse-tone base branch tip matching shared tooltip type', () => {
    const trigger = query<HTMLButtonElement>('home-base-branch-picker-button');
    expect(trigger).not.toBeNull();

    act(() => {
      trigger?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const tip = query('home-base-branch-picker-tooltip');
    expect(tip).not.toBeNull();
    expect(tip?.className).toContain('bg-tooltip-inverse');
    expect(tip?.className).toContain('w-max');
    expect(tip?.className).toContain('max-w-48');
    expect(tip?.className).toContain('px-2');
    expect(tip?.className).toContain('py-1.5');
    expect(tip?.className).not.toContain('min-w-45');
    const paragraphs = tip?.querySelectorAll('p');
    expect(paragraphs?.[0]?.className).toContain('text-xs');
    expect(paragraphs?.[1]?.className).toContain('text-2xs');
    expect(tip?.textContent).toContain('Base branch');
    expect(tip?.textContent).toContain(
      'Branch, worktree, or pull request to create the new worktree from.',
    );
  });

  it.each([
    {
      earlyAccess: false,
      loading: {
        role: 'status',
        text: 'Loading pull requests',
        skeleton: true,
      },
    },
    {
      earlyAccess: true,
      loading: {
        role: 'status',
        text: 'Loading pull requests',
        skeleton: true,
      },
    },
  ])(
    'loads pull requests when the PRs tab is opened (early access $earlyAccess)',
    async ({ earlyAccess, loading }) => {
      mockEarlyAccess = earlyAccess;
      act(() => root.render(createElement(HomeBaseBranchPicker)));
      const response = {
        pullRequests: [
          {
            number: 42,
            title: 'Use the release base',
            authorLogin: 'octocat',
            headRefName: 'release/pr-42',
            url: 'https://github.test/example/repo/pull/42',
            isCrossRepo: false,
          },
        ],
      };
      let resolvePullRequests: (value: typeof response) => void = () =>
        undefined;
      mockListPullRequests.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePullRequests = resolve;
          }),
      );

      openPicker();
      await act(async () => {
        query<HTMLButtonElement>('home-base-branch-picker-tab-prs')?.click();
        await Promise.resolve();
      });
      flushFrames();

      const skeleton = query('home-base-branch-picker-skeleton');
      expect(skeleton !== null).toBe(loading.skeleton);
      expect(skeleton?.getAttribute('role') ?? null).toBe(loading.role);
      expect(query('home-base-branch-picker-list')?.textContent).toBe(
        loading.text,
      );

      await act(async () => {
        resolvePullRequests(response);
        await Promise.resolve();
      });

      expect(mockListPullRequests).toHaveBeenCalledWith({
        repoPath: '/repos/ws-1',
      });
      expect(query('home-base-branch-picker-pr-42')).not.toBeNull();
      // Session replay blocks the author login, not the clickable row.
      expectReplayBlocksOnlyValue(document.body, 'octocat');
      expect(
        outermostReplayBlock(query('home-base-branch-picker-pr-42')),
      ).toBeNull();
      act(() =>
        query<HTMLButtonElement>('home-base-branch-picker-pr-42')?.click(),
      );
      expect(mockSetBaseTarget).toHaveBeenCalledWith({
        kind: 'pr',
        number: 42,
        title: 'Use the release base',
        headRefName: 'release/pr-42',
        url: 'https://github.test/example/repo/pull/42',
      });
    },
  );

  it('does not render for a multi-repo project', () => {
    mockProjectType = 'multi-repo';
    act(() => root.render(createElement(HomeBaseBranchPicker)));
    expect(query('home-base-branch-picker')).toBeNull();
  });
});

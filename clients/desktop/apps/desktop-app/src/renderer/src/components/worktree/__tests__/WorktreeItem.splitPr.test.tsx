/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FormatIndentIncreaseIcon,
  FormatIndentDecreaseIcon,
  GitMergeIcon,
  WorktreeIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatTab } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';
import type {
  PrStatusData,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { ContextMenuPlacementProvider } from '@canopy/ui-shared/components';
import { WorktreeItem } from '../WorktreeItem';
import { useCodeGraphBuildStore } from '@/stores/codeGraphBuildStore';
import { useGitHubStore, worktreeKey } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useScriptsStore } from '@/stores/scriptsStore';
import { useActivityStore } from '@/stores/activityStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import { requestWorktreeArchiveConfirmation } from '@/lib/worktreeArchiveConfirmationEvents';
import {
  __resetSplitPrPreferencesForTests,
  useSplitPrPreferencesStore,
} from '@/hooks/useSplitPrPreferences';

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const KEY = worktreeKey(PROJECT_ID, WORKTREE_ID);

function makePrStatus(overrides: Partial<PrStatusData> = {}): PrStatusData {
  return {
    prNumber: 42,
    prUrl: 'https://github.com/example/repo/pull/42',
    state: 'open',
    title: 'A very large PR',
    checkStatus: 'passing',
    checkDetails: [],
    reviewStatus: 'none',
    reviewers: [],
    hasConflicts: false,
    commentCount: 0,
    updatedAt: '2026-07-01T00:00:00.000Z',
    additions: 600,
    deletions: 100,
    ...overrides,
  };
}

function makeWorktreePrStatus(status: PrStatusData): WorktreePrStatus {
  return {
    repos: [{ repoId: 'repo-1', repoName: 'repo', status }],
    lastCheckedAt: '2026-07-01T00:00:00.000Z',
  };
}

function makeWorktree(overrides: Partial<WorktreeData> = {}): WorktreeData {
  return {
    id: WORKTREE_ID,
    branchName: 'feature/big-change',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeChatTab(id: string, overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    ...overrides,
  };
}

function setGatingPrefs(enabled: boolean, thresholdLines: number): void {
  useSplitPrPreferencesStore.setState({
    splitPrEnabled: enabled,
    splitPrThresholdLines: thresholdLines,
    hasLoaded: true,
  });
}

function setDesktopPrSplitFlag(enabled: boolean): void {
  useFeatureFlagsStore.getState().setSnapshot({
    ...getDefaultFeatureFlagSnapshot(),
    values: {
      ...getDefaultFeatureFlagSnapshot().values,
      [CLIENT_FEATURE_FLAGS.canopyDesktopPrSplit.key]: enabled,
    },
  });
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  __resetSplitPrPreferencesForTests();
  useFeatureFlagsStore.setState({ snapshot: getDefaultFeatureFlagSnapshot() });
  useGitHubStore.setState({
    prStatuses: {},
    mergingPr: new Set<string>(),
    planningSplitPr: new Set<string>(),
    splittingPr: new Set<string>(),
    splitLockedWorktrees: new Set<string>(),
  });
  useProjectsStore.setState({
    // The destructive action's Archive-vs-Delete framing resolves the owning
    // workspace's archive retention from the projects list; seed the project
    // (retention unset → code-workspace default ON) so the menu keeps the
    // Archive framing these tests assert.
    projects: [
      {
        id: PROJECT_ID,
        type: 'single-repo',
        name: 'test-project',
        repoPath: '/tmp/repo',
        color: '#000000',
        order: 0,
        collapsed: false,
        worktrees: [],
        scripts: {},
        effectiveScripts: {},
        hooks: {},
        effectiveHooks: {},
      },
    ],
    diffStats: {},
    uncommittedChanges: {},
    hasUnpushedCommits: {},
  });
  usePipelineRunsStore.setState({
    runningExecutionsByWorktree: {},
    pausedExecutionsByWorktree: {},
  });
  useScriptsStore.setState({ runs: {} });
  useChatStore.setState({
    worktreeChats: {},
  });
  useActivityStore.setState({ splitPreflight: null });
  useCodeGraphBuildStore.setState({ building: {} });
  useCurrentUiStateStore.setState({ slices: {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  jest.clearAllMocks();
});

interface RenderOptions {
  branchGroupingMenu?: ComponentProps<
    typeof WorktreeItem
  >['branchGroupingMenu'];
  isMultiRepo?: boolean;
  isArchiveInProgress?: boolean;
  isRunningRun?: boolean;
  worktree?: Partial<WorktreeData>;
  onArchive?: (
    worktreeId: string,
    options?: { deleteBranch?: boolean; lockAfterArchive?: boolean },
  ) => void;
  onCreateBranchWorktree?: (worktreeId: string) => void;
  onToggleHidden?: (worktreeId: string, nextHidden: boolean) => void;
}

async function render(options: RenderOptions = {}): Promise<void> {
  await act(async () => {
    root.render(
      <WorktreeItem
        worktree={makeWorktree(options.worktree)}
        projectId={PROJECT_ID}
        isSelected={false}
        isStreaming={false}
        hasActiveSession={false}
        awaitingApproval={false}
        hasUnread={false}
        isDiscovering={false}
        isRunningSetup={false}
        isRunningRun={options.isRunningRun ?? false}
        isTearingDown={false}
        isArchiveInProgress={options.isArchiveInProgress ?? false}
        isMultiRepo={options.isMultiRepo ?? false}
        onSelect={() => undefined}
        onArchive={options.onArchive ?? ((): void => undefined)}
        onCreateBranchWorktree={options.onCreateBranchWorktree}
        onToggleHidden={options.onToggleHidden}
        branchGroupingMenu={options.branchGroupingMenu}
      />,
    );
    await Promise.resolve();
  });
}

function query(testId: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function requireElement(testId: string): HTMLElement {
  const element = query(testId);
  if (!element) {
    throw new Error(`Expected element with data-testid="${testId}"`);
  }
  return element;
}

function requireTestId(element: HTMLElement): string {
  const testId = element.getAttribute('data-testid');
  if (!testId) {
    throw new Error('Expected menu item to have a data-testid');
  }
  return testId;
}

async function openActionsMenu(): Promise<void> {
  const trigger = requireElement('worktree-actions-menu-button');
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('fallback worktree menu grouping icons', () => {
  it.each([
    ['group-with-base', 'Stack on base', FormatIndentIncreaseIcon],
    ['ungroup-from-base', 'Unstack from base', FormatIndentDecreaseIcon],
    ['group-children', 'Stack children', GitMergeIcon],
    ['ungroup-children', 'Unstack children', WorktreeIcon],
  ] as const)('uses the shared glyph for %s', async (kind, label, Icon) => {
    const onSelect = jest.fn();
    const descriptor = { kind, label, testId: 'grouping-action', onSelect };
    await render({ branchGroupingMenu: descriptor });
    await openActionsMenu();
    const item = requireElement('grouping-action');
    const expected = document.createElement('div');
    expected.innerHTML = renderToStaticMarkup(<Icon />);
    expect(item.querySelector('svg')?.innerHTML).toBe(
      expected.querySelector('svg')?.innerHTML,
    );
    expect(item.textContent).toBe(label);
    act(() => item.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

function setRunningLaunchScript(): void {
  useScriptsStore.setState({
    runs: {
      [`${PROJECT_ID}/${WORKTREE_ID}`]: {
        'worktree:launch': {
          label: 'Launch',
          scriptName: 'launch',
          lifecycle: 'launch',
          command: 'npm run dev',
          target: 'project',
          status: 'running',
          outputLines: [],
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          startedAt: 100,
          devServerHits: [],
        },
      },
    },
  });
}

describe('WorktreeItem running status', () => {
  it('folds the worktree id into the shimmer stop-launch control', async () => {
    setRunningLaunchScript();

    await render({ isRunningRun: true });

    const stopLaunchButton = requireElement('worktree-row-stop-launch');
    // The animal name shares the control's click surface and its sky/destructive
    // color states, so hovering the name shows the stop affordance too.
    expect(stopLaunchButton.textContent).toContain(WORKTREE_ID);
    expect(stopLaunchButton.getAttribute('aria-label')).toBe(
      'Stop launch script',
    );
    expect(stopLaunchButton.classList.contains('fg-info')).toBe(false);
    expect(stopLaunchButton.classList.contains('hover:fg-destructive')).toBe(
      true,
    );
    // The control aligns with the neighboring subtitle text/icons: a 16px
    // box bottom-aligned to the line box, not a baseline-drifting
    // align-middle.
    expect(stopLaunchButton.classList.contains('h-4')).toBe(true);
    expect(stopLaunchButton.classList.contains('align-bottom')).toBe(true);
    expect(stopLaunchButton.classList.contains('align-middle')).toBe(false);
    // Only one stop control renders: the icon-only rail variant is suppressed.
    expect(
      document.body.querySelectorAll('button[aria-label="Stop launch script"]')
        .length,
    ).toBe(1);
  });

  it('keeps the stop-launch icon box the same size in both hover states', async () => {
    setRunningLaunchScript();

    await render({ isRunningRun: true });

    // The spinner and the hover-revealed stop glyph must occupy an identical
    // box, otherwise the control resizes as the pointer enters it.
    const button = requireElement('worktree-row-stop-launch');
    const spinnerBox = button.querySelector('.canopy-text-shimmer');
    expect(spinnerBox).not.toBeNull();
    const glyphBox = button.querySelector('[data-glyph="stop"]')?.parentElement;
    expect(button.classList.contains('h-4')).toBe(true);
    // Both faces sit flex-centered against the neighboring 12px subtitle
    // icons — no baseline translate hacks on either.
    expect(spinnerBox?.classList.contains('-translate-y-0.5')).toBe(false);
    expect(glyphBox).toBeUndefined();
  });

  it('uses shimmer for a running launch script', async () => {
    setRunningLaunchScript();

    await render({ isRunningRun: true });

    const stopLaunchButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop launch script"]',
    );
    expect(stopLaunchButton).not.toBeNull();
    expect(stopLaunchButton?.classList.contains('fg-info')).toBe(false);
  });

  it('uses the merged status color while a pull request merge is running', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(makePrStatus({ checkStatus: 'passing' })),
      },
      mergingPr: new Set([KEY]),
    });

    await render({});

    const mergeSpinner = query('worktree-row-pr-merging');
    expect(mergeSpinner).not.toBeNull();
    expect(mergeSpinner?.classList.contains('fg-purple')).toBe(true);
    expect(mergeSpinner?.classList.contains('text-purple-400')).toBe(false);
  });
});

describe('WorktreeItem action menu parity', () => {
  it('defaults standalone callers to the classic project layout', async () => {
    await render();

    expect(query('worktree-row')?.dataset.worktreeLayout).toBe('classic');
  });

  it('reveals completed-row actions only on hover or focus', async () => {
    await render({
      worktree: { status: 'done' },
    });
    {
      for (const testId of [
        'worktree-archive-button',
        'worktree-actions-menu-button',
      ]) {
        const button = requireElement(testId);
        expect(button.classList.contains('opacity-0')).toBe(true);
        expect(
          button.classList.contains('group-hover/sidebar-item:opacity-100'),
        ).toBe(true);
        expect(
          button.classList.contains(
            'group-focus-within/sidebar-item:opacity-100',
          ),
        ).toBe(true);
      }
    }
  });

  it('reveals hidden completed-row actions only on hover or focus', async () => {
    await render({
      worktree: { hidden: true, status: 'done' },
      onToggleHidden: () => undefined,
    });
    {
      for (const testId of [
        'worktree-show-button',
        'worktree-archive-button',
        'worktree-actions-menu-button',
      ]) {
        const button = requireElement(testId);
        expect(button.classList.contains('opacity-0')).toBe(true);
        expect(
          button.classList.contains('group-hover/sidebar-item:opacity-100'),
        ).toBe(true);
        expect(
          button.classList.contains(
            'group-focus-within/sidebar-item:opacity-100',
          ),
        ).toBe(true);
      }
    }
  });

  it('keeps the same action menu after a pull request is merged', async () => {
    const onCreateBranchWorktree = jest.fn();
    await render({ onCreateBranchWorktree });
    await openActionsMenu();

    const activeMenuItems = Array.from(
      document.body.querySelectorAll<HTMLElement>(
        '[data-testid="worktree-actions-menu"] [role="menuitem"]',
      ),
      requireTestId,
    );

    await act(async () => {
      requireElement('worktree-actions-menu-button').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      useGitHubStore.setState({
        prStatuses: {
          [KEY]: makeWorktreePrStatus(
            makePrStatus({
              state: 'merged',
              mergedAt: '2026-07-02T00:00:00.000Z',
            }),
          ),
        },
      });
      await Promise.resolve();
    });

    await render({
      worktree: { status: 'done' },
      onCreateBranchWorktree,
    });
    await openActionsMenu();

    const mergedMenuItems = Array.from(
      document.body.querySelectorAll<HTMLElement>(
        '[data-testid="worktree-actions-menu"] [role="menuitem"]',
      ),
      requireTestId,
    );
    expect(mergedMenuItems).toEqual(activeMenuItems);
  });
});

describe('WorktreeItem action menu recipe', () => {
  function menuRows(): HTMLElement[] {
    return Array.from(
      document.body.querySelectorAll<HTMLElement>(
        '[data-testid="worktree-actions-menu"] [role="menuitem"]',
      ),
    );
  }

  it('leads every row with an icon and keeps Archive and Delete in their own last group', async () => {
    await render({
      onCreateBranchWorktree: jest.fn(),
      onToggleHidden: jest.fn(),
    });
    await openActionsMenu();
    const rows = menuRows();
    expect(rows.map(requireTestId)).toEqual([
      'worktree-actions-menu-toggle-pin',
      'worktree-actions-menu-set-label',
      'worktree-actions-menu-info',
      'worktree-actions-menu-create-branch',
      'worktree-actions-menu-toggle-hidden',
      'worktree-actions-menu-archive',
      'worktree-actions-menu-delete',
    ]);
    for (const row of rows) {
      expect(row.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
    }
    for (const testId of [
      'worktree-actions-menu-toggle-hidden',
      'worktree-actions-menu-archive',
    ]) {
      expect(
        requireElement(testId).previousElementSibling?.getAttribute('role'),
      ).toBe('separator');
    }
    expect(
      requireElement(
        'worktree-actions-menu-delete',
      ).previousElementSibling?.getAttribute('data-testid'),
    ).toBe('worktree-actions-menu-archive');
  });

  it('folds the rare rows into More under early access, as the sidebar menu does', async () => {
    await act(async () => {
      root.render(
        <ContextMenuPlacementProvider value="cursor">
          <WorktreeItem
            worktree={makeWorktree()}
            projectId={PROJECT_ID}
            isSelected={false}
            isStreaming={false}
            hasActiveSession={false}
            awaitingApproval={false}
            hasUnread={false}
            isDiscovering={false}
            isRunningSetup={false}
            isRunningRun={false}
            isTearingDown={false}
            isArchiveInProgress={false}
            isMultiRepo={false}
            onSelect={() => undefined}
            onArchive={(): void => undefined}
            onCreateBranchWorktree={jest.fn()}
            onToggleHidden={jest.fn()}
          />
        </ContextMenuPlacementProvider>,
      );
      await Promise.resolve();
    });
    await openActionsMenu();
    const menu = requireElement('worktree-actions-menu');
    const more = requireElement('worktree-actions-menu-more');
    expect(menu.contains(more)).toBe(true);
    expect(more.textContent).toContain('More');
    // Rename leads with a pencil; the rare rows sit behind More.
    expect(requireElement('worktree-actions-menu-set-label').textContent).toBe(
      'Rename',
    );
    expect(query('worktree-actions-menu-info')).toBeNull();
    expect(query('worktree-actions-menu-create-branch')).toBeNull();
    expect(query('worktree-actions-menu-toggle-hidden')).toBeNull();
    expect(
      requireElement(
        'worktree-actions-menu-archive',
      ).previousElementSibling?.getAttribute('role'),
    ).toBe('separator');
  });

  it('runs a row picked inside More with the pointer', async () => {
    const onCreateBranchWorktree = jest.fn();
    await act(async () => {
      root.render(
        <ContextMenuPlacementProvider value="cursor">
          <WorktreeItem
            worktree={makeWorktree()}
            projectId={PROJECT_ID}
            isSelected={false}
            isStreaming={false}
            hasActiveSession={false}
            awaitingApproval={false}
            hasUnread={false}
            isDiscovering={false}
            isRunningSetup={false}
            isRunningRun={false}
            isTearingDown={false}
            isArchiveInProgress={false}
            isMultiRepo={false}
            onSelect={() => undefined}
            onArchive={(): void => undefined}
            onCreateBranchWorktree={onCreateBranchWorktree}
            onToggleHidden={jest.fn()}
          />
        </ContextMenuPlacementProvider>,
      );
      await Promise.resolve();
    });
    await openActionsMenu();
    await act(async () => {
      requireElement('worktree-actions-menu-more').click();
      await Promise.resolve();
    });
    // The submenu is its own floating layer outside the root menu; a press
    // inside it must not read as an outside press that closes the menu.
    const row = requireElement('worktree-actions-menu-create-branch');
    await act(async () => {
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      row.click();
      await Promise.resolve();
    });
    expect(onCreateBranchWorktree).toHaveBeenCalledTimes(1);
  });
});

describe('WorktreeItem Split PR menu item gating', () => {
  it('hides the menu item when the worktree is below the eligibility threshold', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 100, deletions: 50 }),
        ),
      },
    });

    await render();
    await openActionsMenu();

    expect(query('worktree-actions-menu-split-pr')).toBeNull();
  });

  it('renders the menu item enabled with the Split PR icon when ready', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });

    await render();
    await openActionsMenu();

    const item = query('worktree-actions-menu-split-pr');
    expect(item).not.toBeNull();
    expect(item?.hasAttribute('disabled')).toBe(false);
    expect(item?.querySelector('svg')).not.toBeNull();
  });

  it('hides the menu item when the desktop PR Split flag is off', async () => {
    setGatingPrefs(true, 500);
    setDesktopPrSplitFlag(false);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });

    await render();
    await openActionsMenu();

    expect(query('worktree-actions-menu-split-pr')).toBeNull();
  });

  it('renders the menu item disabled with a tooltip listing every blocker when eligible but blocked', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });
    useProjectsStore.setState({
      uncommittedChanges: { [KEY]: true },
      hasUnpushedCommits: { [KEY]: true },
    });

    await render();
    await openActionsMenu();

    const item = query('worktree-actions-menu-split-pr');
    expect(item).not.toBeNull();
    expect(item?.hasAttribute('disabled')).toBe(true);
    expect(item?.querySelector('svg')).not.toBeNull();

    await act(async () => {
      // React synthesizes onMouseEnter from the native `mouseover` event.
      item?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await Promise.resolve();
    });

    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toContain(
      'Commit or discard local changes first',
    );
    expect(tooltip?.textContent).toContain('Push local commits first');
  });

  it('disables the menu item while a pipeline is active for the worktree', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });
    usePipelineRunsStore.setState({
      runningExecutionsByWorktree: { [KEY]: new Set(['exec-1']) },
    });

    await render();
    await openActionsMenu();

    const item = query('worktree-actions-menu-split-pr');
    expect(item?.hasAttribute('disabled')).toBe(true);
  });

  it('opens the split pre-flight modal target instead of planning directly when clicked', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });

    await render();
    await openActionsMenu();

    const item = query('worktree-actions-menu-split-pr');
    expect(item).not.toBeNull();
    await act(async () => {
      item?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(useActivityStore.getState().splitPreflight).toEqual({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(useGitHubStore.getState().planningSplitPr.has(KEY)).toBe(false);
  });

  it('disables the menu item while a chat tab is actively streaming for the worktree', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [makeChatTab('chat-1', { status: 'streaming' })],
          activeTabId: 'chat-1',
        },
      },
    });

    await render();
    await openActionsMenu();

    const item = query('worktree-actions-menu-split-pr');
    expect(item?.hasAttribute('disabled')).toBe(true);
  });

  it('disables the Split PR menu item with a lock tooltip while the worktree is split-locked', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitLockedWorktrees: new Set<string>([KEY]),
    });

    await render();
    await openActionsMenu();

    const item = query('worktree-actions-menu-split-pr');
    expect(item).not.toBeNull();
    expect(item?.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      item?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await Promise.resolve();
    });
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toContain('A Split PR is already in progress');
  });
});

describe('WorktreeItem graph-build badge', () => {
  it('renders the graph-build badge when the store marks this worktree as building', async () => {
    useCodeGraphBuildStore.setState({ building: { [KEY]: true } });

    await render();

    expect(query('worktree-row-graph-badge')).not.toBeNull();
  });

  it('does not render the graph-build badge when the store has no entry for this worktree', async () => {
    await render();

    expect(query('worktree-row-graph-badge')).toBeNull();
  });

  it('does not render the graph-build badge for a different worktree key', async () => {
    useCodeGraphBuildStore.setState({
      building: { [worktreeKey(PROJECT_ID, 'other-wt')]: true },
    });

    await render();

    expect(query('worktree-row-graph-badge')).toBeNull();
  });
});

describe('WorktreeItem Delete gating while split-locked', () => {
  it('disables the Delete menu item with a lock title while split-locked', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      splitLockedWorktrees: new Set<string>([KEY]),
    });

    await render({ worktree: { status: 'done' } });
    await openActionsMenu();

    const deleteItem = query('worktree-actions-menu-archive');
    expect(deleteItem).not.toBeNull();
    expect(deleteItem?.hasAttribute('disabled')).toBe(true);
    expect(deleteItem?.getAttribute('title')).toContain(
      'A Split PR is in progress',
    );
    expect(deleteItem?.textContent).toContain('Archive');
    // The hover rail hides the archive chip entirely while removal cannot
    // run — the disabled explanation lives on the menu item above.
    expect(query('worktree-archive-button')).toBeNull();
  });

  it('opens the actions menu on right-click, matching the ••• button', async () => {
    await render();
    const row = requireElement('worktree-row');
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 300,
          clientY: 200,
        }),
      );
      await Promise.resolve();
    });
    expect(query('worktree-actions-menu-archive')).not.toBeNull();
    // The row's hover action chips stay hover-gated while the menu is open —
    // they must not pin visible over the title (the sidebar surface is inert
    // during an open menu, so hover cannot reveal them).
    const menuTrigger = requireElement('worktree-actions-menu-button');
    expect(menuTrigger.className).toContain('opacity-0');
    // The menu opens AT the right-click point (top just below the cursor,
    // right edge at the cursor), not at the ••• button.
    const surface = document.querySelector<HTMLElement>(
      '[data-testid="worktree-actions-menu"]',
    );
    expect(surface?.style.top).toBe('204px');
    expect(surface?.style.right).toBe(`${window.innerWidth - 300}px`);
  });

  it('enables Delete when the worktree is not split-locked', async () => {
    setGatingPrefs(true, 500);

    await render();
    await openActionsMenu();

    const archive = query('worktree-actions-menu-archive');
    expect(archive).not.toBeNull();
    expect(archive?.hasAttribute('disabled')).toBe(false);
    expect(archive?.textContent).toContain('Archive');
    // Retention on: neutral tone, not the destructive hard-delete framing.
    expect(archive?.className).not.toContain('fg-destructive');
  });

  it('disables the Delete menu item while archive is in progress', async () => {
    await render({
      isArchiveInProgress: true,
      worktree: { status: 'done' },
    });
    await openActionsMenu();

    const archive = query('worktree-actions-menu-archive');
    expect(archive).not.toBeNull();
    expect(archive?.hasAttribute('disabled')).toBe(true);
    expect(archive?.getAttribute('title')).toContain(
      'Removal is already in progress',
    );
    // The hover rail hides the archive chip entirely while removal cannot
    // run — the disabled explanation lives on the menu item above.
    expect(query('worktree-archive-button')).toBeNull();

    await render({ isArchiveInProgress: false });
    expect(
      query('worktree-actions-menu-archive')?.hasAttribute('disabled'),
    ).toBe(false);
  });

  it('offers a destructive Delete alongside Archive even for a legacy retention-off project', async () => {
    setGatingPrefs(true, 500);
    useProjectsStore.setState((state) => ({
      projects: state.projects.map((project) =>
        project.id === PROJECT_ID
          ? { ...project, archiveRetentionDays: 0 }
          : project,
      ),
    }));

    await render();
    await openActionsMenu();

    const deleteItem = query('worktree-actions-menu-delete');
    expect(deleteItem).not.toBeNull();
    expect(deleteItem?.textContent).toContain('Delete');
    // Recoverable removal reads neutral, like Archive.
    expect(deleteItem?.className).not.toContain('fg-destructive');
    // Deletion retention is always on: legacy 0 resolves to the 7-day window.
    expect(deleteItem?.getAttribute('title')).toBe(
      'Kept for 7 days, then removed',
    );
    const archiveItem = query('worktree-actions-menu-archive');
    expect(archiveItem?.textContent).toContain('Archive');
    expect(archiveItem?.className).not.toContain('fg-destructive');
    expect(archiveItem?.getAttribute('title')).toBe('Kept until you delete it');
  });
});

describe('WorktreeItem removal branch choice', () => {
  async function openRemovalConfirmation(
    mode: 'delete' | 'archive' = 'delete',
  ): Promise<void> {
    await openActionsMenu();
    await act(async () => {
      requireElement(`worktree-actions-menu-${mode}`).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });
  }

  it('offers Cancel and one removal action, with the branch kept by a switch', async () => {
    const onArchive = jest.fn();
    await render({ onArchive });
    await openRemovalConfirmation();

    expect(document.body.textContent).toContain('Keep the local branch');
    expect(document.body.textContent).not.toContain(
      'will still be deleted if it is fully merged',
    );

    const dialog = document.querySelector('[role="dialog"]');
    const actions = Array.from(dialog?.querySelectorAll('button') ?? [])
      // A label without the key chip drawn after it.
      .map((button) => button.firstChild?.textContent ?? '')
      .filter((label) => label !== '');
    expect(actions).toEqual(['Cancel', 'Delete worktree']);
    // Delete carries the destructive role (DESIGN.md: never style a
    // destructive action with the accent role).
    const preserveBranch = requireElement('worktree-removal-preserve-branch');
    expect(preserveBranch.className).toContain('bg-destructive');
    expect(preserveBranch.className).not.toContain('bg-accent');
    expect(
      requireElement('worktree-removal-keep-branch').getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    expect(query('worktree-removal-branch-choice-menu')).toBeNull();

    await act(async () => {
      requireElement('worktree-removal-preserve-branch').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(onArchive).toHaveBeenCalledWith(WORKTREE_ID, {
      deleteBranch: false,
      deleteWithoutRetentionIfMissing: true,
      expectedBranchName: 'feature/big-change',
    });
  });

  it('opens the Delete confirmation from the Delete item and keeps the container unlocked', async () => {
    const onArchive = jest.fn();
    await render({ onArchive });
    await openRemovalConfirmation('delete');

    expect(document.body.textContent).toContain(
      'Delete worktree “feature/big-change”?',
    );
    expect(document.body.textContent).toContain('for 7 days');
    // The old lock toggle is gone: state is chosen by the menu item.
    expect(query('worktree-removal-lock-toggle')).toBeNull();

    await act(async () => {
      requireElement('worktree-removal-preserve-branch').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(onArchive).toHaveBeenCalledWith(WORKTREE_ID, {
      deleteBranch: false,
      deleteWithoutRetentionIfMissing: true,
      expectedBranchName: 'feature/big-change',
    });
  });

  it('opens the Archive confirmation from the Archive item and locks the container', async () => {
    const onArchive = jest.fn();
    await render({ onArchive });
    await openRemovalConfirmation('archive');

    expect(document.body.textContent).toContain(
      'Archive worktree “feature/big-change”?',
    );
    expect(document.body.textContent).toContain('until you delete the archive');
    expect(document.body.textContent).not.toContain('for 7 days');

    await act(async () => {
      requireElement('worktree-removal-preserve-branch').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(onArchive).toHaveBeenCalledWith(WORKTREE_ID, {
      deleteBranch: false,
      expectedBranchName: 'feature/big-change',
      lockAfterArchive: true,
    });
  });

  it('still confirms Archive when Delete is safe to perform immediately', async () => {
    const onArchive = jest.fn();
    await render({ onArchive, worktree: { status: 'done' } });

    await openRemovalConfirmation('archive');

    expect(onArchive).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'Archive worktree “feature/big-change”?',
    );
    expect(document.body.textContent).toContain('until you delete the archive');
  });

  it('identifies and revalidates an App Advisor archive target', async () => {
    const onArchive = jest.fn();
    await render({ onArchive });

    await act(async () => {
      requestWorktreeArchiveConfirmation({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        requestedDeleteBranch: true,
      });
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain(
      'Delete worktree “feature/big-change”?',
    );
    expect(query('worktree-removal-target-identity')?.textContent).toContain(
      'feature/big-change is deleted from test-project.',
    );

    await render({
      onArchive,
      worktree: { branchName: 'feature/different-target' },
    });
    expect(
      query('worktree-removal-target-identity')?.textContent,
    ).not.toContain('feature/different-target');
    await act(async () => {
      requireElement('worktree-removal-delete-branch').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('opens an App Advisor request in its mode with the switch set to the requested branch choice', async () => {
    await render();

    await act(async () => {
      requestWorktreeArchiveConfirmation({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        requestedDeleteBranch: false,
        lockAfterArchive: true,
      });
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain(
      'Archive worktree “feature/big-change”?',
    );
    expect(document.body.textContent).toContain(
      `${ORCHESTRATOR_LABEL} suggested keeping it.`,
    );
    expect(
      query('worktree-removal-keep-branch')?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(query('worktree-removal-preserve-branch')).not.toBeNull();
    expect(query('worktree-removal-delete-branch')).toBeNull();
  });

  it('names a worktree on its generated default branch "New worktree"', async () => {
    await render({ worktree: { branchName: `${WORKTREE_ID}-1713571200123` } });
    const row = requireElement('worktree-row');
    expect(row.textContent).toContain('New worktree');
    expect(row.textContent).not.toContain('New Task');
  });

  it('keeps an archive confirmation valid when only its display label changes', async () => {
    const onArchive = jest.fn();
    await render({ onArchive, worktree: { label: 'New Task' } });
    await openRemovalConfirmation('archive');
    expect(document.body.textContent).toContain('Archive worktree “New Task”?');

    await render({ onArchive, worktree: { label: 'Multiple branches' } });
    const choice = requireElement('worktree-removal-preserve-branch');
    if (!(choice instanceof HTMLButtonElement)) {
      throw new Error('Expected a Preserve local button');
    }
    expect(choice.disabled).toBe(false);
    await act(async () => {
      requireElement('worktree-removal-preserve-branch').click();
      await Promise.resolve();
    });
    expect(onArchive).toHaveBeenCalledWith(WORKTREE_ID, {
      deleteBranch: false,
      expectedBranchName: 'feature/big-change',
      lockAfterArchive: true,
    });
  });

  it('reports the visible removal confirmation to App Advisor', async () => {
    await render();
    await openRemovalConfirmation();

    expect(
      useCurrentUiStateStore.getState().slices[
        `worktree.archiveDialog.${WORKTREE_ID}`
      ],
    ).toEqual({
      open: true,
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      branchName: 'feature/big-change',
      archiveInProgress: false,
      blocked: false,
    });
  });

  it('passes the explicit delete choice to archive handling', async () => {
    const onArchive = jest.fn();
    await render({ onArchive });
    await openRemovalConfirmation();
    await act(async () => {
      requireElement('worktree-removal-keep-branch').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      requireElement('worktree-removal-delete-branch').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(onArchive).toHaveBeenCalledWith(WORKTREE_ID, {
      deleteBranch: true,
      deleteWithoutRetentionIfMissing: true,
      expectedBranchName: 'feature/big-change',
    });
  });

  it('re-checks removal gating before applying a branch choice', async () => {
    const onArchive = jest.fn();
    await render({ onArchive });
    await openRemovalConfirmation();

    await render({ onArchive, isArchiveInProgress: true });
    await act(async () => {
      requireElement('worktree-removal-preserve-branch').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(onArchive).not.toHaveBeenCalled();
  });
});

describe('WorktreeItem row Archive (early access)', () => {
  beforeEach(() => {
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
  });
  afterEach(() => {
    resetExperimentalFeaturesStoreForTest();
  });

  it('shows Archive enabled when it can run', async () => {
    const onArchive = jest.fn();
    await render({ onArchive });
    const archive = requireElement('worktree-archive-row-button');
    expect(archive.hasAttribute('disabled')).toBe(false);
  });

  it('keeps an unavailable Archive in place, disabled, saying why', async () => {
    const onArchive = jest.fn();
    await render({ onArchive, isArchiveInProgress: true });
    const archive = requireElement('worktree-archive-row-button');
    expect(archive.hasAttribute('disabled')).toBe(true);
    expect(archive.getAttribute('aria-label')).toBe(
      'Archive: Removal is already in progress',
    );
    await act(async () => {
      archive.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onArchive).not.toHaveBeenCalled();
  });
});

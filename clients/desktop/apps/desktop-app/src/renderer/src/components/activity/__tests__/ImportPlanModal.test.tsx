/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DetectedPlanEntry,
  FileIndexEntry,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { getWorktreeCacheKey, useFileListStore } from '@/stores/fileListStore';
import { ImportPlanModal } from '../ImportPlanModal';

const mockQuery = jest.fn();
jest.mock('@canopy/app-state', () => ({
  ...jest.requireActual<object>('@canopy/app-state'),
  useCanopyClient: (): { query: jest.Mock } => ({ query: mockQuery }),
}));

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;

let container: HTMLDivElement;
let root: Root;

function indexFile(relativePath: string): FileIndexEntry {
  const segments = relativePath.split('/');
  return {
    relativePath,
    filename: segments[segments.length - 1] ?? relativePath,
    absolutePath: `/repo/${relativePath}`,
    isIgnored: false,
  };
}

function seedIndex(paths: readonly string[]): void {
  useFileListStore.setState({
    indexErrors: {},
    indexCache: {
      [getWorktreeCacheKey(PROJECT_ID, WORKTREE_ID)]: {
        fetchedAt: Date.now(),
        data: {
          repos: [
            {
              repoId: 'repo-1',
              repoName: 'canopy',
              absolutePath: '/repo',
              rootKind: 'git-repo',
              files: paths.map(indexFile),
            },
          ],
        },
      },
    },
  });
}

function detected(overrides: Partial<DetectedPlanEntry>): DetectedPlanEntry {
  return {
    id: 'entry-1',
    sourceRepoId: 'repo-1',
    sourceFilePath: 'plans/rollout.md',
    status: 'detected',
    bannerSeen: false,
    detectedInChatId: 'chat-1',
    detectedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function trackedPlan(overrides: Partial<TrackedPlanData>): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    source: 'imported',
    title: 'Plan',
    content: '# Plan',
    reviewStatus: 'pending',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
    ...overrides,
  };
}

function chatTab(id: string, title: string): ChatTab {
  return {
    id,
    title,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', fastMode: false, speed: 'standard' },
    fastModeExplicit: false,
  };
}

function render(
  props: Partial<Parameters<typeof ImportPlanModal>[0]> = {},
): void {
  act(() => {
    root.render(
      <ImportPlanModal
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        onClose={jest.fn()}
        onImported={jest.fn()}
        {...props}
      />,
    );
  });
}

function options(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ content: '# Rollout plan\n' });
  useActivityStore.setState({
    detectedPlans: {},
    trackedPlans: {},
    trackedPlanInventoryLoaded: { [KEY]: true },
    loadTrackedPlans: jest.fn(() => Promise.resolve()),
    loadDetectedPlans: jest.fn(() => Promise.resolve()),
    importTrackedPlan: jest.fn().mockResolvedValue(null),
    updateDetectedPlan: jest.fn().mockResolvedValue(undefined),
  });
  useChatStore.setState({ worktreeChats: {} });
  // An index error keeps the modal from fetching and shows in the results.
  useFileListStore.setState({
    indexCache: {},
    indexLoading: new Set<string>(),
    indexErrors: {
      [getWorktreeCacheKey(PROJECT_ID, WORKTREE_ID)]:
        'Unable to index /private/repo',
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  jest.useRealTimers();
});

describe('ImportPlanModal session-replay privacy', () => {
  it('records the card, including the worktree path in the error', () => {
    render();

    const card = container.querySelector('[data-testid="import-plan-modal"]');
    expect(card?.getAttribute('role')).toBe('dialog');
    expect(card?.textContent).toContain('Unable to index /private/repo');
    expect(card?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
  });

  it('blocks only the preview title, which is file content', async () => {
    jest.useFakeTimers();
    seedIndex(['docs/plan.md']);
    render();
    await act(async () => {
      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });

    const title = container.querySelector(
      '[data-testid="import-plan-preview-title"]',
    );
    expect(title?.textContent).toBe('Rollout plan');
    expect(title?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);
    expect(
      container
        .querySelector('[data-testid="import-plan-input"]')
        ?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS),
    ).toBe(false);
    expect(mockQuery).toHaveBeenCalledWith('file.read', {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      repoId: 'repo-1',
      relativePath: 'docs/plan.md',
    });
  });
});

describe('ImportPlanModal rows', () => {
  it('lists importable index files and pending suggestions first', () => {
    seedIndex(['docs/plan.md', 'src/index.ts']);
    useActivityStore.setState({
      detectedPlans: {
        [KEY]: [
          detected({ id: 'other', detectedInChatId: 'chat-2' }),
          detected({
            id: 'origin',
            sourceFilePath: 'plans/origin.md',
            detectedInChatId: 'chat-1',
          }),
          detected({ id: 'hidden', status: 'dismissed' }),
        ],
      },
    });
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [chatTab('chat-1', 'Fix checkout')],
          activeTabId: 'chat-1',
        },
      },
    });
    render({ originChatId: 'chat-1' });

    const rows = options().map((option) => option.textContent ?? '');
    // The origin chat's file leads; a chat that is gone drops the suffix.
    expect(rows[0]).toContain('origin.md');
    expect(rows[0]).toContain('from Fix checkout');
    expect(rows[1]).toContain('rollout.md');
    expect(rows[1]).not.toContain('from ');
    expect(rows[2]).toContain('plan.md');
    // Source files are not importable plans.
    expect(rows.join()).not.toContain('index.ts');
    expect(
      container.querySelector('[data-testid="import-plan-dismissed-section"]')
        ?.textContent,
    ).toContain('1 hidden');
  });

  it('masks the user-authored chat title on a suggestion', () => {
    useActivityStore.setState({
      detectedPlans: { [KEY]: [detected({ id: 'origin' })] },
    });
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [chatTab('chat-1', 'Fix checkout')],
          activeTabId: 'chat-1',
        },
      },
    });
    render();

    const masked = options()[0]?.querySelector(`.${POSTHOG_REPLAY_MASK_CLASS}`);
    expect(masked?.textContent).toBe('Fix checkout');
  });

  it('filters suggestions and files by the query', () => {
    seedIndex(['docs/plan.md', 'docs/billing.md']);
    useActivityStore.setState({
      detectedPlans: {
        [KEY]: [
          detected({ id: 'rollout' }),
          detected({ id: 'billing', sourceFilePath: 'specs/billing-v2.md' }),
        ],
      },
    });
    render();

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="import-plan-input"]',
    );
    if (!input) throw new Error('missing search input');
    const typeQuery = (value: string): void => {
      act(() => {
        const descriptor = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        );
        descriptor?.set?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };

    typeQuery('billing');
    const rows = options().map((option) => option.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('billing-v2.md');
    expect(rows[1]).toContain('billing.md');

    typeQuery('zzz-nothing');
    expect(options()).toHaveLength(0);
    expect(
      container.querySelector('[data-testid="import-plan-empty"]')?.textContent,
    ).toBe('No matches.');
  });

  it('marks files already tracked across repo-id sentinels and separators', () => {
    seedIndex(['docs/plan.md']);
    useFileListStore.setState((state) => {
      const cacheKey = getWorktreeCacheKey(PROJECT_ID, WORKTREE_ID);
      const cached = state.indexCache[cacheKey];
      if (!cached) return state;
      return {
        indexCache: {
          [cacheKey]: {
            ...cached,
            data: {
              repos: [
                ...cached.data.repos,
                {
                  repoId: '__workspace_root__',
                  repoName: 'workspace',
                  absolutePath: '/ws',
                  rootKind: 'workspace-root',
                  files: [indexFile('notes/root-plan.md')],
                },
              ],
            },
          },
        },
      };
    });
    useActivityStore.setState({
      trackedPlans: {
        [KEY]: [
          trackedPlan({
            id: 'plan-docs',
            sourceRepoId: 'repo-1',
            sourceFilePath: 'docs\\plan.md',
          }),
          trackedPlan({
            id: 'plan-root',
            sourceRepoId: '__worktree__',
            sourceFilePath: 'notes/root-plan.md',
          }),
        ],
      },
    });
    const onOpenTracked = jest.fn();
    render({ onOpenTracked });

    expect(
      container.querySelectorAll('[data-testid="import-plan-tracked-badge"]'),
    ).toHaveLength(2);
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="import-plan-primary"]')
        ?.click();
    });
    expect(onOpenTracked).toHaveBeenCalledWith(
      expect.stringMatching(/^plan-(docs|root)$/),
    );
    expect(
      useActivityStore.getState().importTrackedPlan,
    ).not.toHaveBeenCalled();
  });

  it('loads the tracked plans before it can mark a file tracked', async () => {
    seedIndex(['docs/plan.md']);
    const loadTrackedPlans = jest.fn((): Promise<void> => {
      useActivityStore.setState({
        trackedPlans: {
          [KEY]: [
            trackedPlan({
              sourceRepoId: 'repo-1',
              sourceFilePath: 'docs/plan.md',
            }),
          ],
        },
        trackedPlanInventoryLoaded: { [KEY]: true },
      });
      return Promise.resolve();
    });
    useActivityStore.setState({
      trackedPlanInventoryLoaded: {},
      loadTrackedPlans,
    });

    await act(async () => {
      render();
      await Promise.resolve();
    });

    expect(loadTrackedPlans).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID);
    expect(
      container.querySelectorAll('[data-testid="import-plan-tracked-badge"]'),
    ).toHaveLength(1);
  });

  it.each([
    ['a file', (): void => seedIndex(['plans/rollout.md'])],
    [
      'a suggestion',
      (): void =>
        useActivityStore.setState({
          detectedPlans: { [KEY]: [detected({})] },
        }),
    ],
  ])(
    'opens %s that the late inventory shows is tracked instead of importing it',
    async (_label, seed) => {
      seed();
      let resolveInventory = (): void => undefined;
      const inventory = new Promise<void>((resolve) => {
        resolveInventory = (): void => {
          useActivityStore.setState({
            trackedPlans: {
              [KEY]: [
                trackedPlan({
                  sourceRepoId: 'repo-1',
                  sourceFilePath: 'plans/rollout.md',
                }),
              ],
            },
            trackedPlanInventoryLoaded: { [KEY]: true },
          });
          resolve();
        };
      });
      const importTrackedPlan = jest.fn().mockResolvedValue(null);
      useActivityStore.setState({
        trackedPlanInventoryLoaded: {},
        loadTrackedPlans: jest.fn(() => inventory),
        importTrackedPlan,
      });
      const onOpenTracked = jest.fn();
      render({ onOpenTracked });

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="import-plan-primary"]',
          )
          ?.click();
        await Promise.resolve();
      });
      await act(async () => {
        resolveInventory();
        await inventory;
        await Promise.resolve();
      });

      expect(importTrackedPlan).not.toHaveBeenCalled();
      expect(onOpenTracked).toHaveBeenCalledWith('plan-1');
    },
  );

  it('marks a single-repo file tracked when main stored the root sentinel', () => {
    // A single-repo worktree's file root is the workspace id, while main
    // records imports and detections there as the workspace root.
    useFileListStore.setState({
      indexErrors: {},
      indexCache: {
        [getWorktreeCacheKey(PROJECT_ID, WORKTREE_ID)]: {
          fetchedAt: Date.now(),
          data: {
            repos: [
              {
                repoId: PROJECT_ID,
                repoName: PROJECT_ID,
                absolutePath: '/repo',
                rootKind: 'git-repo',
                files: [indexFile('docs/plan.md')],
              },
            ],
          },
        },
      },
    });
    useActivityStore.setState({
      trackedPlans: {
        [KEY]: [
          trackedPlan({
            sourceRepoId: '__workspace_root__',
            sourceFilePath: 'docs/plan.md',
          }),
        ],
      },
    });
    render();

    expect(
      container.querySelectorAll('[data-testid="import-plan-tracked-badge"]'),
    ).toHaveLength(1);
  });

  it('previews a single-repo suggestion from the workspace file root', async () => {
    jest.useFakeTimers();
    useFileListStore.setState({
      indexErrors: {},
      indexCache: {
        [getWorktreeCacheKey(PROJECT_ID, WORKTREE_ID)]: {
          fetchedAt: Date.now(),
          data: {
            repos: [
              {
                repoId: PROJECT_ID,
                repoName: PROJECT_ID,
                absolutePath: '/repo',
                rootKind: 'git-repo',
                files: [],
              },
            ],
          },
        },
      },
    });
    useActivityStore.setState({
      detectedPlans: {
        [KEY]: [detected({ sourceRepoId: '__workspace_root__' })],
      },
    });
    render();
    await act(async () => {
      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockQuery).toHaveBeenCalledWith('file.read', {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      repoId: PROJECT_ID,
      relativePath: 'plans/rollout.md',
    });
  });

  it('imports a suggestion through the shared action and tells its chat', async () => {
    const plan = trackedPlan({ id: 'plan-new' });
    const importTrackedPlan = jest.fn().mockResolvedValue(plan);
    const queuePlanImportInstruction = jest.fn();
    useActivityStore.setState({
      importTrackedPlan,
      detectedPlans: { [KEY]: [detected({})] },
    });
    useChatStore.setState({ queuePlanImportInstruction });
    const onImported = jest.fn();
    render({ onImported, originChatId: 'chat-1' });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="import-plan-primary"]')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(importTrackedPlan).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'plans/rollout.md',
      'repo-1',
    );
    expect(onImported).toHaveBeenCalledWith(plan);
    expect(queuePlanImportInstruction).toHaveBeenCalledWith(
      'chat-1',
      'plans/rollout.md',
    );
  });

  it('does not tell the opening chat about a suggestion from another chat', async () => {
    const importTrackedPlan = jest
      .fn()
      .mockResolvedValue(trackedPlan({ id: 'plan-new' }));
    const queuePlanImportInstruction = jest.fn();
    useActivityStore.setState({
      importTrackedPlan,
      detectedPlans: { [KEY]: [detected({ detectedInChatId: 'chat-2' })] },
    });
    useChatStore.setState({ queuePlanImportInstruction });
    render({ originChatId: 'chat-1' });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="import-plan-primary"]')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(importTrackedPlan).toHaveBeenCalled();
    expect(queuePlanImportInstruction).not.toHaveBeenCalled();
  });
});

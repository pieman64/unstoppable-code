/**
 * @jest-environment jsdom
 */
jest.mock('@/components/chat/PlanReadyPipelineModal', () => ({
  PlanReadyPipelineModal: ({
    onRun,
  }: {
    onRun: PlanReadyPipelineModalOnRun;
  }): JSX.Element => (
    <button
      type="button"
      data-testid="mock-plan-ready-run"
      onClick={(): void => {
        void onRun(
          'pipeline-1',
          {
            info: {
              id: 'pipeline-1',
              name: 'Pipeline',
              filename: 'pipeline.yml',
              description: '',
              icon: 'workflow',
              createdAt: '2026-06-01T00:00:00.000Z',
              updatedAt: '2026-06-01T00:00:00.000Z',
              source: 'bundled',
              readonly: true,
            },
            content: { name: 'Pipeline', on: 'plan_ready', jobs: {} },
          },
          {
            continue_on_refine_gate_fail: 'true',
            continue_on_plan_contract_fail: 'true',
          },
          'repo-1',
          {
            preferences: {},
            modelConfig: { fastMode: true },
          },
        );
      }}
    >
      Run mocked pipeline
    </button>
  ),
}));
const openPipelineExecutionFromUiMock = jest.fn<
  Promise<unknown>,
  [request: unknown]
>(() => Promise.resolve({ status: 'applied' }));
jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionFromUi: (request: unknown): Promise<unknown> =>
    openPipelineExecutionFromUiMock(request),
}));

const revealWorktreeChatPanelMock = jest.fn<boolean, [unknown, unknown]>(
  () => true,
);
jest.mock('@/lib/panels/plan-panel-open', () => ({
  ...jest.requireActual<object>('@/lib/panels/plan-panel-open'),
  revealWorktreeChatPanel: (scope: unknown, chatId: unknown): boolean =>
    revealWorktreeChatPanelMock(scope, chatId),
}));

jest.mock('../PlanSourceMark', () => ({
  PlanSourceMark: (): null => null,
}));
jest.mock('@/lib/plans/open-tracked-plan', () => ({
  openTrackedPlan: jest.fn().mockResolvedValue({ status: 'placed' }),
}));

import { act, type JSX } from 'react';
import { implementTrackedPlan } from '@/lib/plans/plan-follow-up';
import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import { createRoot, type Root } from 'react-dom/client';
import {
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type ChatRuntimeState,
  type DetectedPlanEntry,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import type { PlanReadyPipelineModalOnRun } from '@/components/chat/PlanReadyPipelineModal';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { PlansSection } from '../PlansSection';
import { WorkspaceAccessContext } from '@/lib/workspace-access';
import { PanelWorktreeContext } from '@/lib/panels/panel-worktree-context';
import { SharePlanModal } from '../../shared/SharePlanModal';
import { ActivitySectionChromeContext } from '@/components/shared/panel-section';

function resetFeatureFlags(): void {
  useFeatureFlagsStore.setState({
    snapshot: { ...getDefaultFeatureFlagSnapshot(), status: 'ready' },
  });
}

function setPersonalContext(): void {
  const snapshot = useFeatureFlagsStore.getState().snapshot;
  useFeatureFlagsStore.setState({
    snapshot: {
      ...snapshot,
      values: {
        ...snapshot.values,
        [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
      },
    },
  });
  useWorkspaceContextStore.setState({
    hydrated: true,
    state: { context: { kind: 'personal' }, revision: 1, organizations: [] },
  });
}

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
type ShareSyncStatus = NonNullable<TrackedPlanData['share']>['syncStatus'];

let shareTrackedPlanMock: jest.Mock;
let addToastMock: jest.Mock;
const openTrackedPlanMock = jest.mocked(openTrackedPlan);

function makePlan(overrides: Partial<TrackedPlanData> = {}): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    source: 'claude',
    title: 'My Plan',
    content: '# My Plan\n\nBody',
    reviewStatus: 'pending',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [
      {
        revisionNumber: 1,
        content: '# My Plan\n\nBody',
        source: 'claude',
        reviewStatus: 'pending',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ],
    linkedExecutionIds: [],
    ...overrides,
  };
}

function makeChatTab(id: string): ChatTab {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    fastModeExplicit: false,
    modelConfig: {
      thinkingLevel: 'high',
      speed: 'standard',
      fastMode: false,
    },
  };
}

function render(node: JSX.Element): {
  container: HTMLDivElement;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    cleanup: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    el?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useRealTimers();
  resetFeatureFlags();
  useWorkspaceContextStore.setState(
    useWorkspaceContextStore.getInitialState(),
    true,
  );
  useCurrentUiStateStore.setState({ slices: {} });
  shareTrackedPlanMock = jest.fn();
  addToastMock = jest.fn();
  openTrackedPlanMock.mockClear();

  useChatStore.setState({
    selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    sendMessage: jest.fn().mockResolvedValue(undefined),
  });
  usePipelineRunsStore.setState({ summaries: [] });
  openPipelineExecutionFromUiMock.mockClear();
  useGitHubStore.setState({ addToast: addToastMock });
  useActivityStore.setState({
    trackedPlans: { [KEY]: [makePlan()] },
    trackedPlanInventoryLoaded: { [KEY]: true },
    importModalRequest: null,
    loadTrackedPlans: jest.fn().mockResolvedValue(undefined),
    openImportModal: jest.fn(),
    closeImportModal: jest.fn(),
    togglePlanHidden: jest.fn().mockResolvedValue(undefined),
    shareTrackedPlan: shareTrackedPlanMock,
    importTrackedPlan: jest.fn().mockResolvedValue(null),
    detectedPlans: {},
    loadDetectedPlans: jest.fn().mockResolvedValue(undefined),
    updateDetectedPlan: jest.fn().mockResolvedValue(undefined),
  });

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      getCanopyCloudBaseUrl: jest
        .fn()
        .mockResolvedValue('https://cloud.example.test'),
      loadCanopyCloudAccount: jest.fn().mockResolvedValue({
        hasApiKey: true,
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
        capabilities: ['teams-v1', 'organizations-v1', 'plans-crud-v1'],
        account: { id: 'account-1', email: 'user@example.test' },
        storageAvailable: true,
      }),
      getWorktreePath: jest.fn().mockResolvedValue('/repo'),
      activity: {
        plans: {
          update: jest
            .fn()
            .mockResolvedValue(makePlan({ reviewStatus: 'approved' })),
          import: jest.fn().mockResolvedValue(null),
        },
      },
    },
  });
  Object.defineProperty(window, 'pipelines', {
    configurable: true,
    value: {
      execute: jest.fn().mockResolvedValue({ success: true, data: {} }),
      listSharedTeams: jest.fn().mockResolvedValue({
        success: true,
        data: {
          data: [
            {
              id: 'team-7',
              name: 'Team Seven',
              organization: { id: 'org-1', name: 'Org One' },
            },
          ],
        },
      }),
      listSharedOrganizations: jest.fn().mockResolvedValue({
        success: true,
        data: { data: [{ id: 'org-1', name: 'Org One' }] },
      }),
    },
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('PlansSection read-only recipient controls', () => {
  it('keeps viewer plans document-only', async () => {
    const viewerPlan = makePlan({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'container-1',
    });
    useActivityStore.setState({
      trackedPlans: {
        [`${SHARED_CONTAINER_VIEWER_PROJECT_ID}/container-1`]: [viewerPlan],
      },
    });

    const { container, cleanup } = render(
      <WorkspaceAccessContext.Provider
        value={{
          mode: 'read-only',
          reason: 'shared-container',
          containerType: 'CODE_WORKTREE',
          runAllowed: false,
        }}
      >
        <PanelWorktreeContext.Provider
          value={{
            projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
            worktreeId: 'container-1',
          }}
        >
          <PlansSection />
        </PanelWorktreeContext.Provider>
      </WorkspaceAccessContext.Provider>,
    );
    await flush();

    const row = container.querySelector(
      '[data-testid="activity-plan-row-plan-1"]',
    );
    expect(row).toBeTruthy();
    expect(
      container.querySelector(
        '[data-testid="activity-plan-toggle-hidden-plan-1"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="activity-plan-plan-1-explore"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="activity-plan-plan-1-execute"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="activity-plan-plan-1-share"]'),
    ).toBeNull();

    await click(row);
    // The recipient's own surface shows the plan list, so the plan opens
    // there without navigating.
    expect(openTrackedPlanMock).toHaveBeenCalledWith(
      {
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: 'container-1',
        planId: 'plan-1',
      },
      { navigate: false },
    );
    cleanup();
  });
});

describe('PlansSection share button', () => {
  it('disables execution for Cursor plans pending safe admission', async () => {
    useActivityStore.setState({
      trackedPlans: { [KEY]: [{ ...makePlan(), source: 'cursor' }] },
    });
    const { container, cleanup } = render(<PlansSection />);
    try {
      const execute = container.querySelector(
        '[data-testid="activity-plan-plan-1-execute"]',
      );
      await click(execute);
      for (const action of ['implement', 'pipeline']) {
        const item = document.querySelector(
          `[data-testid="activity-plan-plan-1-execute-${action}"]`,
        );
        expect(item instanceof HTMLButtonElement && item.disabled).toBe(true);
      }
      expect(
        document.querySelector(
          '[data-testid="activity-plan-plan-1-execute-copy"]',
        ),
      ).toBeNull();
      const copy = container.querySelector(
        '[data-testid="activity-plan-plan-1-copy"]',
      );
      expect(copy instanceof HTMLButtonElement && !copy.disabled).toBe(true);
      expect(copy?.getAttribute('aria-disabled')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('renders the Share label for an unshared plan', async () => {
    const { container, cleanup } = render(<PlansSection />);
    await flush();
    const shareBtn = container.querySelector(
      '[data-testid="activity-plan-plan-1-share"]',
    );
    expect(shareBtn?.textContent).toContain('Share');
    expect(shareBtn?.textContent).not.toContain('Shared');
    cleanup();
  });

  it('hides a new share in Personal and keeps an existing share', async () => {
    setPersonalContext();
    const first = render(<PlansSection />);
    await flush();
    expect(
      first.container.querySelector(
        '[data-testid="activity-plan-plan-1-share"]',
      ),
    ).toBeNull();
    first.cleanup();

    useActivityStore.setState({
      trackedPlans: {
        [KEY]: [
          makePlan({
            share: {
              serverId: 'server-1',
              remoteId: 'remote-1',
              shareScope: 'team',
              teamId: 'team-1',
              syncStatus: 'synced',
              lastSyncedAt: '2026-09-24T20:00:00.000Z',
            },
          }),
        ],
      },
    });
    const second = render(<PlansSection />);
    await flush();
    expect(
      second.container.querySelector(
        '[data-testid="activity-plan-plan-1-share"]',
      ),
    ).not.toBeNull();
    second.cleanup();
  });

  const shareStatusLabels: Array<[ShareSyncStatus, string]> = [
    ['synced', 'Shared'],
    ['pending', 'Syncing…'],
    ['syncing', 'Syncing…'],
    ['error', 'Try sharing again'],
  ];

  it.each(shareStatusLabels)(
    'derives the %s sync status into the "%s" label',
    async (syncStatus, label) => {
      useActivityStore.setState({
        trackedPlans: {
          [KEY]: [
            makePlan({
              share: {
                serverId: 'server-1',
                remoteId: 'remote-1',
                shareScope: 'team',
                teamId: 'team-7',
                syncStatus,
              },
            }),
          ],
        },
      });
      const { container, cleanup } = render(<PlansSection />);
      await flush();
      const shareBtn = container.querySelector(
        '[data-testid="activity-plan-plan-1-share"]',
      );
      expect(shareBtn?.textContent).toContain(label);
      cleanup();
    },
  );

  it.each(['synced', 'error'] as const)(
    'treats a %s private-only share as not shared',
    async (syncStatus) => {
      // Private is a storage value, not an audience: a private-only cloud copy
      // is hidden from everyone else, so the plan reads as unshared and Share
      // opens the scope picker instead of resyncing that copy.
      useActivityStore.setState({
        trackedPlans: {
          [KEY]: [
            makePlan({
              share: {
                serverId: 'server-1',
                remoteId: 'remote-1',
                shareScope: 'private',
                syncStatus,
              },
            }),
          ],
        },
      });
      const { container, cleanup } = render(<PlansSection />);
      await flush();

      const shareBtn = container.querySelector(
        '[data-testid="activity-plan-plan-1-share"]',
      );
      expect(shareBtn?.textContent).toContain('Share');
      expect(shareBtn?.textContent).not.toContain('Shared');
      expect(shareBtn?.textContent).not.toContain('Try again');

      await click(shareBtn);
      await flush();

      expect(
        document.body.querySelector('[data-testid="share-plan-modal"]'),
      ).toBeTruthy();
      expect(shareTrackedPlanMock).not.toHaveBeenCalled();
      cleanup();
    },
  );

  it('shows the scoped link when an existing plan share is reopened', async () => {
    const { cleanup } = render(
      <SharePlanModal
        planId="plan-1"
        planTitle="My Plan"
        existingShare={{
          serverId: 'server-1',
          remoteId: 'remote-1',
          shareScope: 'team',
          teamId: 'team-7',
          syncStatus: 'synced',
        }}
        onClose={jest.fn()}
        onShare={jest.fn()}
      />,
    );
    await flush();

    expect(
      document.body.querySelector('[data-testid="share-plan-copy-link"]'),
    ).toBeTruthy();
    cleanup();
  });

  it('resyncs an already-shared plan directly without reopening the scope picker', async () => {
    const sharedPlan = makePlan({
      share: {
        serverId: 'server-1',
        remoteId: 'remote-1',
        shareScope: 'team',
        teamId: 'team-7',
        syncStatus: 'error',
      },
    });
    useActivityStore.setState({
      trackedPlans: { [KEY]: [sharedPlan] },
    });
    shareTrackedPlanMock.mockResolvedValue({
      ...sharedPlan,
      share: {
        serverId: 'server-1',
        remoteId: 'remote-1',
        shareScope: 'team',
        teamId: 'team-7',
        syncStatus: 'synced',
      },
    });

    const { container, cleanup } = render(<PlansSection />);
    await flush();

    await click(
      container.querySelector('[data-testid="activity-plan-plan-1-share"]'),
    );
    await flush();

    expect(
      document.body.querySelector('[data-testid="share-plan-modal"]'),
    ).toBeNull();
    expect(shareTrackedPlanMock).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'plan-1',
    );
    cleanup();
  });

  it('opens the modal (Team preselected), selects a team, and passes scope + target id to the store action', async () => {
    shareTrackedPlanMock.mockResolvedValue(
      makePlan({
        share: {
          serverId: 'server-1',
          remoteId: 'remote-1',
          shareScope: 'team',
          syncStatus: 'synced',
        },
      }),
    );

    const { container, cleanup } = render(<PlansSection />);
    await flush();

    await click(
      container.querySelector('[data-testid="activity-plan-plan-1-share"]'),
    );
    await flush();

    // Modal renders into a portal on document.body.
    const modal = document.body.querySelector(
      '[data-testid="share-plan-modal"]',
    );
    expect(modal).toBeTruthy();

    // There is no Private audience: Team is the first fallback, and the
    // selector offers only Team and Organization.
    const radios = Array.from(modal?.querySelectorAll('[role="radio"]') ?? []);
    expect(radios.map((el) => el.textContent)).toEqual([
      expect.stringContaining('Team'),
      expect.stringContaining('Organization'),
    ]);
    const checkedRadio = modal?.querySelector(
      '[role="radio"][aria-checked="true"]',
    );
    expect(checkedRadio?.textContent).toContain('Team');

    expect(
      document.body
        .querySelector<HTMLInputElement>(
          '[data-testid="share-plan-team-picker"] input[type="search"]',
        )
        ?.getAttribute('placeholder'),
    ).toBe('Search teams…');
    const teamButton = document.body.querySelector(
      '[data-testid="share-plan-team-picker-option-team-7"]',
    );
    await click(teamButton);
    await flush();

    expect(
      useCurrentUiStateStore.getState().slices['plans.shareModal'],
    ).toEqual({
      open: true,
      planId: 'plan-1',
      planTitle: 'My Plan',
      scope: 'team',
      busy: false,
      teamId: 'team-7',
    });

    await click(
      document.body.querySelector('[data-testid="share-plan-submit"]'),
    );
    await flush();

    expect(shareTrackedPlanMock).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'plan-1',
      { shareScope: 'team', teamId: 'team-7' },
    );
    // A completed share keeps the dialog open on its success notice, naming
    // the audience, and raises no toast.
    expect(addToastMock).not.toHaveBeenCalled();
    expect(
      document.body.querySelector('[data-testid="share-plan-modal"]'),
    ).not.toBeNull();
    expect(
      document.body.querySelector('[data-testid="share-plan-success"]')
        ?.textContent,
    ).toContain('Plan shared with Team Seven');

    // Done closes the dialog.
    await click(document.body.querySelector('[data-testid="share-plan-done"]'));
    await flush();
    expect(
      document.body.querySelector('[data-testid="share-plan-modal"]'),
    ).toBeNull();
    expect(addToastMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('keeps a rejected modal share error inline without an error toast', async () => {
    shareTrackedPlanMock.mockRejectedValue(new Error('no plans-crud-v1'));
    const { container, cleanup } = render(<PlansSection />);
    await flush();

    await click(
      container.querySelector('[data-testid="activity-plan-plan-1-share"]'),
    );
    await flush();
    await click(
      document.body.querySelector(
        '[data-testid="share-plan-team-picker-option-team-7"]',
      ),
    );
    await flush();
    await click(
      document.body.querySelector('[data-testid="share-plan-submit"]'),
    );
    await flush();

    expect(shareTrackedPlanMock).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'plan-1',
      { shareScope: 'team', teamId: 'team-7' },
    );
    expect(addToastMock).not.toHaveBeenCalled();
    expect(
      document.body.querySelector('[data-testid="share-plan-error"]')
        ?.textContent,
    ).toContain('Failed to share plan. no plans-crud-v1');
    cleanup();
  });
});

describe('PlansSection empty state and import entry', () => {
  const EMPTY_COPY =
    'Plans your agent writes appear here. Import a Markdown plan to review it, comment on it, and hand it to an agent.';

  function detected(
    id: string,
    status: 'detected' | 'dismissed' | 'imported',
  ): DetectedPlanEntry {
    return {
      id,
      sourceRepoId: 'repo-1',
      sourceFilePath: `plans/${id}.md`,
      status,
      bannerSeen: false,
      detectedInChatId: 'chat-1',
      detectedAt: '2026-06-01T00:00:00.000Z',
    };
  }

  beforeEach(() => {
    useActivityStore.setState({ trackedPlans: { [KEY]: [] } });
  });

  it('explains plans and import when the worktree has none', async () => {
    const { container, cleanup } = render(<PlansSection />);
    await flush();

    expect(
      container.querySelector('[data-testid="activity-plans-empty"]')
        ?.textContent,
    ).toBe(EMPTY_COPY);
    expect(
      container.querySelector(
        '[data-testid="activity-plans-suggestions-chip"]',
      ),
    ).toBeNull();
    cleanup();
  });

  it.each(['body-only', 'frameless'] as const)(
    'shows the explanation in %s chrome',
    async (chrome) => {
      const { container, cleanup } = render(
        <ActivitySectionChromeContext.Provider value={chrome}>
          <PlansSection />
        </ActivitySectionChromeContext.Provider>,
      );
      await flush();

      expect(
        container.querySelector('[data-testid="activity-plans-empty"]')
          ?.textContent,
      ).toBe(EMPTY_COPY);
      cleanup();
    },
  );

  it('loads detected plans for the worktree and counts only pending ones', async () => {
    useActivityStore.setState({
      detectedPlans: {
        [KEY]: [
          detected('a', 'detected'),
          detected('b', 'detected'),
          detected('c', 'dismissed'),
          detected('d', 'imported'),
        ],
      },
    });
    const { container, cleanup } = render(<PlansSection />);
    await flush();

    expect(useActivityStore.getState().loadDetectedPlans).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
    );
    const chip = container.querySelector(
      '[data-testid="activity-plans-suggestions-chip"]',
    );
    expect(chip?.textContent).toBe('2 found in chats');
    await click(chip);
    expect(useActivityStore.getState().openImportModal).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    cleanup();
  });

  it('waits for the tracked plans before reading detected ones', async () => {
    useActivityStore.setState({
      trackedPlans: {},
      trackedPlanInventoryLoaded: {},
    });
    const { cleanup } = render(<PlansSection />);
    await flush();

    // Until the inventory says the worktree is empty, the chip cannot show.
    expect(
      useActivityStore.getState().loadDetectedPlans,
    ).not.toHaveBeenCalled();
    cleanup();
  });

  it('names the header import button', async () => {
    useActivityStore.setState({ trackedPlans: { [KEY]: [makePlan()] } });
    const { container, cleanup } = render(<PlansSection />);
    await flush();

    // The suggestions chip only shows in the empty state, so a worktree with
    // plans skips the detected-plans read.
    expect(
      useActivityStore.getState().loadDetectedPlans,
    ).not.toHaveBeenCalled();

    expect(
      container
        .querySelector('[data-testid="activity-plans-import"]')
        ?.getAttribute('aria-label'),
    ).toBe('Import plan');
    cleanup();
  });

  it('shows only the first sentence in a read-only scope', async () => {
    useActivityStore.setState({
      trackedPlans: {},
      detectedPlans: { [KEY]: [detected('a', 'detected')] },
    });
    const { container, cleanup } = render(
      <WorkspaceAccessContext.Provider
        value={{
          mode: 'read-only',
          reason: 'shared-container',
          containerType: 'CODE_WORKTREE',
          runAllowed: false,
        }}
      >
        <PanelWorktreeContext.Provider
          value={{ projectId: PROJECT_ID, worktreeId: WORKTREE_ID }}
        >
          <ActivitySectionChromeContext.Provider value="body-only">
            <PlansSection />
          </ActivitySectionChromeContext.Provider>
        </PanelWorktreeContext.Provider>
      </WorkspaceAccessContext.Provider>,
    );
    await flush();

    expect(
      container.querySelector('[data-testid="activity-plans-empty"]')
        ?.textContent,
    ).toBe('Plans your agent writes appear here.');
    expect(
      container.querySelector('[data-testid="activity-plans-import"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="activity-plans-suggestions-chip"]',
      ),
    ).toBeNull();
    expect(
      useActivityStore.getState().loadDetectedPlans,
    ).not.toHaveBeenCalled();
    cleanup();
  });

  it('names the source file on an imported plan card', async () => {
    useActivityStore.setState({
      trackedPlans: {
        [KEY]: [
          makePlan({
            source: 'imported',
            sourceRepoId: 'repo-1',
            sourceFilePath: 'docs/rollout.md',
          }),
          makePlan({ id: 'plan-2' }),
        ],
      },
    });
    const { container, cleanup } = render(<PlansSection />);
    await flush();

    const provenance = container.querySelectorAll(
      '[data-testid="plan-provenance"]',
    );
    expect(provenance).toHaveLength(1);
    expect(provenance[0]?.textContent).toBe('Imported · docs/rollout.md');
    expect(provenance[0]?.getAttribute('title')).toBe('docs/rollout.md');
    cleanup();
  });
});

describe('PlansSection opens a plan in its Plan panel', () => {
  const REF = {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    planId: 'plan-1',
  };

  it('opens the plan from its row without navigating', async () => {
    const { container, cleanup } = render(<PlansSection />);
    await flush();

    await click(
      container.querySelector('[data-testid="activity-plan-row-plan-1"]'),
    );

    expect(openTrackedPlanMock).toHaveBeenCalledTimes(1);
    expect(openTrackedPlanMock).toHaveBeenCalledWith(REF, { navigate: false });
    cleanup();
  });

  it('opens the plan from Explore without also opening it from the row', async () => {
    const { container, cleanup } = render(<PlansSection />);
    await flush();

    await click(
      container.querySelector('[data-testid="activity-plan-plan-1-explore"]'),
    );

    expect(openTrackedPlanMock).toHaveBeenCalledTimes(1);
    expect(openTrackedPlanMock).toHaveBeenCalledWith(REF, { navigate: false });
    cleanup();
  });

  it('opens a hidden plan from its row', async () => {
    const hiddenPlan = makePlan({ id: 'plan-hidden', hidden: true });
    useActivityStore.setState({
      trackedPlans: { [KEY]: [makePlan(), hiddenPlan] },
    });
    const { container, cleanup } = render(<PlansSection />);
    await flush();

    await click(
      container.querySelector('[data-testid="activity-plans-hidden-toggle"]'),
    );
    await click(
      container.querySelector('[data-testid="activity-plan-row-plan-hidden"]'),
    );

    expect(openTrackedPlanMock).toHaveBeenCalledWith(
      { ...REF, planId: 'plan-hidden' },
      { navigate: false },
    );
    cleanup();
  });

  it('shows no plan-chat activity badge on the card', async () => {
    // Plan discussion happens in the worktree's ordinary chats; a legacy
    // plan chat's state never badges the card.
    useChatStore.setState({
      worktreeChats: {
        [`${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-1`]: {
          activeTabId: 'legacy-tab',
          tabs: [{ ...makeChatTab('legacy-tab'), status: 'streaming' }],
        },
      },
    });
    const { container, cleanup } = render(<PlansSection />);
    await flush();

    expect(
      container.querySelector('[data-testid="activity-plan-thinking-plan-1"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="activity-plan-unread-plan-1"]'),
    ).toBeNull();
    cleanup();
  });
});

describe('PlansSection pipeline execution', () => {
  it.each([1, 2])(
    'blocks an open workflow confirmation while chat admission is pending on current revision %s',
    async (revision) => {
      let finishSend: (() => void) | undefined;
      const dispatchChatCommand = jest.fn(
        () =>
          new Promise<'accepted'>((resolve) => {
            finishSend = (): void => resolve('accepted');
          }),
      );
      useChatStore.setState({
        dispatchChatCommand,
        switchTab: jest.fn(),
        worktreeChats: {
          [KEY]: {
            tabs: [makeChatTab('owning-chat')],
            activeTabId: 'owning-chat',
          },
        },
      });
      const { container, cleanup } = render(<PlansSection />);
      await flush();
      await click(
        container.querySelector('[data-testid="activity-plan-plan-1-execute"]'),
      );
      await click(
        document.body.querySelector(
          '[data-testid="activity-plan-plan-1-execute-pipeline"]',
        ),
      );
      let pending: Promise<{ chatId: string }> | undefined;
      const execute = jest.spyOn(window.pipelines, 'execute');
      try {
        const currentPlan = makePlan({
          reviewStatus: 'approved',
          latestRevisionNumber: revision,
        });
        await act(async () => {
          useActivityStore.setState({ trackedPlans: { [KEY]: [currentPlan] } });
          pending = implementTrackedPlan(currentPlan);
          await Promise.resolve();
        });
        await flush();
        await click(
          container.querySelector(
            '[data-testid="activity-plan-plan-1-execute"]',
          ),
        );
        for (const action of ['implement', 'pipeline']) {
          expect(
            document.body
              .querySelector(
                `[data-testid="activity-plan-plan-1-execute-${action}"]`,
              )
              ?.getAttribute('disabled'),
          ).not.toBeNull();
        }
        await click(
          document.body.querySelector('[data-testid="mock-plan-ready-run"]'),
        );
        expect(execute).not.toHaveBeenCalled();
      } finally {
        finishSend?.();
        await act(async () => {
          await pending;
        });
        execute.mockRestore();
        cleanup();
      }
    },
  );

  it("opens a plan's run in its own panel with the plan owner as the hint", async () => {
    usePipelineRunsStore.setState({
      summaries: [
        {
          id: 'run-7',
          pipeline_id: 'pipeline-1',
          pipeline_name: 'Plan pipeline',
          status: 'running',
          status_reasons: [],
          started_at: '2026-06-01T00:00:00.000Z',
          cwd: '/repo',
          planId: 'plan-1',
          project_id: PROJECT_ID,
          worktree_id: WORKTREE_ID,
        },
      ],
    });
    const { container, cleanup } = render(<PlansSection />);
    await flush();

    await click(
      container.querySelector('[data-testid="activity-plan-execution-plan-1"]'),
    );

    expect(openPipelineExecutionFromUiMock).toHaveBeenCalledWith({
      executionId: 'run-7',
      owner: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    });
    cleanup();
  });

  it('forwards configured plan_ready inputs from the tracked plan execute menu', async () => {
    const { container, cleanup } = render(<PlansSection />);
    await flush();

    await click(
      container.querySelector('[data-testid="activity-plan-plan-1-execute"]'),
    );
    await click(
      document.body.querySelector(
        '[data-testid="activity-plan-plan-1-execute-pipeline"]',
      ),
    );
    await click(
      document.body.querySelector('[data-testid="mock-plan-ready-run"]'),
    );
    await flush();

    const executePipelineMock = Reflect.get(
      window.pipelines,
      'execute',
    ) as jest.Mock;
    expect(executePipelineMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cwd: '/repo',
        pipelineId: 'pipeline-1',
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        planId: 'plan-1',
        eventName: 'plan_ready',
        eventData: {
          plan_ready: { plan_text: '# My Plan\n\nBody' },
        },
        inputs: {
          continue_on_refine_gate_fail: 'true',
          continue_on_plan_contract_fail: 'true',
        },
        modelConfig: { fastMode: true },
      }),
    );

    cleanup();
  });
});

describe('PlansSection Implement follow-up targets the owning worktree (correction 22)', () => {
  function chatTab(id: string, overrides: Partial<ChatTab> = {}): ChatTab {
    return { ...makeChatTab(id), ...overrides };
  }

  it("sends the follow-up to the plan's worktree chat, not the selected worktree", async () => {
    // The listed plan belongs to wt-1 while the global selection is another
    // worktree, as for a plan list rendered for a scope other than the
    // selection. The follow-up must follow the plan.
    const dispatchChatCommand = jest
      .fn<Promise<'accepted'>, [unknown, unknown]>()
      .mockResolvedValue('accepted');
    const otherKey = `${PROJECT_ID}/wt-other`;
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: 'wt-other' },
      dispatchChatCommand,
      switchTab: jest.fn(),
      worktreeChats: {
        [otherKey]: {
          tabs: [chatTab('other-chat')],
          activeTabId: 'other-chat',
        },
        [KEY]: { tabs: [chatTab('owning-chat')], activeTabId: 'owning-chat' },
      },
    });
    useActivityStore.setState({ trackedPlans: { [otherKey]: [makePlan()] } });

    const { container, cleanup } = render(<PlansSection />);
    await flush();

    await click(
      container.querySelector('[data-testid="activity-plan-plan-1-execute"]'),
    );
    await click(
      document.body.querySelector(
        '[data-testid="activity-plan-plan-1-execute-implement"]',
      ),
    );
    await flush();
    await flush();

    expect(addToastMock).not.toHaveBeenCalled();
    expect(dispatchChatCommand).toHaveBeenCalledTimes(1);
    const scope: unknown = dispatchChatCommand.mock.calls[0]?.[0];
    const command: unknown = dispatchChatCommand.mock.calls[0]?.[1];
    expect(scope).toEqual({ projectId: PROJECT_ID, worktreeId: WORKTREE_ID });
    expect(command).toMatchObject({
      type: 'chat.send_message',
      chatId: 'owning-chat',
      text: 'Implement this plan:\n\n# My Plan\n\nBody',
      trackedPlanImplementation: { planId: 'plan-1', revisionNumber: 1 },
    });
    cleanup();
  });
});

describe('PlansSection status (CAN-5166)', () => {
  function runSummary(
    id: string,
    status: ExecutionSummary['status'],
  ): ExecutionSummary {
    return {
      id,
      pipeline_id: 'pipeline-1',
      pipeline_name: `Pipeline ${id}`,
      status,
      status_reasons: [],
      started_at: '2026-06-02T00:00:00.000Z',
      cwd: '/repo',
      planId: 'plan-1',
    };
  }

  function byTestId(id: string): HTMLElement | null {
    return document.body.querySelector(`[data-testid="${id}"]`);
  }

  function executeIsPrimary(): boolean {
    return (
      byTestId('activity-plan-plan-1-execute')?.className.includes(
        'bg-accent',
      ) ?? false
    );
  }

  beforeEach(() => {
    revealWorktreeChatPanelMock.mockClear();
  });

  it.each(['idle', 'fresh'] as const)(
    'disables Activity execution during revision and recovers on %s (CAN-5431)',
    async (recovery) => {
      const updateChat = (
        status: ChatTab['status'],
        pendingPlanExit?: ChatTab['pendingPlanExit'],
      ): void => {
        act(() =>
          useChatStore.setState({
            worktreeChats: {
              [KEY]: {
                activeTabId: 'revision-chat',
                tabs: [
                  {
                    ...makeChatTab('revision-chat'),
                    trackedPlanId: 'plan-1',
                    trackedPlanReviewStatus: 'pending',
                    status,
                    pendingPlanExit,
                  },
                ],
              },
            },
          }),
        );
      };
      updateChat('streaming');
      const { cleanup } = render(<PlansSection />);
      try {
        await flush();
        await click(byTestId('activity-plan-plan-1-execute'));
        for (const action of ['implement', 'pipeline'])
          expect(
            byTestId(`activity-plan-plan-1-execute-${action}`)?.hasAttribute(
              'disabled',
            ),
          ).toBe(true);
        // An already-open menu updates as canonical state settles.
        updateChat(
          recovery === 'idle' ? 'idle' : 'streaming',
          recovery === 'fresh' ? { plan: '# v2' } : undefined,
        );
        await flush();
        for (const action of ['implement', 'pipeline'])
          expect(
            byTestId(`activity-plan-plan-1-execute-${action}`)?.hasAttribute(
              'disabled',
            ),
          ).toBe(false);
      } finally {
        cleanup();
      }
    },
  );

  it('shows Pending with primary Execute', async () => {
    const { cleanup } = render(<PlansSection />);
    await flush();

    expect(byTestId('activity-plan-status-plan-1')?.textContent).toBe(
      'Pending',
    );
    expect(executeIsPrimary()).toBe(true);
    cleanup();
  });

  it('demotes Execute when the store records the approval', async () => {
    const { cleanup } = render(<PlansSection />);
    await flush();

    act(() => {
      useActivityStore
        .getState()
        .commitTrackedPlanUpdate(makePlan({ reviewStatus: 'approved' }));
    });

    expect(byTestId('activity-plan-status-plan-1')?.textContent).toBe(
      'Approved',
    );
    expect(executeIsPrimary()).toBe(false);
    cleanup();
  });

  it('shows Implementing for a running linked run', async () => {
    useActivityStore.setState({
      trackedPlans: { [KEY]: [makePlan({ reviewStatus: 'approved' })] },
    });
    usePipelineRunsStore.setState({
      summaries: [runSummary('run-7', 'paused')],
    });
    const { cleanup } = render(<PlansSection />);
    await flush();

    expect(byTestId('activity-plan-status-plan-1')?.textContent).toBe(
      'Implementing in workflow',
    );
    expect(byTestId('activity-plan-plan-1-execute')).toBeNull();
    expect(byTestId('activity-plan-status-plan-1-spinner')).not.toBeNull();
    await click(byTestId('activity-plan-plan-1-open'));
    expect(openPipelineExecutionFromUiMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'run-7' }),
    );
    cleanup();
  });

  it.each([
    ['failure', 'success', 'Approved'],
    ['success', 'failure', 'Implemented in workflow'],
  ] as const)(
    'uses the root %s outcome instead of its nested %s outcome',
    async (rootStatus, childStatus, expectedLabel) => {
      useActivityStore.setState({
        trackedPlans: {
          [KEY]: [
            makePlan({
              reviewStatus: 'approved',
              linkedExecutionIds: ['root-run', 'child-run'],
            }),
          ],
        },
      });
      usePipelineRunsStore.setState({
        summaries: [
          runSummary('root-run', rootStatus),
          {
            ...runSummary('child-run', childStatus),
            started_at: '2026-06-02T01:00:00.000Z',
            parent_execution_id: 'root-run',
          },
        ],
      });
      const { cleanup } = render(<PlansSection />);
      await flush();

      expect(byTestId('activity-plan-status-plan-1')?.textContent).toBe(
        expectedLabel,
      );
      expect(
        byTestId('activity-plan-status-note-plan-1')?.textContent ?? null,
      ).toBe(rootStatus === 'failure' ? 'Workflow failed·View run' : null);
      // An outcome link or Open already reaches the run.
      expect(byTestId('activity-plan-execution-plan-1')).toBeNull();
      await click(
        byTestId(
          rootStatus === 'failure'
            ? 'activity-plan-status-note-run-plan-1'
            : 'activity-plan-plan-1-open',
        ),
      );
      expect(openPipelineExecutionFromUiMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ executionId: 'root-run' }),
      );
      cleanup();
    },
  );

  it('reports a failed run and opens it from View run', async () => {
    useActivityStore.setState({
      trackedPlans: {
        [KEY]: [
          makePlan({ reviewStatus: 'approved', linkedExecutionIds: ['run-7'] }),
        ],
      },
    });
    usePipelineRunsStore.setState({
      summaries: [runSummary('run-7', 'failure')],
    });
    const { cleanup } = render(<PlansSection />);
    await flush();

    expect(byTestId('activity-plan-status-plan-1')?.textContent).toBe(
      'Approved',
    );
    expect(byTestId('activity-plan-status-note-plan-1')?.textContent).toBe(
      'Workflow failed·View run',
    );
    expect(byTestId('activity-plan-execution-plan-1')).toBeNull();
    await click(byTestId('activity-plan-status-note-run-plan-1'));
    expect(openPipelineExecutionFromUiMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'run-7' }),
    );
    expect(openTrackedPlanMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('opens the newest active attempt regardless of collection order or a later failed retry', async () => {
    useActivityStore.setState({
      trackedPlans: { [KEY]: [makePlan({ reviewStatus: 'approved' })] },
    });
    usePipelineRunsStore.setState({
      summaries: [
        {
          ...runSummary('old', 'running'),
          started_at: '2026-06-02T01:00:00.000Z',
        },
        {
          ...runSummary('new', 'paused'),
          started_at: '2026-06-02T02:00:00.000Z',
        },
        {
          ...runSummary('failed', 'failure'),
          started_at: '2026-06-02T03:00:00.000Z',
        },
      ],
    });
    const { cleanup } = render(<PlansSection />);
    await flush();
    await click(byTestId('activity-plan-plan-1-open'));
    expect(openPipelineExecutionFromUiMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'new' }),
    );
    cleanup();
  });

  describe('linked chat implementation (CAN-5359)', () => {
    const link = {
      planId: 'plan-1',
      revisionNumber: 1,
      userMessageId: 'implement-1',
      startedAt: '2026-06-02T00:00:00.000Z',
    };

    function linkedTab(id: string, overrides: Partial<ChatTab> = {}): ChatTab {
      return {
        ...makeChatTab(id),
        trackedPlanId: 'plan-1',
        trackedPlanImplementation: link,
        ...overrides,
      };
    }

    function setChat(
      tabs: ChatTab[],
      runtime: Record<string, ChatRuntimeState['status']> = {},
    ): void {
      useActivityStore.setState({
        trackedPlans: { [KEY]: [makePlan({ reviewStatus: 'approved' })] },
      });
      useChatStore.setState({
        worktreeChats: { [KEY]: { tabs, activeTabId: tabs[0]?.id ?? '' } },
        runtimeByChatId: Object.fromEntries(
          Object.entries(runtime).map(([chatId, status]) => [
            chatId,
            {
              status,
              queuedMessageIds: [],
              activeTurn: { userMessageId: 'implement-1', startedAt: 1 },
            },
          ]),
        ),
      });
    }

    it('shows Implementing in chat with Open while the linked turn runs, and opens that chat', async () => {
      setChat(
        [
          linkedTab('newer-chat', { trackedPlanImplementation: undefined }),
          linkedTab('linked-chat'),
        ],
        { 'linked-chat': 'streaming' },
      );
      const { cleanup } = render(<PlansSection />);
      await flush();

      expect(byTestId('activity-plan-status-plan-1')?.textContent).toBe(
        'Implementing in chat',
      );
      expect(byTestId('activity-plan-status-plan-1-spinner')).not.toBeNull();
      expect(byTestId('activity-plan-plan-1-execute')).toBeNull();
      expect(byTestId('activity-plan-status-note-chat-plan-1')).toBeNull();
      await click(byTestId('activity-plan-plan-1-more'));
      for (const action of ['pipeline', 'implement']) {
        expect(
          byTestId(`activity-plan-plan-1-execute-${action}`)?.hasAttribute(
            'disabled',
          ),
        ).toBe(true);
      }
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      act(() => {
        byTestId('activity-plan-plan-1-open')?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
      expect(openTrackedPlanMock).not.toHaveBeenCalled();
      await click(byTestId('activity-plan-plan-1-open'));
      expect(revealWorktreeChatPanelMock).toHaveBeenCalledWith(
        { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
        'linked-chat',
      );
      cleanup();
    });

    it('shows Finished in chat once main settles the link, with retries in the overflow menu', async () => {
      setChat([
        linkedTab('linked-chat', {
          trackedPlanImplementation: {
            ...link,
            outcome: 'completed',
            endedAt: '2026-06-02T00:05:00.000Z',
          },
        }),
      ]);
      const { cleanup } = render(<PlansSection />);
      await flush();

      expect(byTestId('activity-plan-status-plan-1')?.textContent).toBe(
        'Finished in chat',
      );
      expect(byTestId('activity-plan-status-plan-1-spinner')).toBeNull();
      await click(byTestId('activity-plan-plan-1-more'));
      expect(
        byTestId('activity-plan-plan-1-execute-implement')?.textContent,
      ).toBe('Implement again in chat');
      expect(
        byTestId('activity-plan-plan-1-execute-pipeline')?.textContent,
      ).toBe('Run again as workflow');
      cleanup();
    });

    it.each([
      ['failed', 'Chat failed·View chat'],
      ['cancelled', 'Chat stopped·View chat'],
    ] as const)(
      'keeps Approved and Execute for a sole %s attempt',
      async (outcome, note) => {
        setChat([
          linkedTab('linked-chat', {
            turnEnds: { 'implement-1': { outcome, endedAt: 1 } },
          }),
        ]);
        const { cleanup } = render(<PlansSection />);
        await flush();

        expect(byTestId('activity-plan-status-plan-1')?.textContent).toBe(
          'Approved',
        );
        expect(byTestId('activity-plan-status-note-plan-1')?.textContent).toBe(
          note,
        );
        expect(byTestId('activity-plan-plan-1-execute')).not.toBeNull();
        expect(byTestId('activity-plan-plan-1-open')).toBeNull();
        cleanup();
      },
    );

    it('does not claim implementation for an unrelated active turn or an idle link', async () => {
      setChat([linkedTab('linked-chat')], { 'linked-chat': 'streaming' });
      useChatStore.setState({
        runtimeByChatId: {
          'linked-chat': {
            status: 'streaming',
            queuedMessageIds: [],
            activeTurn: { userMessageId: 'follow-up', startedAt: 1 },
          },
        },
      });
      const { cleanup } = render(<PlansSection />);
      await flush();

      expect(byTestId('activity-plan-status-plan-1')?.textContent).toBe(
        'Approved',
      );
      expect(byTestId('activity-plan-plan-1-execute')).not.toBeNull();
      cleanup();
    });
  });

  it("reveals the plan's tracking chat from View chat", async () => {
    useActivityStore.setState({
      trackedPlans: { [KEY]: [makePlan({ reviewStatus: 'approved' })] },
    });
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [{ ...makeChatTab('chat-1'), trackedPlanId: 'plan-1' }],
          activeTabId: 'chat-1',
        },
      },
    });
    const { cleanup } = render(<PlansSection />);
    await flush();

    await click(byTestId('activity-plan-status-note-chat-plan-1'));
    expect(revealWorktreeChatPanelMock).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      'chat-1',
    );
    expect(openTrackedPlanMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('shows the status but no navigation notes when read-only', async () => {
    const viewerKey = `${SHARED_CONTAINER_VIEWER_PROJECT_ID}/container-1`;
    useActivityStore.setState({
      trackedPlans: {
        [viewerKey]: [
          makePlan({
            projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
            worktreeId: 'container-1',
            reviewStatus: 'approved',
          }),
        ],
      },
    });
    usePipelineRunsStore.setState({
      summaries: [runSummary('run-7', 'failure')],
    });
    const { cleanup } = render(
      <WorkspaceAccessContext.Provider
        value={{
          mode: 'read-only',
          reason: 'shared-container',
          containerType: 'CODE_WORKTREE',
          runAllowed: false,
        }}
      >
        <PanelWorktreeContext.Provider
          value={{
            projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
            worktreeId: 'container-1',
          }}
        >
          <PlansSection />
        </PanelWorktreeContext.Provider>
      </WorkspaceAccessContext.Provider>,
    );
    await flush();

    expect(byTestId('activity-plan-status-plan-1')?.textContent).toBe(
      'Approved',
    );
    expect(byTestId('activity-plan-status-note-plan-1')).toBeNull();
    cleanup();
  });
});

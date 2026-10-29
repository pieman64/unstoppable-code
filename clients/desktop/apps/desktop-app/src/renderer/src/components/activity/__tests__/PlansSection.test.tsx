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
            info: { id: 'pipeline-1', source: 'bundled' },
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
const openPipelineExecutionFromUiMock = jest.fn(() =>
  Promise.resolve({ status: 'applied' }),
);
jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionFromUi: (request: unknown): Promise<unknown> =>
    openPipelineExecutionFromUiMock(request),
}));

jest.mock('../PlanSourceMark', () => ({
  PlanSourceMark: (): null => null,
}));
jest.mock('@/lib/plans/open-tracked-plan', () => ({
  openTrackedPlan: jest.fn().mockResolvedValue({ status: 'placed' }),
}));

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
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
    modelConfig: { thinkingLevel: 'high', fastMode: false },
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
          update: jest.fn().mockResolvedValue(undefined),
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
      const copy = document.querySelector(
        '[data-testid="activity-plan-plan-1-execute-copy"]',
      );
      expect(copy instanceof HTMLButtonElement && !copy.disabled).toBe(true);
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
              sharedAt: '2026-09-24T20:00:00.000Z',
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
    ['error', 'Retry share'],
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
      expect(shareBtn?.textContent).not.toContain('Retry');

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
    // A completed share closes the dialog and raises exactly one toast: the
    // dialog's own, naming the audience. The host adds none of its own.
    expect(addToastMock).toHaveBeenCalledTimes(1);
    expect(addToastMock).toHaveBeenCalledWith(
      'Plan shared with Team Seven',
      'success',
      undefined,
      expect.objectContaining({ forceInApp: true }),
    );
    expect(
      document.body.querySelector('[data-testid="share-plan-modal"]'),
    ).toBeNull();
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
  it("opens a plan's run in its own panel with the plan owner as the hint", async () => {
    usePipelineRunsStore.setState({
      summaries: [
        {
          id: 'run-7',
          pipeline_id: 'pipeline-1',
          pipeline_name: 'Plan pipeline',
          status: 'running',
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
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    const otherKey = `${PROJECT_ID}/wt-other`;
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: 'wt-other' },
      sendMessage,
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
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'Implement this plan:\n\n# My Plan\n\nBody',
      undefined,
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID, chatId: 'owning-chat' },
      undefined,
      expect.objectContaining({ throwOnDispatchFailure: true }),
    );
    cleanup();
  });
});

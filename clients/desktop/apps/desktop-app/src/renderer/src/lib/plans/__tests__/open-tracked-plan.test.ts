/** @jest-environment jsdom */

/**
 * The tracked-plan opener, against the REAL navigation, chat, projects,
 * activity, and toast stores with their navigation/toast actions stubbed.
 * The plan panel opener, chat hydration wait, and viewer dismissal are
 * mocked so each test can read the exact call order.
 */
import {
  APP_ADVISOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type SidebarItem,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import type { ContentPanelOpenResult } from '@/lib/panels/chat-panel-sync';
import {
  openPlanPanel,
  planPanelOriginForWorktree,
} from '@/lib/panels/plan-panel-open';
import { useActivityStore } from '@/stores/activityStore';
import type * as HydrationModule from '@/stores/chat/hydration';
import { waitForWorktreeHydration } from '@/stores/chat/hydration';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  useNavigationStore,
  type NavigationPage,
} from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  openPendingPlanExit,
  openTrackedPlan,
  type OpenTrackedPlanResult,
  type PendingPlanExitRef,
  type TrackedPlanRef,
} from '../open-tracked-plan';

jest.mock('@/lib/panels/plan-panel-open', () => ({
  openPlanPanel: jest.fn(),
  planPanelOriginForWorktree: jest.fn(),
}));

jest.mock('@/stores/chat/hydration', () => ({
  ...jest.requireActual<typeof HydrationModule>('@/stores/chat/hydration'),
  waitForWorktreeHydration: jest.fn(),
}));

jest.mock('@/lib/dismissPageLikeViewers', () => ({
  dismissPageLikeViewers: jest.fn(),
}));

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const REF: TrackedPlanRef = {
  projectId: PROJECT_ID,
  worktreeId: WORKTREE_ID,
  planId: 'plan-1',
};
const SCOPE = { projectId: PROJECT_ID, worktreeId: WORKTREE_ID };
const PLACED: ContentPanelOpenResult = {
  status: 'placed',
  location: {
    layoutKey: KEY,
    groupId: 'group-1',
    panelId: 'panel-plan-plan-1',
  },
};

const PROJECTS: SidebarItem[] = [
  {
    type: 'single-repo',
    id: PROJECT_ID,
    name: 'Project',
    repoPath: '/repos/project',
    color: 'blue',
    collapsed: false,
    order: 0,
    worktrees: [
      {
        id: WORKTREE_ID,
        branchName: 'main',
        createdAt: '2026-06-01T00:00:00Z',
      },
      { id: 'wt-2', branchName: 'other', createdAt: '2026-06-01T00:00:00Z' },
    ],
  },
];

const initialNavigationState = useNavigationStore.getState();
const initialChatState = useChatStore.getState();
const initialProjectsState = useProjectsStore.getState();
const initialGitHubState = useGitHubStore.getState();
const initialActivityState = useActivityStore.getState();

const openPlanPanelMock = jest.mocked(openPlanPanel);
const originMock = jest.mocked(planPanelOriginForWorktree);
const waitMock = jest.mocked(waitForWorktreeHydration);
const dismissMock = jest.mocked(dismissPageLikeViewers);

let order: string[];
let addToast: jest.Mock;
let getPlan: jest.Mock;
let createPlan: jest.Mock;

function makePlan(overrides: Partial<TrackedPlanData> = {}): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    source: 'claude',
    title: 'Importer plan',
    content: '# Importer plan',
    reviewStatus: 'pending',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
    ...overrides,
  };
}

function showPage(
  page: NavigationPage,
  selected: { projectId: string; worktreeId: string } | null,
): void {
  useNavigationStore.setState({ activePage: page });
  useChatStore.setState({ selectedWorktree: selected });
}

/** Every navigation step taken, in order (empty when none ran). */
function navigationSteps(): string[] {
  return order.filter((step) => step !== 'origin' && step !== 'open');
}

beforeEach(() => {
  order = [];
  dismissMock.mockImplementation((): void => {
    order.push('dismiss');
  });
  waitMock.mockImplementation((key: string): Promise<void> => {
    order.push(`wait:${key}`);
    return Promise.resolve();
  });
  // The default origin is the owner's active chat, known only once it is
  // selected: answer only for the selected owner.
  originMock.mockImplementation((key: string) => {
    order.push('origin');
    const selected = useChatStore.getState().selectedWorktree;
    return selected !== null &&
      `${selected.projectId}/${selected.worktreeId}` === key
      ? { chatTabId: 'chat-active' }
      : undefined;
  });
  openPlanPanelMock.mockImplementation((): Promise<ContentPanelOpenResult> => {
    order.push('open');
    return Promise.resolve(PLACED);
  });
  useNavigationStore.setState({
    navigate: jest.fn((page: NavigationPage): void => {
      order.push(`navigate:${page}`);
      useNavigationStore.setState({ activePage: page });
    }),
  });
  useChatStore.setState({
    loadTabsForTarget: jest.fn(
      (projectId: string, worktreeId: string): Promise<void> => {
        order.push(`load:${projectId}/${worktreeId}`);
        return Promise.resolve();
      },
    ),
    selectWorktree: jest.fn((projectId: string, worktreeId: string): void => {
      order.push(`select:${projectId}/${worktreeId}`);
      useChatStore.setState({ selectedWorktree: { projectId, worktreeId } });
    }),
  });
  useProjectsStore.setState({ projects: PROJECTS, hasHydratedProjects: true });
  addToast = jest.fn();
  useGitHubStore.setState({ addToast });
  getPlan = jest.fn().mockResolvedValue(null);
  createPlan = jest.fn();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { activity: { plans: { get: getPlan, create: createPlan } } },
  });
  showPage('overview', null);
});

afterEach(() => {
  jest.clearAllMocks();
  useNavigationStore.setState(initialNavigationState, true);
  useChatStore.setState(initialChatState, true);
  useProjectsStore.setState(initialProjectsState, true);
  useGitHubStore.setState(initialGitHubState, true);
  useActivityStore.setState(initialActivityState, true);
});

describe('openTrackedPlan navigation', () => {
  test('from another page it brings up the owning worktree, then opens beside its active chat', async () => {
    const result = await openTrackedPlan(REF);

    expect(order).toEqual([
      'dismiss',
      'navigate:main',
      `load:${KEY}`,
      `wait:${KEY}`,
      `select:${KEY}`,
      'origin',
      'open',
    ]);
    expect(originMock).toHaveBeenCalledWith(KEY);
    expect(openPlanPanelMock).toHaveBeenCalledWith(SCOPE, 'plan-1', {
      origin: { chatTabId: 'chat-active' },
    });
    expect(result).toEqual(PLACED);
    expect(useNavigationStore.getState().activePage).toBe('main');
    expect(addToast).not.toHaveBeenCalled();
  });

  test('switches worktrees when the main page shows another one', async () => {
    showPage('main', { projectId: PROJECT_ID, worktreeId: 'wt-2' });

    await openTrackedPlan(REF);

    expect(navigationSteps()).toEqual([
      'dismiss',
      'navigate:main',
      `load:${KEY}`,
      `wait:${KEY}`,
      `select:${KEY}`,
    ]);
  });

  test('does not navigate when the owning worktree is already on screen, but closes a viewer covering it', async () => {
    showPage('main', SCOPE);

    const result = await openTrackedPlan(REF);

    // An archived or shared-container viewer can cover the main page while the
    // owner stays selected; the panel must not open beneath it.
    expect(navigationSteps()).toEqual(['dismiss']);
    expect(openPlanPanelMock).toHaveBeenCalledWith(SCOPE, 'plan-1', {
      origin: { chatTabId: 'chat-active' },
    });
    expect(result).toEqual(PLACED);
  });

  test('never navigates with navigate: false', async () => {
    const result = await openTrackedPlan(REF, { navigate: false });

    expect(navigationSteps()).toEqual([]);
    expect(useNavigationStore.getState().activePage).toBe('overview');
    // No worktree is selected, so there is no active chat to place beside.
    expect(openPlanPanelMock).toHaveBeenCalledWith(SCOPE, 'plan-1', {});
    expect(result).toEqual(PLACED);
  });

  test.each([
    ['an archived or deleted worktree', PROJECT_ID, 'wt-gone'],
    ['an unknown project', 'proj-gone', WORKTREE_ID],
  ])(
    'reports %s as worktree-unavailable without opening',
    async (_label, projectId, worktreeId) => {
      const result = await openTrackedPlan({
        projectId,
        worktreeId,
        planId: 'plan-1',
      });

      expect(result).toEqual({ status: 'worktree-unavailable' });
      expect(order).toEqual([]);
      expect(addToast).toHaveBeenCalledWith(
        "Couldn't open the plan. Its worktree is no longer available.",
        'error',
        undefined,
        { projectId, worktreeId },
      );
    },
  );

  test('a failed navigation resolves failed and reports it', async () => {
    useChatStore.setState({
      loadTabsForTarget: jest.fn(
        (): Promise<void> => Promise.reject(new Error('load failed')),
      ),
    });

    const result = await openTrackedPlan(REF);

    expect(result).toEqual({ status: 'failed' });
    expect(openPlanPanelMock).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(
      "Couldn't open the plan. Try again.",
      'error',
      undefined,
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    );
  });
});

describe('openTrackedPlan scopes', () => {
  const VIEWER_REF: TrackedPlanRef = {
    projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
    worktreeId: 'container-1',
    planId: 'plan-1',
  };

  test('opens a recipient plan in place without navigating', async () => {
    const result = await openTrackedPlan(VIEWER_REF, { navigate: false });

    expect(navigationSteps()).toEqual([]);
    expect(openPlanPanelMock).toHaveBeenCalledWith(
      {
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: 'container-1',
      },
      'plan-1',
      {},
    );
    expect(result).toEqual(PLACED);
  });

  test('never navigates to a recipient view', async () => {
    const result = await openTrackedPlan(VIEWER_REF);

    expect(result).toEqual({ status: 'worktree-unavailable' });
    expect(order).toEqual([]);
    expect(addToast).toHaveBeenCalledWith(
      "Couldn't open the plan. Its worktree is no longer available.",
      'error',
      undefined,
      {
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: 'container-1',
      },
    );
  });

  test.each([
    ['App Advisor', APP_ADVISOR_PROJECT_ID],
    ['Cowork', STANDALONE_CHAT_PROJECT_ID],
    ['the legacy plan chat', PLAN_EXPLORE_CHAT_PROJECT_ID],
  ])(
    'a %s scope has no plans: unavailable without navigating or opening',
    async (_label, projectId) => {
      const result = await openTrackedPlan({
        projectId,
        worktreeId: 'entry-1',
        planId: 'plan-1',
      });

      expect(result).toEqual({ status: 'unavailable' });
      expect(order).toEqual([]);
      expect(openPlanPanelMock).not.toHaveBeenCalled();
      expect(originMock).not.toHaveBeenCalled();
    },
  );
});

describe('openTrackedPlan origin and failures', () => {
  test('an explicit origin wins over the active chat', async () => {
    showPage('main', SCOPE);

    await openTrackedPlan(REF, { origin: { chatTabId: 'chat-origin' } });

    expect(originMock).not.toHaveBeenCalled();
    expect(openPlanPanelMock).toHaveBeenCalledWith(SCOPE, 'plan-1', {
      origin: { chatTabId: 'chat-origin' },
    });
  });

  test.each<[ContentPanelOpenResult, string]>([
    [{ status: 'unavailable' }, 'This plan is no longer available.'],
    [{ status: 'failed' }, "Couldn't open the plan. Try again."],
  ])('reports %o as an error toast', async (opened, message) => {
    openPlanPanelMock.mockResolvedValue(opened);

    const result = await openTrackedPlan(REF, { navigate: false });

    expect(result).toEqual(opened);
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(message, 'error', undefined, {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
  });

  test.each<[OpenTrackedPlanResult, ContentPanelOpenResult, TrackedPlanRef]>([
    [{ status: 'unavailable' }, { status: 'unavailable' }, REF],
    [{ status: 'failed' }, { status: 'failed' }, REF],
    [
      { status: 'worktree-unavailable' },
      PLACED,
      { ...REF, worktreeId: 'wt-gone' },
    ],
  ])(
    'reportFailure: false leaves %o to the caller',
    async (expected, opened, ref) => {
      openPlanPanelMock.mockResolvedValue(opened);

      const result = await openTrackedPlan(ref, { reportFailure: false });

      expect(result).toEqual(expected);
      expect(addToast).not.toHaveBeenCalled();
    },
  );
});

describe('openPendingPlanExit', () => {
  const EXIT: PendingPlanExitRef = {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    chatId: 'chat-7',
    source: 'claude',
    content: '# Pending plan',
  };

  test('opens an existing plan beside its chat without creating it', async () => {
    const plan = makePlan();
    getPlan.mockResolvedValue(plan);

    const result = await openPendingPlanExit(EXIT, 'plan-1');

    expect(getPlan).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      planId: 'plan-1',
    });
    expect(createPlan).not.toHaveBeenCalled();
    expect(useActivityStore.getState().trackedPlans[KEY]).toEqual([plan]);
    expect(navigationSteps()).toEqual([]);
    expect(openPlanPanelMock).toHaveBeenCalledWith(SCOPE, 'plan-1', {
      origin: { chatTabId: 'chat-7' },
    });
    expect(result).toEqual(PLACED);
  });

  test('creates a missing plan under the same id, then opens it', async () => {
    const created = makePlan({ content: '# Pending plan' });
    createPlan.mockResolvedValue(created);

    const result = await openPendingPlanExit(EXIT, 'plan-1');

    expect(createPlan).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      id: 'plan-1',
      source: 'claude',
      content: '# Pending plan',
      reviewStatus: 'pending',
      chatId: 'chat-7',
    });
    expect(useActivityStore.getState().trackedPlans[KEY]).toEqual([created]);
    expect(openPlanPanelMock).toHaveBeenCalledWith(SCOPE, 'plan-1', {
      origin: { chatTabId: 'chat-7' },
    });
    expect(result).toEqual(PLACED);
  });

  test('rejects without opening when the plan cannot be created', async () => {
    createPlan.mockRejectedValue(new Error('Disk full'));

    await expect(openPendingPlanExit(EXIT, 'plan-1')).rejects.toThrow(
      'Disk full',
    );
    expect(openPlanPanelMock).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });
});

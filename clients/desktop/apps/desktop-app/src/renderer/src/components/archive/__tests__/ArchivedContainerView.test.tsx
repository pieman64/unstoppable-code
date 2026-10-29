/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ArchivedChatSummary,
  ArchivedContainerRefreshPullRequestsResponse,
  ArchivedContainerSummary,
} from '@canopy/desktop-shared/types';
import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import type { CostScopeRowTarget } from '@canopy/ui-app/cost';
import { ArchivedContainerView } from '@/components/archive/ArchivedContainerView';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useExperimentalFeaturesStore } from '@/stores/experimentalFeaturesStore';

const mockRetainedCostViewProps: Array<{
  readonly scope?: CostScopeRef;
  readonly selectedRow?: CostScopeRowTarget | null;
  readonly onSelectRow?: (target: CostScopeRowTarget) => void;
}> = [];
jest.mock('@canopy/ui-app/cost', () => ({
  RetainedCostView: (props: {
    readonly scope?: CostScopeRef;
    readonly selectedRow?: CostScopeRowTarget | null;
    readonly onSelectRow?: (target: CostScopeRowTarget) => void;
  }): JSX.Element => {
    mockRetainedCostViewProps.push(props);
    return <div data-testid="mock-retained-cost-view" />;
  },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): unknown => ({
      loadProjects: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): unknown => ({
      loadChatProjects: jest.fn().mockResolvedValue(undefined),
      closeArchiveOverlay: jest.fn(),
      openWorkEntryFromSidebar: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('@/components/chat/ChatMessageList', () => ({
  ChatMessageList: ({
    chatId,
    pagingControls,
  }: {
    chatId: string;
    pagingControls?: ReactNode;
  }): JSX.Element => (
    <div data-testid="mock-chat-message-list">
      {pagingControls}
      {chatId}
    </div>
  ),
}));

// The Changes explorer is exercised by its own spec; here it only needs to
// prove mount/unmount behavior without hitting the paged transport.
jest.mock('@/components/archive/ArchivedChangesView', () => ({
  ArchivedChangesView: (): JSX.Element => (
    <div data-testid="mock-archived-changes-view" />
  ),
}));

const detailModalProps: Array<Record<string, unknown>> = [];
jest.mock('@/components/activity/PipelineExecutionDetailModal', () => ({
  PipelineExecutionDetailModal: (
    props: Record<string, unknown>,
  ): JSX.Element => {
    detailModalProps.push(props);
    return <div data-testid="mock-pipeline-detail-modal" />;
  },
}));

jest.mock('@/components/activity/DagProgressBar', () => ({
  DagProgressBar: (): JSX.Element => <div data-testid="mock-dag" />,
}));

jest.mock('@/components/shared/AttachmentPreviewPopover', () => ({
  AttachmentPreviewPopover: ({
    filename,
    onOpen,
  }: {
    filename?: string;
    onOpen?: () => void;
  }): JSX.Element => (
    <button type="button" data-testid="mock-attachment-open" onClick={onOpen}>
      Open {filename}
    </button>
  ),
}));

jest.mock('@/components/archive/ArchivedAttachmentViewer', () => ({
  ArchivedAttachmentViewer: ({
    attachment,
    onClose,
  }: {
    attachment: { filename: string };
    onClose: () => void;
  }): JSX.Element => (
    <div data-testid="mock-archived-attachment-viewer">
      {attachment.filename}
      <button type="button" onClick={onClose}>
        Back to attachments
      </button>
    </div>
  ),
}));

const navigateToRestoredMock = jest
  .fn<Promise<void>, unknown[]>()
  .mockResolvedValue(undefined);
jest.mock('@/lib/archivedContainerNavigation', () => ({
  navigateToRestoredContainerDestination: (...args: unknown[]): Promise<void> =>
    navigateToRestoredMock(...args),
  openArchivedContainerSurface: jest.fn(),
}));

jest.mock('@/lib/chatTabPersistence', () => ({
  hydratePersistedChatTab: (tab: {
    id: string;
    title?: string;
    messages?: unknown[];
    transcriptLoaded?: boolean;
    transcriptWindow?: unknown;
  }): unknown => ({
    ...tab,
    id: tab.id,
    title: tab.title ?? 'Hydrated chat',
    messages: tab.messages ?? [],
    agentUsage: undefined,
    turnDiffs: undefined,
  }),
}));

function containerSummary(
  overrides: Partial<ArchivedContainerSummary> = {},
): ArchivedContainerSummary {
  return {
    version: 1,
    id: 'container-1',
    kind: 'worktree',
    projectId: 'ws-1',
    name: 'feature-x',
    createdAt: '2026-07-01T00:00:00.000Z',
    archivedAt: '2026-07-20T00:00:00.000Z',
    retentionDays: 7,
    expiresAt: '2026-07-27T00:00:00.000Z',
    chatCount: 2,
    archivedChatCount: 1,
    executionCount: 1,
    branchName: 'feature/x',
    ...overrides,
  };
}

type ArchivedContainerSummaryV2 = Extract<
  ArchivedContainerSummary,
  { version: 2 }
>;

/** Confirmed-none capture: GitHub answered and there is no PR. */
const CONFIRMED_NONE_PR_CAPTURE: ArchivedContainerSummaryV2['pullRequestMetadata'] =
  {
    capturedAt: '2026-07-20T00:00:00.000Z',
    repositories: [
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        status: 'complete',
        pullRequest: null,
      },
    ],
  };

const COMPLETE_BASE_BRANCHES: ArchivedContainerSummaryV2['baseBranches'] = [
  {
    repoId: 'repo-a',
    repoName: 'repo-a',
    status: 'complete',
    branchName: 'main',
    commit: 'abcdef0123456789abcdef0123456789abcdef01',
  },
];

function v2Summary(
  gitChanges: ArchivedContainerSummaryV2['gitChanges'],
  overrides: Partial<ArchivedContainerSummary> = {},
  pullRequestMetadata: ArchivedContainerSummaryV2['pullRequestMetadata'] = CONFIRMED_NONE_PR_CAPTURE,
): ArchivedContainerSummaryV2 {
  const summary: ArchivedContainerSummaryV2 = {
    ...containerSummary(overrides),
    version: 2,
    kind: 'worktree',
    baseBranches: COMPLETE_BASE_BRANCHES,
    gitChanges,
    pullRequestMetadata,
  };
  return summary;
}

const SINGLE_OPEN_PR_CAPTURE: ArchivedContainerSummaryV2['pullRequestMetadata'] =
  {
    capturedAt: '2026-07-20T00:00:00.000Z',
    repositories: [
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        status: 'complete',
        pullRequest: {
          number: 42,
          url: 'https://github.com/acme/repo-a/pull/42',
          title: 'Preserve archived pull request metadata',
          state: 'open',
          baseRefName: 'main',
          updatedAt: '2026-07-19T00:00:00.000Z',
        },
      },
    ],
  };

const COMPLETE_GIT_CHANGES: ArchivedContainerSummaryV2['gitChanges'] = {
  status: 'complete',
  capturedAt: '2026-07-20T00:00:00.000Z',
  fileCount: 3,
  insertions: 12,
  deletions: 4,
  repositories: [
    {
      repoId: 'repo-a',
      repoName: 'repo-a',
      fileCount: 3,
      insertions: 12,
      deletions: 4,
    },
  ],
};

const UNAVAILABLE_GIT_CHANGES: ArchivedContainerSummaryV2['gitChanges'] = {
  status: 'unavailable',
  capturedAt: '2026-07-20T00:00:00.000Z',
};

function chatSummary(
  overrides: Partial<ArchivedChatSummary> = {},
): ArchivedChatSummary {
  return {
    chatId: 'chat-1',
    title: 'First chat',
    turnCount: 3,
    archivedAt: '2026-07-20T00:00:00.000Z',
    createdAt: '2026-07-01T00:00:00.000Z',
    restorable: true,
    unread: false,
    ...overrides,
  };
}

function executionSummary(
  overrides: Partial<ExecutionSummary> = {},
): ExecutionSummary {
  return {
    id: 'exec-1',
    pipeline_id: 'pipe-1',
    pipeline_name: 'Build pipeline',
    status: 'success',
    status_reasons: [],
    started_at: '2026-07-19T00:00:00.000Z',
    completed_at: '2026-07-19T01:00:00.000Z',
    cwd: '/tmp/x',
    ...overrides,
  };
}

const listMock = jest.fn();
const listChatsMock = jest.fn();
const readChatMock = jest.fn();
const listExecutionsMock = jest.fn();
const listAttachmentsMock = jest.fn();
const listPlansMock = jest.fn();
const readExecutionMock = jest.fn();
const restoreMock = jest.fn();
const deleteMock = jest.fn();
const setLockedMock = jest.fn();
const showInFinderMock = jest.fn();
const openExternalMock = jest.fn();
const addToastMock = jest.fn();
const refreshPullRequestsMock = jest.fn<
  Promise<ArchivedContainerRefreshPullRequestsResponse>,
  [{ projectId: string; containerId: string }]
>();
const getTranscriptPageMock = jest.fn();

let container: HTMLDivElement;
let root: Root;

async function render(
  props: Partial<Parameters<typeof ArchivedContainerView>[0]> = {},
): Promise<void> {
  await act(async () => {
    root.render(
      <ArchivedContainerView
        workspaceId="ws-1"
        containerId="container-1"
        onClose={jest.fn()}
        {...props}
      />,
    );
    await Promise.resolve();
  });
  // Flush the listChats/listExecutions promises.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  mockRetainedCostViewProps.length = 0;
  setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  detailModalProps.length = 0;
  navigateToRestoredMock.mockClear();

  listMock.mockReset().mockResolvedValue([containerSummary()]);
  listChatsMock.mockReset().mockResolvedValue({
    chats: [
      chatSummary(),
      chatSummary({ chatId: 'chat-2', title: 'Old chat', archived: true }),
    ],
  });
  readChatMock
    .mockReset()
    .mockResolvedValue({ tab: { id: 'chat-1', title: 'First chat' } });
  getTranscriptPageMock.mockReset().mockResolvedValue({
    messages: [],
    totalMessages: 0,
    transcriptRevision: 1,
  });
  listExecutionsMock.mockReset().mockResolvedValue({
    executions: [
      executionSummary(),
      executionSummary({
        id: 'exec-child',
        parent_execution_id: 'exec-1',
      }),
    ],
    statesById: {},
  });
  listAttachmentsMock.mockReset().mockResolvedValue({
    attachments: [
      {
        filename: 'notes.txt',
        absolutePath: '/archive/attachments/notes.txt',
        sizeBytes: 42,
        createdAt: '2026-07-18T00:00:00.000Z',
      },
    ],
  });
  listPlansMock.mockReset().mockResolvedValue({
    plans: [
      {
        id: 'plan-1',
        projectId: 'ws-1',
        worktreeId: 'container-1',
        source: 'claude',
        title: 'Captured plan',
        content: '# Captured plan\n\nPlan body text.',
        reviewStatus: 'approved',
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z',
        latestRevisionNumber: 2,
        revisions: [],
        linkedExecutionIds: [],
      },
    ],
  });
  showInFinderMock.mockReset().mockResolvedValue(undefined);
  openExternalMock.mockReset().mockResolvedValue(undefined);
  readExecutionMock.mockReset().mockRejectedValue(new Error('no state'));
  restoreMock.mockReset().mockResolvedValue({
    kind: 'worktree',
    restoredWorktreeId: 'wt-restored',
    branchName: 'feature/x',
    warnings: [],
  });
  deleteMock.mockReset().mockResolvedValue(undefined);
  setLockedMock
    .mockReset()
    .mockResolvedValue(
      containerSummary({ lockedAt: '2026-07-23T00:00:00.000Z' }),
    );

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      archivedContainers: {
        list: listMock,
        listChats: listChatsMock,
        readChat: readChatMock,
        listExecutions: listExecutionsMock,
        listAttachments: listAttachmentsMock,
        listPlans: listPlansMock,
        readExecution: readExecutionMock,
        restore: restoreMock,
        delete: deleteMock,
        setLocked: setLockedMock,
        refreshPullRequests: refreshPullRequestsMock,
      },
      chat: { getTranscriptPage: getTranscriptPageMock },
      showInFinder: showInFinderMock,
      browser: { openExternal: openExternalMock },
    },
  });

  refreshPullRequestsMock.mockReset().mockResolvedValue({
    repos: [],
    fetchedAt: '2026-07-25T00:00:00.000Z',
  });

  useArchivedContainersStore.setState({
    byWorkspace: { 'ws-1': [containerSummary()] },
    loadedWorkspaces: { 'ws-1': true },
    viewer: {
      workspaceId: 'ws-1',
      containerId: 'container-1',
      tab: 'chats',
    },
    pullRequestStatusByContainer: {},
  });
  useCurrentUiStateStore.setState({ slices: {} });
  addToastMock.mockReset();
  useGitHubStore.setState({ addToast: addToastMock });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
});

describe('ArchivedContainerView', () => {
  it('does not read a chat id until the current container confirms it exists', async () => {
    let resolveChats:
      | ((value: { chats: ArchivedChatSummary[] }) => void)
      | undefined;
    listChatsMock.mockReturnValue(
      new Promise<{ chats: ArchivedChatSummary[] }>((resolve) => {
        resolveChats = resolve;
      }),
    );
    useArchivedContainersStore.setState({
      viewer: {
        workspaceId: 'ws-1',
        containerId: 'container-1',
        tab: 'chats',
        selectedChatId: 'chat-from-previous-container',
      },
    });

    await act(async () => {
      root.render(
        <ArchivedContainerView
          workspaceId="ws-1"
          containerId="container-1"
          onClose={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(readChatMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveChats?.({ chats: [chatSummary()] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(readChatMock).toHaveBeenCalledTimes(1);
    expect(readChatMock).toHaveBeenCalledWith({
      projectId: 'ws-1',
      containerId: 'container-1',
      chatId: 'chat-1',
    });
  });

  it('does not reuse the previous container chat list while the next list loads', async () => {
    await render();
    expect(readChatMock).toHaveBeenCalledWith({
      projectId: 'ws-1',
      containerId: 'container-1',
      chatId: 'chat-1',
    });
    readChatMock.mockClear();

    let resolveNextChats:
      | ((value: { chats: ArchivedChatSummary[] }) => void)
      | undefined;
    listChatsMock.mockReturnValueOnce(
      new Promise<{ chats: ArchivedChatSummary[] }>((resolve) => {
        resolveNextChats = resolve;
      }),
    );

    await act(async () => {
      useArchivedContainersStore.setState({
        byWorkspace: {
          'ws-1': [
            containerSummary(),
            containerSummary({ id: 'container-2', name: 'feature-y' }),
          ],
        },
        viewer: {
          workspaceId: 'ws-1',
          containerId: 'container-2',
          tab: 'chats',
          selectedChatId: 'chat-1',
        },
      });
      root.render(
        <ArchivedContainerView
          workspaceId="ws-1"
          containerId="container-2"
          onClose={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(readChatMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveNextChats?.({
        chats: [chatSummary({ chatId: 'chat-3', title: 'Next chat' })],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(readChatMock).toHaveBeenCalledWith({
      projectId: 'ws-1',
      containerId: 'container-2',
      chatId: 'chat-3',
    });
  });

  it('renders the shell with header metadata and all four tab buttons for a worktree container', async () => {
    await render();

    expect(
      container.querySelector('[data-testid="archived-container-view"]'),
    ).toBeTruthy();
    expect(container.textContent).toContain('feature-x');
    expect(container.textContent).toContain('feature/x');
    for (const tab of ['chats', 'pipelines', 'attachments', 'plans']) {
      expect(
        container.querySelector(
          `[data-testid="archived-container-tab-${tab}"]`,
        ),
      ).toBeTruthy();
    }
    expect(
      container.querySelector('[data-testid="archived-restore"]')?.textContent,
    ).toBe('Restore');
    expect(
      container.querySelector('[data-testid="archived-delete-permanently"]'),
    ).toBeTruthy();
  });

  it('lists chats with per-row testids and an archived badge where indicated', async () => {
    await render();

    const rowLive = container.querySelector(
      '[data-testid="archived-chat-row-chat-1"]',
    );
    const rowArchived = container.querySelector(
      '[data-testid="archived-chat-row-chat-2"]',
    );
    expect(rowLive).toBeTruthy();
    expect(rowArchived).toBeNull();
    expect(rowLive?.textContent).not.toContain('Archived');
    const archivedToggle = container.querySelector(
      '[data-testid="archived-inner-chats-toggle"]',
    );
    expect(archivedToggle?.textContent).toContain('Archived (1)');
    expect(archivedToggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      archivedToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    const rowArchivedAfterExpand = container.querySelector(
      '[data-testid="archived-chat-row-chat-2"]',
    );
    expect(rowArchivedAfterExpand).toBeTruthy();
    await act(async () => {
      rowArchivedAfterExpand?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useArchivedContainersStore.getState().viewer?.selectedChatId).toBe(
      'chat-2',
    );
    expect(readChatMock).toHaveBeenCalledWith({
      projectId: 'ws-1',
      containerId: 'container-1',
      chatId: 'chat-2',
    });
    // The read-only viewer never renders a composer.
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('shows a generated chat description instead of the raw title in the list and transcript header', async () => {
    listChatsMock.mockResolvedValue({
      chats: [
        chatSummary({
          title: 'Raw archived chat title',
          description: 'Generated archived chat label',
        }),
      ],
    });
    readChatMock.mockResolvedValue({
      tab: { id: 'chat-1', title: 'Raw archived chat title' },
    });

    await render();

    const row = container.querySelector(
      '[data-testid="archived-chat-row-chat-1"]',
    );
    expect(row?.textContent).toBe('Generated archived chat label');
    expect(
      Array.from(container.querySelectorAll('span')).filter(
        (element) => element.textContent === 'Generated archived chat label',
      ),
    ).toHaveLength(2);
    expect(container.textContent).not.toContain('Raw archived chat title');
  });

  it('shows loaded item counts in every worktree archive tab header', async () => {
    useArchivedContainersStore.setState({
      byWorkspace: { 'ws-1': [v2Summary(COMPLETE_GIT_CHANGES)] },
    });
    await render();

    expect(
      container.querySelector('[data-testid="archived-container-tab-changes"]')
        ?.textContent,
    ).toBe('Changes (3)');
    expect(
      container.querySelector('[data-testid="archived-container-tab-chats"]')
        ?.textContent,
    ).toBe('Chats (2)');
    expect(
      container.querySelector(
        '[data-testid="archived-container-tab-pipelines"]',
      )?.textContent,
    ).toBe('Pipelines (1)');
    expect(
      container.querySelector(
        '[data-testid="archived-container-tab-attachments"]',
      )?.textContent,
    ).toBe('Attachments (1)');
    expect(
      container.querySelector('[data-testid="archived-container-tab-plans"]')
        ?.textContent,
    ).toBe('Plans (1)');
  });

  it('does not auto-select an archived inner chat hidden by the collapsed subgroup', async () => {
    listChatsMock.mockResolvedValue({
      chats: [chatSummary({ chatId: 'archived-only', archived: true })],
    });
    await render();

    expect(
      container.querySelector('[data-testid="archived-inner-chats-toggle"]'),
    ).toBeTruthy();
    expect(useArchivedContainersStore.getState().viewer?.selectedChatId).toBe(
      undefined,
    );
    expect(readChatMock).not.toHaveBeenCalled();
  });

  it('selecting a chat reads it and renders the transcript in an explicit-height flex column', async () => {
    await render();

    const row = container.querySelector(
      '[data-testid="archived-chat-row-chat-1"]',
    );
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(readChatMock).toHaveBeenCalledWith({
      projectId: 'ws-1',
      containerId: 'container-1',
      chatId: 'chat-1',
    });
    const list = container.querySelector(
      '[data-testid="mock-chat-message-list"]',
    );
    expect(list?.textContent).toBe('chat-1');
    // ChatMessageList's scroller is `absolute inset-0`; its wrapper must be a
    // resolved-height flex column, never an unconstrained `min-h` block.
    const wrapper = list?.parentElement;
    expect(wrapper?.className).toContain('min-h-0');
    expect(wrapper?.className).toContain('flex-1');
    expect(wrapper?.className).toContain('flex-col');
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('hides archived transcript page failure details behind canonical copy', async () => {
    readChatMock.mockResolvedValue({
      tab: {
        id: 'chat-1',
        title: 'First chat',
        messages: [],
        transcriptLoaded: true,
        transcript: {
          format: 'complete-message-jsonl-v1',
          committedMessageCount: 2,
          committedByteLength: 200,
          transcriptRevision: 1,
          hasActiveSidecar: false,
        },
        transcriptWindow: {
          before: 1,
          totalMessages: 2,
          transcriptRevision: 1,
        },
      },
    });
    getTranscriptPageMock.mockRejectedValue(
      new Error('private archived-container detail'),
    );
    await render();
    const row = container.querySelector(
      '[data-testid="archived-chat-row-chat-1"]',
    );
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Couldn't load messages.");
    expect(container.textContent).not.toContain(
      'private archived-container detail',
    );
  });

  it('offers no worktree tabs for work-entry containers and shows chats first', async () => {
    const entrySummary = containerSummary({
      id: 'container-1',
      kind: 'work-entry',
      name: 'My work entry',
      branchName: undefined,
    });
    useArchivedContainersStore.setState({
      byWorkspace: { 'ws-1': [entrySummary] },
    });
    await render();

    for (const tab of ['pipelines', 'attachments', 'plans']) {
      expect(
        container.querySelector(
          `[data-testid="archived-container-tab-${tab}"]`,
        ),
      ).toBeNull();
    }
    expect(
      container.querySelector('[data-testid="archived-chat-row-chat-1"]'),
    ).toBeTruthy();
    expect(listExecutionsMock).not.toHaveBeenCalled();
    expect(listAttachmentsMock).not.toHaveBeenCalled();
    expect(listPlansMock).not.toHaveBeenCalled();
  });

  it('adds Cost before Chats for a work entry, with Early access off', async () => {
    const entrySummary = containerSummary({
      id: 'container-1',
      kind: 'work-entry',
      name: 'My work entry',
      branchName: undefined,
    });
    useArchivedContainersStore.setState({
      byWorkspace: { 'ws-1': [entrySummary] },
    });
    expect(useExperimentalFeaturesStore.getState().enabled).toBe(false);

    await render();

    const tabs = Array.from(
      container.querySelectorAll('[data-testid^="archived-container-tab-"]'),
    );
    expect(tabs.map((tab) => tab.getAttribute('data-testid'))).toEqual([
      'archived-container-tab-cost',
      'archived-container-tab-chats',
    ]);
    expect(
      container.querySelector('[data-testid="archived-chat-row-chat-1"]'),
    ).toBeTruthy();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="archived-container-tab-cost"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="archived-container-cost-view"]'),
    ).not.toBeNull();
    expect(mockRetainedCostViewProps.at(-1)).toMatchObject({
      scope: {
        kind: 'retained',
        projectId: 'ws-1',
        containerId: 'container-1',
      },
    });
    expect(useArchivedContainersStore.getState().viewer?.tab).toBe('chats');
  });

  it('marks only the Cost tab selected while the cost view is shown', async () => {
    useArchivedContainersStore.setState({
      byWorkspace: {
        'ws-1': [
          containerSummary({
            id: 'container-1',
            kind: 'work-entry',
            name: 'My work entry',
            branchName: undefined,
          }),
        ],
      },
    });

    await render();
    const tab = (id: string): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>(
        `[data-testid="archived-container-tab-${id}"]`,
      );

    await act(async () => {
      tab('cost')?.click();
      await Promise.resolve();
    });

    expect(tab('chats')?.className).not.toContain('font-medium');
    expect(tab('chats')?.hasAttribute('aria-current')).toBe(false);
    expect(tab('cost')?.getAttribute('aria-current')).toBe('true');
  });

  it('switches to the attachments tab, lists files, and reveals via the typed API', async () => {
    await render();

    const attachmentsTab = container.querySelector(
      '[data-testid="archived-container-tab-attachments"]',
    );
    await act(async () => {
      attachmentsTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(listAttachmentsMock).toHaveBeenCalledWith({
      projectId: 'ws-1',
      containerId: 'container-1',
    });
    const row = container.querySelector(
      '[data-testid="archived-attachment-row-notes.txt"]',
    );
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain('notes.txt');

    const reveal = container.querySelector(
      '[data-testid="archived-attachment-reveal-notes.txt"]',
    );
    await act(async () => {
      reveal?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(showInFinderMock).toHaveBeenCalledWith({
      absolutePath: '/archive/attachments/notes.txt',
    });
  });

  it('opens an archived attachment in the full read-only file viewer', async () => {
    await render();

    const attachmentsTab = container.querySelector(
      '[data-testid="archived-container-tab-attachments"]',
    );
    await act(async () => {
      attachmentsTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const row = container.querySelector(
      '[data-testid="archived-attachment-row-notes.txt"]',
    );
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    const open = container.querySelector(
      '[data-testid="mock-attachment-open"]',
    );
    await act(async () => {
      open?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="mock-archived-attachment-viewer"]')
        ?.textContent,
    ).toContain('notes.txt');

    const back = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Back to attachments',
    );
    await act(async () => {
      back?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      container.querySelector(
        '[data-testid="archived-attachment-row-notes.txt"]',
      ),
    ).toBeTruthy();
  });

  it('switches to the plans tab, auto-selects the first plan, and renders its content', async () => {
    await render();

    const plansTab = container.querySelector(
      '[data-testid="archived-container-tab-plans"]',
    );
    await act(async () => {
      plansTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(listPlansMock).toHaveBeenCalledWith({
      projectId: 'ws-1',
      containerId: 'container-1',
    });
    expect(
      container.querySelector('[data-testid="archived-plan-row-plan-1"]'),
    ).toBeTruthy();
    const content = container.querySelector(
      '[data-testid="archived-plan-content"]',
    );
    expect(content?.textContent).toContain('Plan body text.');
    expect(content?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);
    // Metadata line for the selected plan.
    expect(container.textContent).toContain('Rev 2');
    expect(container.textContent).toContain('approved');
  });

  it('does not replace a deep-linked plan while the next container plans are loading', async () => {
    await render();

    let resolveNextPlans:
      | ((value: {
          plans: Awaited<ReturnType<typeof listPlansMock>>['plans'];
        }) => void)
      | undefined;
    listPlansMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveNextPlans = resolve;
      }),
    );

    await act(async () => {
      useArchivedContainersStore.setState({
        byWorkspace: {
          'ws-1': [
            containerSummary(),
            containerSummary({ id: 'container-2', name: 'feature-y' }),
          ],
        },
        viewer: {
          workspaceId: 'ws-1',
          containerId: 'container-2',
          tab: 'plans',
          selectedPlanId: 'plan-2',
        },
      });
      root.render(
        <ArchivedContainerView
          workspaceId="ws-1"
          containerId="container-2"
          onClose={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(useArchivedContainersStore.getState().viewer.selectedPlanId).toBe(
      'plan-2',
    );

    await act(async () => {
      resolveNextPlans?.({
        plans: [
          {
            id: 'plan-2',
            projectId: 'ws-1',
            worktreeId: 'container-2',
            source: 'claude',
            title: 'Next plan',
            content: '# Next plan',
            reviewStatus: 'pending',
            createdAt: '2026-07-20T00:00:00.000Z',
            updatedAt: '2026-07-20T00:00:00.000Z',
            latestRevisionNumber: 1,
            revisions: [],
            linkedExecutionIds: [],
          },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(useArchivedContainersStore.getState().viewer.selectedPlanId).toBe(
      'plan-2',
    );
  });

  it('switches to the pipelines tab and renders slim execution rows for top-level runs only', async () => {
    await render();

    const pipelinesTab = container.querySelector(
      '[data-testid="archived-container-tab-pipelines"]',
    );
    await act(async () => {
      pipelinesTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      container.querySelector('[data-testid="archived-execution-row-exec-1"]'),
    ).toBeTruthy();
    // Child executions are reachable from the detail modal, not as rows.
    expect(
      container.querySelector(
        '[data-testid="archived-execution-row-exec-child"]',
      ),
    ).toBeNull();
  });

  it('opens the pipeline detail modal with archivedSource and no mutation/action props', async () => {
    await render();
    const pipelinesTab = container.querySelector(
      '[data-testid="archived-container-tab-pipelines"]',
    );
    await act(async () => {
      pipelinesTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const row = container.querySelector(
      '[data-testid="archived-execution-row-exec-1"]',
    );
    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(
      container.querySelector('[data-testid="mock-pipeline-detail-modal"]'),
    ).toBeTruthy();
    const props = detailModalProps[detailModalProps.length - 1] ?? {};
    expect(props.executionId).toBe('exec-1');
    expect(props.archivedSource).toEqual({
      projectId: 'ws-1',
      containerId: 'container-1',
    });
    for (const mutationProp of [
      'actions',
      'onCancel',
      'onRetry',
      'onRerun',
      'onDebugFailure',
      'onChatFollowUp',
      'onPipelineFollowUp',
      'onReportChatFollowUp',
      'onViewReport',
    ]) {
      expect(props[mutationProp]).toBeUndefined();
    }
  });

  it('renders partial-restore mode: banner, hidden chats, and Retry pipeline import', async () => {
    useArchivedContainersStore.setState({
      byWorkspace: {
        'ws-1': [
          containerSummary({
            restoredTo: {
              kind: 'worktree',
              id: 'wt-new',
              restoredAt: '2026-07-21T00:00:00.000Z',
            },
          }),
        ],
      },
    });
    await render();

    expect(
      container.querySelector('[data-testid="archived-partial-restore-banner"]')
        ?.textContent,
    ).toBe('Partially restored — pipeline runs pending');
    expect(
      container.querySelector('[data-testid="archived-container-tab-chats"]'),
    ).toBeNull();
    expect(listChatsMock).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="archived-restore"]')?.textContent,
    ).toBe('Retry pipeline import');
    expect(
      container.querySelector('[data-testid="archived-execution-row-exec-1"]'),
    ).toBeTruthy();
  });

  it('labels a files-restored cleanup retry without claiming pipeline import is pending', async () => {
    useArchivedContainersStore.setState({
      byWorkspace: {
        'ws-1': [
          containerSummary({
            version: 3,
            restoredTo: {
              kind: 'worktree',
              id: 'wt-new',
              restoredAt: '2026-07-21T00:00:00.000Z',
            },
            recovery: {
              kind: 'files-only',
              source: 'partial',
              digest: 'a'.repeat(64),
              payloadId: '11111111-1111-4111-8111-111111111111',
              gitCleanupPending: true,
            },
          }),
        ],
      },
    });

    await render();

    expect(
      container.querySelector(
        '[data-testid="archived-partial-restore-banner"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="archived-restore"]')?.textContent,
    ).toBe('Retry Git cleanup');
    expect(
      container.querySelector('[data-testid="archived-file-recovery-banner"]')
        ?.textContent,
    ).toContain('Git registration cleanup is still pending');
    expect(
      container.querySelector('[data-testid="archived-container-tab-chats"]'),
    ).toBeNull();
  });

  it('prioritizes a pending pipeline import over concurrent Git cleanup', async () => {
    const combined = containerSummary({
      version: 3,
      restoredTo: {
        kind: 'worktree',
        id: 'wt-new',
        restoredAt: '2026-07-21T00:00:00.000Z',
      },
      recovery: {
        kind: 'files-only',
        source: 'partial',
        digest: 'a'.repeat(64),
        payloadId: '11111111-1111-4111-8111-111111111111',
        gitCleanupPending: true,
      },
    });
    Object.assign(combined, { executionRestorePending: true });
    useArchivedContainersStore.setState({
      byWorkspace: { 'ws-1': [combined] },
    });

    await render();

    expect(
      container.querySelector('[data-testid="archived-partial-restore-banner"]')
        ?.textContent,
    ).toBe('Partially restored — pipeline runs pending');
    expect(
      container.querySelector('[data-testid="archived-restore"]')?.textContent,
    ).toBe('Retry pipeline import');
  });

  it('restore navigates to the destination when the container is consumed', async () => {
    // After restore, the store reload no longer contains the container.
    listMock.mockResolvedValue([]);
    await render();

    const restoreButton = container.querySelector(
      '[data-testid="archived-restore"]',
    );
    await act(async () => {
      restoreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(restoreMock).toHaveBeenCalledWith({
      projectId: 'ws-1',
      containerId: 'container-1',
    });
    expect(navigateToRestoredMock).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ restoredWorktreeId: 'wt-restored' }),
    );
  });

  it('partial restore keeps the viewer open and does not navigate', async () => {
    restoreMock.mockResolvedValue({
      kind: 'worktree',
      restoredWorktreeId: 'wt-restored',
      warnings: ['3 pipeline runs pending'],
    });
    // Container remains listed (now partially restored).
    listMock.mockResolvedValue([
      containerSummary({
        restoredTo: {
          kind: 'worktree',
          id: 'wt-restored',
          restoredAt: '2026-07-22T00:00:00.000Z',
        },
      }),
    ]);
    await render();

    const restoreButton = container.querySelector(
      '[data-testid="archived-restore"]',
    );
    await act(async () => {
      restoreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(navigateToRestoredMock).not.toHaveBeenCalled();
    expect(useArchivedContainersStore.getState().viewer).not.toBeNull();
    expect(addToastMock).toHaveBeenCalledWith(
      '3 pipeline runs pending',
      'warning',
      undefined,
      { category: 'Worktree' },
    );
  });

  it('permanent delete is two-step and calls the typed API', async () => {
    listMock.mockResolvedValue([]);
    await render();

    const deleteButton = container.querySelector(
      '[data-testid="archived-delete-permanently"]',
    );
    act(() => {
      deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Not deleted yet — inline confirm is showing.
    expect(deleteMock).not.toHaveBeenCalled();

    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Delete?',
    );
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(deleteMock).toHaveBeenCalledWith({
      projectId: 'ws-1',
      containerId: 'container-1',
    });
    expect(useArchivedContainersStore.getState().viewer).toBeNull();
  });

  it('does not carry permanent-delete confirmation to another archive', async () => {
    await render();

    act(() => {
      container
        .querySelector('[data-testid="archived-delete-permanently"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Delete?');

    useArchivedContainersStore.setState({
      byWorkspace: {
        'ws-1': [
          containerSummary(),
          containerSummary({ id: 'container-2', name: 'feature-y' }),
        ],
      },
    });
    await render({ containerId: 'container-2' });

    expect(container.textContent).not.toContain('Delete?');
    expect(
      container.querySelector('[data-testid="archived-delete-permanently"]'),
    ).toBeTruthy();
  });

  it('archives a Deleted item from the header, swaps in the returned summary, and shows the Archived chip', async () => {
    await render();

    const badge = container.querySelector<HTMLElement>(
      '[data-testid="archived-state-badge"]',
    );
    expect(badge?.getAttribute('data-state')).toBe('deleted');
    expect(badge?.textContent).toContain('Deleted');
    expect(badge?.className).toContain('ring-line-destructive');
    expect(badge?.className).not.toContain('border-line-destructive');
    // Deleted items show when the sweep removes them; nothing says "Lock".
    expect(container.textContent).toContain('Removed');
    expect(container.textContent).not.toContain('Lock');
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="archived-state-toggle"]',
    );
    expect(toggle?.textContent).toBe('Archive');

    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });

    expect(setLockedMock).toHaveBeenCalledWith({
      projectId: 'ws-1',
      containerId: 'container-1',
      locked: true,
    });
    const archivedBadge = container.querySelector<HTMLElement>(
      '[data-testid="archived-state-badge"]',
    );
    expect(archivedBadge?.getAttribute('data-state')).toBe('archived');
    expect(archivedBadge?.textContent).toContain('Archived');
    expect(archivedBadge?.className).toContain('ring-sky-500/30');
    expect(archivedBadge?.className).not.toContain('border-sky-500/30');
    expect(container.textContent).not.toContain('Removed');
    expect(
      container.querySelector('[data-testid="archived-state-toggle"]')
        ?.textContent,
    ).toBe('Delete');
    expect(
      useArchivedContainersStore
        .getState()
        .byWorkspace['ws-1']?.find((entry) => entry.id === 'container-1')
        ?.lockedAt,
    ).toBe('2026-07-23T00:00:00.000Z');
  });

  it('moves an Archived item back to Deleted through the same header action', async () => {
    useArchivedContainersStore.setState({
      byWorkspace: {
        'ws-1': [containerSummary({ lockedAt: '2026-07-23T00:00:00.000Z' })],
      },
    });
    setLockedMock.mockResolvedValue(
      containerSummary({ expiresAt: '2026-09-08T00:00:00.000Z' }),
    );
    await render();

    expect(
      container
        .querySelector('[data-testid="archived-state-badge"]')
        ?.getAttribute('data-state'),
    ).toBe('archived');
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="archived-state-toggle"]',
    );
    expect(toggle?.textContent).toBe('Delete');

    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });

    expect(setLockedMock).toHaveBeenCalledWith({
      projectId: 'ws-1',
      containerId: 'container-1',
      locked: false,
    });
    expect(
      container
        .querySelector('[data-testid="archived-state-badge"]')
        ?.getAttribute('data-state'),
    ).toBe('deleted');
    expect(container.textContent).toContain('Removed');
  });

  it('shows the measured disk usage once the summary carries it', async () => {
    useArchivedContainersStore.setState({
      byWorkspace: {
        'ws-1': [
          containerSummary({
            diskUsage: {
              filesBytes: 1024,
              gitBytes: 2048,
              totalBytes: 3072,
              computedAt: '2026-07-23T00:00:00.000Z',
            },
          }),
        ],
      },
    });
    await render();
    expect(
      container.querySelector('[data-testid="archived-disk-usage"]')
        ?.textContent,
    ).toContain('3 KB on disk');
  });

  it('labels an incomplete version-2 Git measurement as a lower bound', async () => {
    useArchivedContainersStore.setState({
      byWorkspace: {
        'ws-1': [
          v2Summary(COMPLETE_GIT_CHANGES, {
            diskUsage: {
              filesBytes: 1024,
              gitBytes: 2048,
              gitBytesComplete: false,
              totalBytes: 3072,
              computedAt: '2026-07-23T00:00:00.000Z',
            },
          }),
        ],
      },
    });
    await render();
    expect(
      container.querySelector('[data-testid="archived-disk-usage"]')
        ?.textContent,
    ).toContain('At least 3 KB on disk');
  });

  it('shows a measuring placeholder until disk usage lands', async () => {
    await render();
    expect(
      container.querySelector('[data-testid="archived-disk-usage"]')
        ?.textContent,
    ).toContain('Measuring size');
  });

  it('reports the archivedContainers UI-state slice', async () => {
    await render();

    const slice =
      useCurrentUiStateStore.getState().slices['archivedContainers'];
    expect(slice).toMatchObject({
      count: 1,
      viewerOpen: true,
      viewerKind: 'worktree',
      viewerTab: 'chats',
    });
  });

  it('shows Changes (N) after Cost plus the header badge for complete version-2 stats, defaulting to Chats', async () => {
    useArchivedContainersStore.setState({
      byWorkspace: { 'ws-1': [v2Summary(COMPLETE_GIT_CHANGES)] },
    });
    await render();

    const tabs = Array.from(
      container.querySelectorAll('[data-testid^="archived-container-tab-"]'),
    );
    expect(tabs.map((tab) => tab.getAttribute('data-testid'))).toEqual([
      'archived-container-tab-cost',
      'archived-container-tab-changes',
      'archived-container-tab-chats',
      'archived-container-tab-pipelines',
      'archived-container-tab-attachments',
      'archived-container-tab-plans',
    ]);
    expect(tabs[1]?.textContent).toBe('Changes (3)');

    const badge = container.querySelector(
      '[data-testid="archived-header-diff-badge"]',
    );
    expect(badge?.textContent).toContain('+12');
    expect(badge?.textContent).toContain('-4');
    expect(badge?.getAttribute('title')).toBe('3 changed files');
    const base = container.querySelector(
      '[data-testid="archived-base-branch-repo-a"]',
    );
    expect(base?.textContent).toBe('Base main @ abcdef01');
    expect(base?.getAttribute('title')).toBe(
      'base branch main at abcdef0123456789abcdef0123456789abcdef01',
    );

    // Opening the archive still defaults to Chats: the explorer stays
    // unmounted (no changed-file list work) until Changes is selected.
    expect(
      container.querySelector('[data-testid="mock-archived-changes-view"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="archived-chat-row-chat-1"]'),
    ).toBeTruthy();
  });

  it('adds Cost first without changing the default tab and renders the retained scope', async () => {
    useArchivedContainersStore.setState({
      byWorkspace: { 'ws-1': [v2Summary(COMPLETE_GIT_CHANGES)] },
    });

    await render();

    const tabs = Array.from(
      container.querySelectorAll('[data-testid^="archived-container-tab-"]'),
    );
    expect(tabs.map((tab) => tab.getAttribute('data-testid'))).toEqual([
      'archived-container-tab-cost',
      'archived-container-tab-changes',
      'archived-container-tab-chats',
      'archived-container-tab-pipelines',
      'archived-container-tab-attachments',
      'archived-container-tab-plans',
    ]);
    expect(
      container.querySelector('[data-testid="mock-archived-changes-view"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="archived-chat-row-chat-1"]'),
    ).toBeTruthy();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="archived-container-tab-cost"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="archived-container-cost-view"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="mock-retained-cost-view"]'),
    ).not.toBeNull();
    expect(mockRetainedCostViewProps.at(-1)).toMatchObject({
      scope: {
        kind: 'retained',
        projectId: 'ws-1',
        containerId: 'container-1',
      },
    });
    expect(useArchivedContainersStore.getState().viewer?.tab).toBe('chats');

    const selectedRow: CostScopeRowTarget = {
      kind: 'chat',
      chatId: 'chat-2',
    };
    await act(async () => {
      mockRetainedCostViewProps.at(-1)?.onSelectRow?.(selectedRow);
      await Promise.resolve();
    });
    expect(mockRetainedCostViewProps.at(-1)?.selectedRow).toEqual(selectedRow);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="archived-container-tab-chats"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="archived-container-tab-cost"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(mockRetainedCostViewProps.at(-1)?.selectedRow).toEqual(selectedRow);
  });

  it('labels repository-specific and unavailable archive-time bases', async () => {
    const summary = v2Summary(COMPLETE_GIT_CHANGES);
    summary.workspaceType = 'multi-repo';
    summary.baseBranches = [
      ...COMPLETE_BASE_BRANCHES,
      {
        repoId: 'repo-b',
        repoName: 'repo-b',
        status: 'unavailable',
        branchName: 'develop',
      },
    ];
    useArchivedContainersStore.setState({
      byWorkspace: { 'ws-1': [summary] },
    });

    await render();

    expect(
      container.querySelector('[data-testid="archived-base-branch-repo-a"]')
        ?.textContent,
    ).toBe('repo-a: Base main @ abcdef01');
    expect(
      container.querySelector('[data-testid="archived-base-branch-repo-b"]')
        ?.textContent,
    ).toBe('repo-b: Base develop @ unavailable');
  });

  it('opens the Changes explorer when its tab is clicked and reports viewerTab changes', async () => {
    useArchivedContainersStore.setState({
      byWorkspace: { 'ws-1': [v2Summary(COMPLETE_GIT_CHANGES)] },
    });
    await render();

    await act(async () => {
      container
        .querySelector('[data-testid="archived-container-tab-changes"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      container.querySelector('[data-testid="mock-archived-changes-view"]'),
    ).toBeTruthy();
    expect(
      useCurrentUiStateStore.getState().slices['archivedContainers'],
    ).toMatchObject({ viewerTab: 'changes' });

    // Existing tabs remain functional after leaving Changes.
    await act(async () => {
      container
        .querySelector('[data-testid="archived-container-tab-chats"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      container.querySelector('[data-testid="mock-archived-changes-view"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="archived-chat-row-chat-1"]'),
    ).toBeTruthy();
  });

  it('appends the zero-line note to the header badge tooltip when both totals are zero', async () => {
    useArchivedContainersStore.setState({
      byWorkspace: {
        'ws-1': [
          v2Summary({
            ...COMPLETE_GIT_CHANGES,
            fileCount: 2,
            insertions: 0,
            deletions: 0,
          }),
        ],
      },
    });
    await render();

    expect(
      container
        .querySelector('[data-testid="archived-header-diff-badge"]')
        ?.getAttribute('title'),
    ).toBe('2 changed files\nSome changes do not affect line totals.');
  });

  it('shows a plain Changes tab and no badge when version-2 stats are unavailable', async () => {
    useArchivedContainersStore.setState({
      byWorkspace: { 'ws-1': [v2Summary(UNAVAILABLE_GIT_CHANGES)] },
    });
    await render();

    expect(
      container.querySelector('[data-testid="archived-container-tab-changes"]')
        ?.textContent,
    ).toBe('Changes');
    expect(
      container.querySelector('[data-testid="archived-header-diff-badge"]'),
    ).toBeNull();
  });

  it('hides the Changes tab and badge for a clean version-2 archive', async () => {
    useArchivedContainersStore.setState({
      byWorkspace: {
        'ws-1': [
          v2Summary({
            ...COMPLETE_GIT_CHANGES,
            fileCount: 0,
            insertions: 0,
            deletions: 0,
            repositories: [],
          }),
        ],
      },
    });
    await render();

    expect(
      container.querySelector('[data-testid="archived-container-tab-changes"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="archived-header-diff-badge"]'),
    ).toBeNull();
  });

  it('hides the Changes tab and badge for legacy version-1 archives', async () => {
    await render();

    expect(
      container.querySelector('[data-testid="archived-container-tab-changes"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="archived-header-diff-badge"]'),
    ).toBeNull();
  });

  it('hides the Changes tab for a partially restored version-2 archive', async () => {
    useArchivedContainersStore.setState({
      byWorkspace: {
        'ws-1': [
          v2Summary(COMPLETE_GIT_CHANGES, {
            restoredTo: {
              kind: 'worktree',
              id: 'wt-new',
              restoredAt: '2026-07-21T00:00:00.000Z',
            },
          }),
        ],
      },
    });
    await render();

    expect(
      container.querySelector('[data-testid="archived-container-tab-changes"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="mock-archived-changes-view"]'),
    ).toBeNull();
  });

  it('falls back to Chats and sanitizes the reported tab when a persisted Changes selection is unavailable', async () => {
    // Legacy version-1 summary: the persisted/requested `changes` tab is not
    // available, so the viewer lands on Chats and never mounts the explorer.
    useArchivedContainersStore.setState({
      viewer: {
        workspaceId: 'ws-1',
        containerId: 'container-1',
        tab: 'changes',
      },
    });
    await render();

    expect(
      container.querySelector('[data-testid="mock-archived-changes-view"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="archived-chat-row-chat-1"]'),
    ).toBeTruthy();
    expect(
      useCurrentUiStateStore.getState().slices['archivedContainers'],
    ).toMatchObject({ viewerTab: 'chats' });
  });

  it('honors an explicit changes navigation request for an eligible archive', async () => {
    useArchivedContainersStore.setState({
      byWorkspace: { 'ws-1': [v2Summary(COMPLETE_GIT_CHANGES)] },
      viewer: {
        workspaceId: 'ws-1',
        containerId: 'container-1',
        tab: 'changes',
      },
    });
    await render();

    expect(
      container.querySelector('[data-testid="mock-archived-changes-view"]'),
    ).toBeTruthy();
    expect(
      useCurrentUiStateStore.getState().slices['archivedContainers'],
    ).toMatchObject({ viewerTab: 'changes' });
  });

  describe('header pull request badge', () => {
    /** Open the tooltip portal for one repository's header badge. */
    async function hoverBadge(repoId: string): Promise<void> {
      await act(async () => {
        // Dispatch on the badge link so the event bubbles through the
        // tooltip's own trigger wrapper (where its handlers live).
        container
          .querySelector(`[data-testid="archived-pr-${repoId}"] a`)
          ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await Promise.resolve();
      });
    }

    /** Let the debounced live refresh fire. */
    async function flushRefreshDebounce(): Promise<void> {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
    }

    it.each(['open', 'draft', 'closed', 'merged'] as const)(
      'renders the captured %s PR as a state-colored header badge, left of the diff stats',
      async (state) => {
        useArchivedContainersStore.setState({
          byWorkspace: {
            'ws-1': [
              v2Summary(
                COMPLETE_GIT_CHANGES,
                {},
                {
                  ...SINGLE_OPEN_PR_CAPTURE,
                  repositories: [
                    {
                      ...SINGLE_OPEN_PR_CAPTURE.repositories[0],
                      status: 'complete',
                      pullRequest: {
                        number: 42,
                        url: 'https://github.com/acme/repo-a/pull/42',
                        title: 'Preserve archived pull request metadata',
                        state,
                        updatedAt: '2026-07-19T00:00:00.000Z',
                      },
                    },
                  ],
                },
              ),
            ],
          },
        });
        await render();

        // The badge lives in the top bar itself, not on a line of its own.
        expect(
          container.querySelector('[data-testid="archived-pr-section"]'),
        ).toBeNull();
        const badge = container.querySelector(
          '[data-testid="archived-pr-repo-a"]',
        );
        expect(badge?.textContent).toBe('#42');
        // Single-repository archives omit the repository name.
        expect(badge?.textContent).not.toContain('repo-a');

        const header = container.querySelector(
          '[data-testid="archived-container-view"]',
        )?.children[0];
        const headerChildren = Array.from(header?.children ?? []);
        if (!badge) throw new Error('Expected archived PR badge');
        const badgeIndex = headerChildren.indexOf(badge);
        const diffIndex = headerChildren.findIndex(
          (child) =>
            child.getAttribute('data-testid') === 'archived-header-diff-badge',
        );
        expect(badgeIndex).toBeGreaterThanOrEqual(0);
        expect(badgeIndex).toBeLessThan(diffIndex);

        // The captured URL opens through the shared external-link path.
        const link = badge?.querySelector('a');
        expect(link?.getAttribute('href')).toBe(
          'https://github.com/acme/repo-a/pull/42',
        );
        expect(link?.getAttribute('target')).toBe('_blank');
      },
    );

    it('describes a capture-only badge as archive-time state in its tooltip', async () => {
      useArchivedContainersStore.setState({
        byWorkspace: {
          'ws-1': [v2Summary(COMPLETE_GIT_CHANGES, {}, SINGLE_OPEN_PR_CAPTURE)],
        },
      });
      await render();
      await hoverBadge('repo-a');

      const tooltip = document.body.querySelector(
        '[data-testid="archived-pr-tooltip-repo-a"]',
      );
      const formattedCapturedAt = new Date(
        '2026-07-20T00:00:00.000Z',
      ).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      expect(tooltip?.textContent).toContain(
        'Preserve archived pull request metadata',
      );
      expect(tooltip?.textContent).toContain(
        `Open — captured when archived on ${formattedCapturedAt}`,
      );
      // No live data was claimed for a capture-only badge.
      expect(tooltip?.textContent).not.toContain('CI checks');
    });

    it('shows one badge per confirmed PR with repository names in a multi-repo archive', async () => {
      useArchivedContainersStore.setState({
        byWorkspace: {
          'ws-1': [
            v2Summary(
              COMPLETE_GIT_CHANGES,
              { workspaceType: 'multi-repo' },
              {
                capturedAt: '2026-07-20T00:00:00.000Z',
                repositories: [
                  {
                    repoId: 'api',
                    repoName: 'service-api',
                    status: 'complete',
                    pullRequest: {
                      number: 101,
                      url: 'https://github.com/acme/service-api/pull/101',
                      title: 'Archive API changes',
                      state: 'draft',
                      updatedAt: '2026-07-19T00:00:00.000Z',
                    },
                  },
                  {
                    repoId: 'web',
                    repoName: 'service-web',
                    status: 'complete',
                    pullRequest: null,
                  },
                  {
                    repoId: 'docs',
                    repoName: 'service-docs',
                    status: 'unavailable',
                  },
                ],
              },
            ),
          ],
        },
      });
      await render();

      const badges = Array.from(
        container.querySelectorAll('[data-testid^="archived-pr-"]'),
      ).filter(
        (element) =>
          !(element.getAttribute('data-testid') ?? '').startsWith(
            'archived-pr-tooltip-',
          ),
      );
      // Confirmed associations only: null and unavailable repos get no badge.
      expect(badges.map((badge) => badge.getAttribute('data-testid'))).toEqual([
        'archived-pr-api',
      ]);
      expect(badges[0]?.textContent).toContain('service-api');
      expect(badges[0]?.textContent).toContain('#101');
    });

    it('renders no PR badge for confirmed-none, unavailable-only, or legacy archives', async () => {
      const unavailableOnly: ArchivedContainerSummaryV2['pullRequestMetadata'] =
        {
          capturedAt: '2026-07-20T00:00:00.000Z',
          repositories: [
            { repoId: 'repo-a', repoName: 'repo-a', status: 'unavailable' },
          ],
        };
      for (const summary of [
        v2Summary(COMPLETE_GIT_CHANGES), // confirmed-none capture
        v2Summary(COMPLETE_GIT_CHANGES, {}, unavailableOnly),
        containerSummary(), // legacy version-1
        containerSummary({ kind: 'work-entry', branchName: undefined }),
      ]) {
        useArchivedContainersStore.setState({
          byWorkspace: { 'ws-1': [summary] },
          pullRequestStatusByContainer: {},
        });
        await render();
        expect(
          container.querySelector('[data-testid^="archived-pr-"]'),
        ).toBeNull();
      }
    });

    it('exposes no merge, refresh, review, close, or reopen control on the badge', async () => {
      useArchivedContainersStore.setState({
        byWorkspace: {
          'ws-1': [v2Summary(COMPLETE_GIT_CHANGES, {}, SINGLE_OPEN_PR_CAPTURE)],
        },
      });
      await render();

      const badge = container.querySelector(
        '[data-testid="archived-pr-repo-a"]',
      );
      // The only interactive element is the external link.
      expect(badge?.querySelectorAll('button')).toHaveLength(0);
      expect(badge?.querySelectorAll('a')).toHaveLength(1);
      for (const forbidden of [
        'merge',
        'refresh',
        'review',
        'close pull',
        'reopen',
      ]) {
        expect(badge?.textContent?.toLowerCase()).not.toContain(forbidden);
      }
    });

    it('refreshes live PR state once on selection, then reuses it inside the TTL', async () => {
      refreshPullRequestsMock.mockResolvedValue({
        fetchedAt: '2026-07-25T00:00:00.000Z',
        repos: [
          {
            repoId: 'repo-a',
            repoName: 'repo-a',
            status: {
              prNumber: 42,
              prUrl: 'https://github.com/acme/repo-a/pull/42',
              state: 'merged',
              title: 'Preserve archived pull request metadata',
              body: 'Body text',
              checkStatus: 'passing',
              checkDetails: [],
              reviewStatus: 'approved',
              reviewers: [],
              hasConflicts: false,
              commentCount: 0,
              unresolvedReviewThreadCount: 0,
              updatedAt: '2026-07-25T00:00:00.000Z',
            },
          },
        ],
      });
      useArchivedContainersStore.setState({
        byWorkspace: {
          'ws-1': [v2Summary(COMPLETE_GIT_CHANGES, {}, SINGLE_OPEN_PR_CAPTURE)],
        },
        pullRequestStatusByContainer: {},
      });
      await render();

      // Debounced: selecting the archive alone does not hit GitHub.
      expect(refreshPullRequestsMock).not.toHaveBeenCalled();
      await flushRefreshDebounce();
      expect(refreshPullRequestsMock).toHaveBeenCalledTimes(1);
      expect(refreshPullRequestsMock).toHaveBeenCalledWith({
        projectId: 'ws-1',
        containerId: 'container-1',
      });

      // Live state wins over the archive-time capture.
      const badge = container.querySelector(
        '[data-testid="archived-pr-repo-a"]',
      );
      expect(badge?.textContent).toBe('#42');
      await hoverBadge('repo-a');
      const tooltip = document.body.querySelector(
        '[data-testid="archived-pr-tooltip-repo-a"]',
      );
      expect(tooltip?.textContent).toContain('CI checks');
      expect(tooltip?.textContent).toContain('Passing');
      expect(tooltip?.textContent).toContain('Approved');

      // Re-opening the same archive inside the TTL costs nothing.
      await render();
      await flushRefreshDebounce();
      expect(refreshPullRequestsMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the captured badge when the live refresh fails or finds nothing', async () => {
      refreshPullRequestsMock.mockRejectedValue(new Error('offline'));
      useArchivedContainersStore.setState({
        byWorkspace: {
          'ws-1': [v2Summary(COMPLETE_GIT_CHANGES, {}, SINGLE_OPEN_PR_CAPTURE)],
        },
        pullRequestStatusByContainer: {},
      });
      await render();
      await flushRefreshDebounce();

      expect(refreshPullRequestsMock).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector('[data-testid="archived-pr-repo-a"]')
          ?.textContent,
      ).toBe('#42');
      expect(addToastMock).not.toHaveBeenCalled();
    });

    it('never refreshes an archive whose capture confirmed there is no PR', async () => {
      useArchivedContainersStore.setState({
        byWorkspace: { 'ws-1': [v2Summary(COMPLETE_GIT_CHANGES)] },
        pullRequestStatusByContainer: {},
      });
      await render();
      await flushRefreshDebounce();

      expect(refreshPullRequestsMock).not.toHaveBeenCalled();
    });
  });
});

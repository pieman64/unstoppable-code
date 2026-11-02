import type {
  AgentArtifactCarryByTurn,
  CanopyApi,
  ChatCommandRequest,
  ChatCommandResult,
  GitHubWorkflowRunArtifactReceiptV1,
} from '@canopy/desktop-shared/types';
import { buildGitHubWorkflowRunArtifactReceipt } from '@canopy/desktop-shared/lib/agent-artifacts';
import { createEmptyTab } from '../chat/tab-utils';
import type * as ChatStoreModule from '../chatStore';

// Kept out of the chatStore.revisioned*.test.ts files, which each stay under
// about 50 tests to bound the Jest worker heap (see
// chatStoreRevisionedHarness.ts).
const commandMock = jest.fn<Promise<ChatCommandResult>, [ChatCommandRequest]>();

declare global {
  interface Window {
    api: CanopyApi;
  }
}

function loadChatStore(): typeof ChatStoreModule {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: { api: { chat: { command: commandMock } } },
  });
  return jest.requireActual<typeof ChatStoreModule>('../chatStore');
}

const KEY = 'proj/wt';
const target = { projectId: 'proj', worktreeId: 'wt', chatId: 'chat-1' };
const startedAt = '2026-07-20T00:00:00.000Z';
const inProgress = { kind: 'intermediate', status: 'in_progress' } as const;
const success = { kind: 'terminal', conclusion: 'success' } as const;

function run(
  createdAt: string,
  observedAt: string,
  state: GitHubWorkflowRunArtifactReceiptV1['state'],
  {
    runAttempt = 1,
    runId = '101',
    jobObservedAt,
  }: { runAttempt?: number; runId?: string; jobObservedAt?: string } = {},
): GitHubWorkflowRunArtifactReceiptV1 {
  return buildGitHubWorkflowRunArtifactReceipt({
    operation: 'github.watch',
    createdAt,
    watcherId: 'watcher-ci',
    repository: 'acme/api',
    runId,
    runAttempt,
    htmlUrl: `https://github.com/acme/api/actions/runs/${runId}`,
    state,
    observedAt,
    ...(jobObservedAt
      ? {
          jobs: [
            {
              jobId: '501',
              name: 'Build',
              status: 'completed',
              conclusion: 'success',
              htmlUrl: `https://github.com/acme/api/actions/runs/${runId}/job/501`,
              observedAt: jobObservedAt,
            },
          ],
        }
      : {}),
    navigationTarget: {
      kind: 'github_workflow_run',
      repository: 'acme/api',
      runId,
      htmlUrl: `https://github.com/acme/api/actions/runs/${runId}`,
    },
  });
}

function seedTab(
  useChatStore: typeof ChatStoreModule.useChatStore,
  agentArtifactCarryByTurn: AgentArtifactCarryByTurn,
): void {
  useChatStore.setState({
    selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    worktreeChats: {
      [KEY]: {
        activeTabId: 'chat-1',
        tabs: [
          {
            ...createEmptyTab({ model: 'claude-sonnet-4-6' }),
            id: 'chat-1',
            title: 'Chat',
            messages: ['turn-1', 'watcher-turn', 'turn-3', 'turn-4'].map(
              (id, index) => ({
                id,
                role: 'user',
                blocks: [{ type: 'text', text: id }],
                timestamp: index + 1,
              }),
            ),
            status: 'idle',
            error: null,
            createdAt: startedAt,
            queuedMessages: [],
            planMode: false,
            proposalMode: 'optional',
            thinkingLevel: 'high',
            model: 'claude-sonnet-4-6',
            providerType: 'claude',
            agentArtifactCarryByTurn,
          },
        ],
      },
    },
    chatStateSync: { [KEY]: { phase: 'live', revision: 1 } },
  });
}

describe('chatStore recordAgentArtifactCarry', () => {
  beforeEach(() => {
    commandMock.mockReset();
    commandMock.mockImplementation((request) =>
      Promise.resolve({
        commandId: request.commandId,
        revision: 2,
        outcome: 'applied',
      }),
    );
  });

  afterEach(() => {
    jest.resetModules();
  });

  it("brings an earlier turn's carried run up to the finished snapshot", () => {
    // A job event delivers a watcher turn while the run is still going, so
    // the pinned section carries the run on both turns. The run then finishes
    // under the later turn; the earlier turn must not keep "in progress".
    const { useChatStore } = loadChatStore();
    // Another run the first turn watched is never touched.
    const otherRun = run(startedAt, startedAt, inProgress, { runId: '202' });
    seedTab(useChatStore, {
      'turn-1': [run(startedAt, startedAt, inProgress), otherRun],
      'watcher-turn': [run(startedAt, startedAt, inProgress)],
      // A later attempt of the same run is left to its own turn.
      'turn-3': [
        run(
          '2026-07-20T00:05:00.000Z',
          '2026-07-20T00:05:00.000Z',
          inProgress,
          {
            runAttempt: 2,
          },
        ),
      ],
    });
    const carry = (): AgentArtifactCarryByTurn | undefined =>
      useChatStore.getState().worktreeChats[KEY]?.tabs[0]
        ?.agentArtifactCarryByTurn;

    const finished = run(startedAt, '2026-07-20T00:02:00.000Z', success);
    useChatStore
      .getState()
      .recordAgentArtifactCarry(target, 'watcher-turn', [finished]);

    expect(carry()?.['watcher-turn']).toEqual([finished]);
    expect(carry()?.['turn-1']).toEqual([finished, otherRun]);
    expect(carry()?.['turn-3']?.[0]).toMatchObject({
      runAttempt: 2,
      state: inProgress,
    });
    expect(commandMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId: 'proj',
        worktreeId: 'wt',
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { agentArtifactCarryByTurn: carry() },
        },
      }),
    );

    // A job cursor that advances without a new run snapshot still counts.
    const jobAdvanced = run(startedAt, '2026-07-20T00:02:00.000Z', success, {
      jobObservedAt: '2026-07-20T00:03:00.000Z',
    });
    useChatStore
      .getState()
      .recordAgentArtifactCarry(target, 'watcher-turn', [jobAdvanced]);
    expect(carry()?.['turn-1']).toEqual([jobAdvanced, otherRun]);

    // An older observation recorded later never regresses the other turns.
    useChatStore
      .getState()
      .recordAgentArtifactCarry(target, 'turn-4', [
        run(startedAt, '2026-07-20T00:01:00.000Z', inProgress),
      ]);
    expect(carry()?.['turn-1']).toEqual([jobAdvanced, otherRun]);
    expect(carry()?.['watcher-turn']).toEqual([jobAdvanced]);
  });
});

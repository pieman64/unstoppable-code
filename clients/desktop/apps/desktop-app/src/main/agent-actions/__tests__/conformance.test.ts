// Runs the shared agent action conformance suite against the desktop host:
// the real desktop surface, environment port, and dispatcher, over in-memory
// chat state, workspace reads, renderer bridge, and watcher service.

interface MockWatcher {
  id: string;
  trigger: string;
  status: 'active';
  label: string;
  target: Record<string, unknown> & { kind: string; chatId?: string };
  destination: { projectId: string; worktreeId: string; chatId: string };
  createdByToolUseId?: string;
}

const mockWatcherState: {
  watchers: MockWatcher[];
  /** Fired watchers stay findable by the key that armed them. */
  fired: MockWatcher[];
  isIdle: (target: MockWatcher['target']) => boolean;
  /** Whether a chat's turn finished; null names the chat's first turn. */
  turnFinished: (
    target: MockWatcher['target'],
    turnUserMessageId: string | null,
  ) => boolean;
  next: number;
  /** Rejects the next watcher setup, as a service failure would. */
  failNextSetup: boolean;
} = {
  failNextSetup: false,
  watchers: [],
  fired: [],
  isIdle: () => false,
  turnFinished: () => false,
  next: 0,
};

let mockChatPort: unknown = null;

jest.mock('../../lib/workspace-registry', () => ({
  ...jest.requireActual<object>('../../lib/workspace-registry'),
  isCoworkWorkspace: (): boolean => false,
}));

jest.mock('../../project-discovery/bots', () => ({
  isBotAccessAllowed: (): Promise<boolean> => Promise.resolve(false),
}));

jest.mock('../../ipc/chat-state', () => ({
  ...jest.requireActual<object>('../../ipc/chat-state'),
  getChatStateCommandPort: (): unknown => mockChatPort,
}));

jest.mock('../../app-advisor/watchers', () => {
  const sameDestination = (
    watcher: MockWatcher,
    destination: MockWatcher['destination'],
  ): boolean => watcher.destination.chatId === destination.chatId;
  const summary = (watcher: MockWatcher): Record<string, unknown> => ({
    ...watcher,
  });
  return {
    getAppAdvisorWatcherService: (): object => ({
      fireIfTurnSettled: (
        watcherId: string,
        destination: MockWatcher['destination'],
        turnUserMessageId: string | null,
      ): Promise<boolean> => {
        const watcher = mockWatcherState.watchers.find(
          (candidate) =>
            candidate.id === watcherId &&
            sameDestination(candidate, destination),
        );
        if (
          !watcher ||
          !mockWatcherState.turnFinished(watcher.target, turnUserMessageId)
        ) {
          return Promise.resolve(false);
        }
        mockWatcherState.watchers = mockWatcherState.watchers.filter(
          (candidate) => candidate !== watcher,
        );
        mockWatcherState.fired.push(watcher);
        return Promise.resolve(true);
      },
      search: (
        input: { includeActive?: boolean },
        destination: MockWatcher['destination'],
      ): Promise<object> =>
        Promise.resolve({
          catalog: [],
          activeWatchers:
            input.includeActive === false
              ? []
              : mockWatcherState.watchers
                  .filter((watcher) => sameDestination(watcher, destination))
                  .map(summary),
        }),
      // Chat watchers as SearchWatchers lists them: the canonical projection.
      projectCanonicalChatWatchers: (recipient: {
        destination: MockWatcher['destination'];
      }): Promise<object[]> =>
        Promise.resolve(
          mockWatcherState.watchers
            .filter((watcher) =>
              sameDestination(watcher, recipient.destination),
            )
            .map((watcher) => ({
              id: watcher.id,
              trigger: 'project_task_chat_completion',
              status: watcher.status,
              target: {
                projectId: watcher.target.projectId,
                taskId: watcher.target.worktreeId,
                chatId: watcher.target.chatId,
              },
            })),
        ),
      list: (destination: MockWatcher['destination']): Promise<object[]> =>
        Promise.resolve(
          mockWatcherState.watchers
            .filter((watcher) => sameDestination(watcher, destination))
            .map(summary),
        ),
      findWatcherCreatedBy: (
        toolUseId: string,
        destination: MockWatcher['destination'],
      ): Promise<object | null> => {
        const found = [
          ...mockWatcherState.watchers,
          ...mockWatcherState.fired,
        ].find(
          (watcher) =>
            watcher.createdByToolUseId === toolUseId &&
            sameDestination(watcher, destination),
        );
        return Promise.resolve(found ? summary(found) : null);
      },
      setup: (
        input: {
          watchers: {
            trigger: string;
            label?: string;
            target: MockWatcher['target'];
            armForNextCompletion?: boolean;
            allowDuplicate?: boolean;
          }[];
        },
        destination: MockWatcher['destination'],
        context?: { toolUseId?: string },
      ): Promise<object> => {
        if (mockWatcherState.failNextSetup) {
          mockWatcherState.failNextSetup = false;
          return Promise.resolve({
            ok: false,
            error: 'The watcher could not be saved.',
            rejectedIndex: 0,
          });
        }
        for (let index = 0; index < input.watchers.length; index += 1) {
          const entry = input.watchers[index];
          if (!entry) continue;
          if (entry.target.chatId === destination.chatId) {
            return Promise.resolve({
              ok: false,
              error: 'A chat watcher cannot watch itself.',
              rejectedIndex: index,
            });
          }
          if (
            entry.armForNextCompletion !== true &&
            mockWatcherState.isIdle(entry.target)
          ) {
            return Promise.resolve({
              ok: false,
              error: 'The target chat is idle.',
              rejectedIndex: index,
            });
          }
        }
        // Mirrors the service's dedupe key: trigger, target, and destination.
        const dedupeKey = (
          trigger: string,
          target: MockWatcher['target'],
        ): string => JSON.stringify({ trigger, target, destination });
        const results = input.watchers.map((entry): object => {
          const existing =
            entry.allowDuplicate === true
              ? undefined
              : mockWatcherState.watchers.find(
                  (watcher) =>
                    dedupeKey(watcher.trigger, watcher.target) ===
                    dedupeKey(entry.trigger, entry.target),
                );
          if (existing) {
            return { status: 'deduped', watcher: summary(existing) };
          }
          mockWatcherState.next += 1;
          const watcher: MockWatcher = {
            id: `watcher-${mockWatcherState.next}`,
            trigger: entry.trigger,
            status: 'active',
            label: entry.label ?? '',
            target: entry.target,
            destination,
            ...(context?.toolUseId
              ? { createdByToolUseId: context.toolUseId }
              : {}),
          };
          mockWatcherState.watchers.push(watcher);
          return { status: 'created', watcher: summary(watcher) };
        });
        return Promise.resolve({ ok: true, results });
      },
      deleteAgentWatchers: (
        input: { watcherIds: string[] },
        destination: MockWatcher['destination'],
      ): Promise<object> =>
        Promise.resolve({
          ok: true,
          results: input.watcherIds.map((watcherId) => {
            const index = mockWatcherState.watchers.findIndex(
              (watcher) =>
                watcher.id === watcherId &&
                sameDestination(watcher, destination),
            );
            if (index < 0) return { watcherId, status: 'not_found' };
            mockWatcherState.watchers.splice(index, 1);
            return { watcherId, status: 'deleted' };
          }),
        }),
    }),
  };
});

import {
  createInMemoryAgentActionLimits,
  createInMemoryAgentActionReceipts,
  AgentPortError,
  type AgentActionCall,
  type AgentExperimentWriteResult,
  type AgentModelList,
} from '@canopy/agent-actions';
import { z } from 'zod';
import {
  createLimitCommitFailures,
  createWriteHolds,
  loadConformanceWorld,
  runAgentActionConformance,
  type AgentConformanceWorldControl,
  type AgentConformanceWriteHold,
  type ConformanceWorld,
} from '@canopy/agent-actions/conformance';
import type {
  ChatCommandRequest,
  ChatCommandResult,
  ChatSendMessageRequest,
  ChatStateCommandPort,
  ChatStateSnapshot,
  PersistedChatMessage,
  PersistedChatTab,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import {
  createDesktopEnvironmentPort,
  desktopEnvironmentPortDeps,
  type DesktopRendererActionResult,
} from '../desktop-environment-port';
import {
  createDesktopAgentLineage,
  DESKTOP_AGENT_ACTION_LIMITS,
} from '../desktop-limits-port';
import { chatSendAdmissionCheck } from '../../services/chat-send-admission';
import { createDesktopSplitPort } from '../desktop-split-port';
import { createDesktopSettingsPort } from '../desktop-settings-port';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { createDesktopAgentActionSurface } from '../desktop-surface';
import { desktopAgentActionCapabilities } from '../desktop-surface';
import { desktopChatWatcherPort } from '../desktop-watcher-port';
import { seedEmptyApprovalRuleSources } from '../../__tests__/helpers/approval-rule-sources';

const CREATED_AT = '2026-01-01T00:00:00.000Z';

interface ScopeState {
  revision: number;
  tabs: PersistedChatTab[];
  archives: ChatStateSnapshot['archives'];
  running: Set<string>;
  // Each chat's running turn and the turns queued behind it, by user message.
  turns: Map<string, string[]>;
}

function textMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string,
): PersistedChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp: 0 };
}

function makeDesktopHost(world: ConformanceWorld): {
  surface: ReturnType<typeof createDesktopAgentActionSurface>;
  runtime: CanopyInjectedToolRuntime;
  control: AgentConformanceWorldControl;
  /** Chats the host started that the world did not seed. */
  startedChatIds: () => string[];
} {
  const workspaceId = world.workspace.workspaceId;
  const scopes = new Map<string, ScopeState>();
  const scope = (projectId: string, worktreeId: string): ScopeState => {
    const key = `${projectId}/${worktreeId}`;
    let state = scopes.get(key);
    if (!state) {
      state = {
        revision: 0,
        tabs: [],
        archives: [],
        running: new Set(),
        turns: new Map(),
      };
      scopes.set(key, state);
    }
    return state;
  };
  for (const chat of world.chats) {
    const state = scope(workspaceId, chat.worktreeId);
    if (chat.state === 'archived') {
      state.archives.push({
        chatId: chat.chatId,
        title: chat.title,
        archivedAt: CREATED_AT,
        createdAt: CREATED_AT,
        turnCount: 1,
        unread: false,
        restorable: true,
      });
      continue;
    }
    state.tabs.push({
      id: chat.chatId,
      title: chat.title,
      createdAt: CREATED_AT,
      model: chat.modelId,
      messages: chat.lastResponse
        ? [
            textMessage(`${chat.chatId}-ask`, 'user', 'Review it.'),
            textMessage(`${chat.chatId}-reply`, 'assistant', chat.lastResponse),
          ]
        : [],
    });
    if (chat.state === 'running') {
      state.running.add(chat.chatId);
      state.turns.set(chat.chatId, [`${chat.chatId}-seeded-turn`]);
    }
  }
  scope(world.foreign.workspaceId, world.foreign.worktreeId).tabs.push({
    id: world.foreign.chatId,
    title: 'Foreign chat',
    createdAt: CREATED_AT,
    messages: [],
  });

  const worktrees = new Map<string, WorktreeData[]>([
    [
      workspaceId,
      world.worktrees.map((worktree) => ({
        id: worktree.worktreeId,
        branchName: worktree.branch,
        label: worktree.name,
        createdAt: CREATED_AT,
        trackedBaseBranch: null,
      })),
    ],
    [
      world.foreign.workspaceId,
      [
        {
          id: world.foreign.worktreeId,
          branchName: 'foreign',
          createdAt: CREATED_AT,
          trackedBaseBranch: null,
        },
      ],
    ],
  ]);

  const submitTurn = (
    state: ScopeState,
    chatId: string,
    userMessageId: string,
  ): void => {
    state.running.add(chatId);
    state.turns.set(chatId, [
      ...(state.turns.get(chatId) ?? []),
      userMessageId,
    ]);
  };

  const findTab = (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): PersistedChatTab | undefined =>
    scope(projectId, worktreeId).tabs.find((tab) => tab.id === chatId);

  const result = (
    request: ChatCommandRequest,
    state: ScopeState,
    outcome: ChatCommandResult['outcome'],
  ): ChatCommandResult => ({
    commandId: request.commandId,
    revision: state.revision,
    outcome,
  });

  const port: ChatStateCommandPort = {
    getState: (request) => {
      const state = scope(request.projectId, request.worktreeId);
      const runtimeByChatId: ChatStateSnapshot['runtimeByChatId'] = {};
      state.running.forEach((chatId) => {
        runtimeByChatId[chatId] = { status: 'streaming', queuedMessageIds: [] };
      });
      return Promise.resolve({
        schemaVersion: 1,
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        revision: state.revision,
        tabsFile: {
          version: 1,
          activeTabId: state.tabs[0]?.id ?? '',
          tabs: state.tabs,
        },
        archives: state.archives,
        runtimeByChatId,
        queue: [],
      });
    },
    getTranscriptPage: (request): Promise<TranscriptPage> => {
      const tab = findTab(
        request.projectId,
        request.worktreeId,
        request.chatId,
      );
      const messages = tab?.messages ?? [];
      return Promise.resolve({
        messages,
        totalMessages: messages.length,
        transcriptRevision: 0,
      });
    },
    searchTranscript: () => Promise.reject(new Error('unused')),
    readToolOutput: () => Promise.reject(new Error('unused')),
    subscribe: () => () => undefined,
    command: (request) => {
      const state = scope(request.projectId, request.worktreeId);
      const command = request.command;
      state.revision += 1;
      switch (command.type) {
        case 'chat.create_tab':
          state.tabs.push({
            id: command.tabId,
            title: command.title ?? 'New Chat',
            createdAt: CREATED_AT,
            messages: [],
            ...(command.model ? { model: command.model } : {}),
          });
          return Promise.resolve({
            ...result(request, state, 'applied'),
            entityId: command.tabId,
          });
        case 'chat.patch_tab_settings': {
          const tab = state.tabs.find((entry) => entry.id === command.tabId);
          if (!tab) return Promise.resolve(result(request, state, 'not_found'));
          if (command.patch.title) tab.title = command.patch.title;
          return Promise.resolve(result(request, state, 'applied'));
        }
        case 'chat.send_message': {
          const tab = state.tabs.find((entry) => entry.id === command.chatId);
          if (!tab) return Promise.resolve(result(request, state, 'not_found'));
          const refusal = chatSendAdmissionCheck({
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            chatId: command.chatId,
            userMessageId: command.userMessageId,
          })?.(tab);
          if (refusal !== undefined) {
            return Promise.resolve({
              ...result(request, state, 'rejected'),
              reason: refusal,
            });
          }
          tab.messages.push(
            textMessage(command.userMessageId, 'user', command.text),
          );
          submitTurn(state, command.chatId, command.userMessageId);
          return Promise.resolve(result(request, state, 'applied'));
        }
        default:
          return Promise.resolve(result(request, state, 'rejected'));
      }
    },
  };
  mockChatPort = port;
  mockWatcherState.watchers = [];
  mockWatcherState.fired = [];
  mockWatcherState.failNextSetup = false;
  mockWatcherState.isIdle = (target): boolean => {
    const projectId =
      typeof target.projectId === 'string' ? target.projectId : '';
    const worktreeId =
      typeof target.worktreeId === 'string' ? target.worktreeId : '';
    return !scope(projectId, worktreeId).running.has(target.chatId ?? '');
  };
  mockWatcherState.turnFinished = (target, turnUserMessageId): boolean => {
    const projectId =
      typeof target.projectId === 'string' ? target.projectId : '';
    const worktreeId =
      typeof target.worktreeId === 'string' ? target.worktreeId : '';
    const chatId = target.chatId ?? '';
    const userMessageId =
      turnUserMessageId ??
      findTab(projectId, worktreeId, chatId)?.messages.find(
        (message) => message.role === 'user',
      )?.id;
    return (
      userMessageId !== undefined &&
      findTab(projectId, worktreeId, chatId)?.messages.some(
        (message) => message.id === userMessageId,
      ) === true &&
      !(scope(projectId, worktreeId).turns.get(chatId) ?? []).includes(
        userMessageId,
      )
    );
  };

  const dispatcher = createDesktopRuntime({
    workspaceServices: {
      readAllSidebarItems: jest
        .fn()
        .mockResolvedValue({ version: 1, items: [] }),
      readWorkspaceIndexEntry: jest.fn((id: string) =>
        Promise.resolve(
          worktrees.has(id)
            ? {
                id,
                name:
                  id === workspaceId
                    ? world.workspace.name
                    : 'Foreign workspace',
                type: 'multi-repo',
              }
            : null,
        ),
      ),
      readWorkspaceConfig: jest
        .fn()
        .mockResolvedValue({ version: 1, type: 'multi-repo', repos: [] }),
      readEffectiveWorkspaceConfig: jest.fn().mockResolvedValue({
        repos: world.workspace.repositories.map((repository) => ({
          id: repository.repoId,
          manifestUrl: repository.remoteUrl,
        })),
      }),
      readWorkspaceWorktrees: jest.fn((id: string) =>
        Promise.resolve(worktrees.get(id) ?? []),
      ),
    },
    getChatStatePort: () => port,
    chatServices: { getPort: () => port },
    chatCommandPort: port,
  });

  let created = 0;
  let rendererSends = 0;
  const rendererAction = (
    action: { type: string } & Record<string, unknown>,
  ): Promise<DesktopRendererActionResult> => {
    if (action.type === 'worktree.create') {
      created += 1;
      const worktreeId = `agent-worktree-${created}`;
      worktrees.get(workspaceId)?.push({
        id: worktreeId,
        branchName: worktreeId,
        createdAt: CREATED_AT,
        trackedBaseBranch: null,
      });
      return Promise.resolve({
        ok: true,
        result: { workspaceId, worktreeId },
      });
    }
    if (
      action.type === 'worktree-chat.send_message' &&
      typeof action.worktreeId === 'string' &&
      typeof action.chatId === 'string'
    ) {
      rendererSends += 1;
      const userMessageId = `renderer-turn-${rendererSends}`;
      findTab(workspaceId, action.worktreeId, action.chatId)?.messages.push(
        textMessage(
          userMessageId,
          'user',
          typeof action.text === 'string' ? action.text : '',
        ),
      );
      submitTurn(
        scope(workspaceId, action.worktreeId),
        action.chatId,
        userMessageId,
      );
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({ ok: false, error: { message: 'Unsupported.' } });
  };

  const lineage = createDesktopAgentLineage();
  lineage.record(world.current.chatId, world.callerDepth);
  const withdrawnModels = new Set<string>();
  const holds = createWriteHolds();
  const commitFailures = createLimitCommitFailures();
  let clock = Date.parse(CREATED_AT);
  const models = (): AgentModelList => ({
    models: world.models.map((model) => ({
      id: model.id,
      label: model.label,
      provider: model.provider,
      kind: 'model',
      available: !withdrawnModels.has(model.id),
      isDefault: model.id === world.defaultModelId,
      thinkingLevels: [...model.thinkingLevels],
    })),
    defaultModelId: world.defaultModelId,
  });
  // The chat state owner's trusted-send materialization: a background tab,
  // created once, that the first send adopts.
  const reserveTab = (request: ChatSendMessageRequest): PersistedChatTab => {
    const existing = findTab(
      request.projectId,
      request.worktreeId,
      request.chatId,
    );
    if (existing) return existing;
    const tab: PersistedChatTab = {
      id: request.chatId,
      title: request.title ?? request.text.slice(0, 60),
      createdAt: CREATED_AT,
      messages: [],
      ...(request.model ? { model: request.model } : {}),
    };
    scope(request.projectId, request.worktreeId).tabs.push(tab);
    return tab;
  };
  const terminalChats = new Set<string>();
  const conformanceRoot = (chat: {
    workspaceId: string;
    worktreeId: string;
  }): string => `/conformance/${chat.workspaceId}/${chat.worktreeId}`;
  const environment = createDesktopEnvironmentPort({
    runtime: () => dispatcher,
    reserveChat: (request) => {
      reserveTab(request);
      return Promise.resolve();
    },
    messageCommitted: (chat, messageId) =>
      Promise.resolve(
        findTab(chat.workspaceId, chat.worktreeId, chat.chatId)?.messages.some(
          (message) => message.id === messageId,
        ) === true,
      ),
    rendererAction,
    listModels: () => Promise.resolve(models()),
    listWorkEntries: () => Promise.resolve([]),
    chatApprovalPolicy: (chat) =>
      Promise.resolve({
        mode: 'full-access',
        sessionRules: [],
        root: conformanceRoot(chat),
      }),
    newChatApprovalMode: () => Promise.resolve('full-access'),
    liveApprovalMode: (chat, mode, use) =>
      desktopEnvironmentPortDeps().liveApprovalMode(chat, mode, use),
    approvalSettingsRevision: () =>
      desktopEnvironmentPortDeps().approvalSettingsRevision(),
    chatApprovalStateRevision: (chat) =>
      desktopEnvironmentPortDeps().chatApprovalStateRevision(chat),
    effectiveApprovalPolicy: (source, policyCall) =>
      desktopEnvironmentPortDeps().effectiveApprovalPolicy(source, policyCall),
    chatExecutionRoot: (chat) => Promise.resolve(conformanceRoot(chat)),
    terminalDrivenChatIds: (_scope, chatIds) =>
      Promise.resolve(chatIds.filter((chatId) => terminalChats.has(chatId))),
    agentSenderFields: () => Promise.resolve(undefined),
    lineage,
  });

  const runtime: CanopyInjectedToolRuntime = {
    requestUserAnswers: () => Promise.resolve([]),
    loadScriptOutput: () => Promise.resolve({ found: false, lines: [] }),
    worktreeActionRuntime: {
      projectId: world.current.workspaceId,
      worktreeId: world.current.worktreeId,
      chatId: world.current.chatId,
      cwd: '/conformance/worktree',
      getWindow: () => null,
    },
    worktreeWatcherRuntime: {
      projectId: world.current.workspaceId,
      worktreeId: world.current.worktreeId,
      chatId: world.current.chatId,
    },
  };
  const openedSettings: unknown[] = [];
  const control: AgentConformanceWorldControl = {
    setChatMessageable: (chatId, messageable): Promise<void> => {
      if (messageable) terminalChats.delete(chatId);
      else terminalChats.add(chatId);
      return Promise.resolve();
    },
    archiveChat: (chatId): Promise<void> => {
      scopes.forEach((state) => {
        const index = state.tabs.findIndex((tab) => tab.id === chatId);
        const tab = state.tabs[index];
        if (!tab) return;
        state.tabs.splice(index, 1);
        state.running.delete(chatId);
        state.revision += 1;
        state.archives.push({
          chatId,
          title: tab.title,
          archivedAt: CREATED_AT,
          createdAt: CREATED_AT,
          turnCount: 1,
          unread: false,
          restorable: true,
        });
      });
      return Promise.resolve();
    },
    withdrawModel: (modelId): Promise<void> => {
      withdrawnModels.add(modelId);
      return Promise.resolve();
    },
    advanceClock: (ms): Promise<void> => {
      clock += ms;
      return Promise.resolve();
    },
    holdNextChatStart: (): AgentConformanceWriteHold =>
      holds.holdNextChatStart(),
    holdNextMessagePost: (): AgentConformanceWriteHold =>
      holds.holdNextMessagePost(),
    failNextLimitCommit: (): Promise<void> => {
      commitFailures.failNextCommit();
      return Promise.resolve();
    },
    // A completion is stamped with its turn's user message id, so a watcher
    // bound to another turn of the chat stays armed.
    completeTurn: (chatId): Promise<readonly string[]> => {
      let finished: string | undefined;
      scopes.forEach((state) => {
        const queue = state.turns.get(chatId);
        if (finished !== undefined || !queue?.length) return;
        finished = queue.shift();
        if (queue.length === 0) state.running.delete(chatId);
      });
      if (finished === undefined) return Promise.resolve([]);
      const fired = mockWatcherState.watchers.filter(
        (watcher) =>
          watcher.target.chatId === chatId &&
          (watcher.target.turnUserMessageId === undefined ||
            watcher.target.turnUserMessageId === finished),
      );
      mockWatcherState.watchers = mockWatcherState.watchers.filter(
        (watcher) => !fired.includes(watcher),
      );
      mockWatcherState.fired.push(...fired);
      return Promise.resolve(fired.map((watcher) => watcher.id));
    },
    firedWatchers: (): Promise<readonly string[]> =>
      Promise.resolve(mockWatcherState.fired.map((watcher) => watcher.id)),
    openedSettings: (): Promise<readonly unknown[]> =>
      Promise.resolve([...openedSettings]),
  };
  // The calling chat's main window, recording the routes main asks it to open.
  const settingsWindow = {
    isDestroyed: (): boolean => false,
    webContents: {
      isDestroyed: (): boolean => false,
      isCrashed: (): boolean => false,
      mainFrame: { detached: false, isDestroyed: (): boolean => false },
      send: (channel: string, route: unknown): void => {
        if (channel === IPC_CHANNELS.accountOrganizationSettingsOpen)
          openedSettings.push(route);
      },
    },
  };
  const settings = createDesktopSettingsPort({
    readAccount: () =>
      Promise.resolve({
        status: 'signed_in',
        organizationIds: world.organizations.map(
          (organization) => organization.organizationId,
        ),
      }),
    getWindow: () => settingsWindow,
    hostedSettingsEnabled: () => true,
  });
  let forks = 0;
  const receipts =
    createInMemoryAgentActionReceipts<CanopyInjectedToolRuntime>();
  const split = createDesktopSplitPort({
    receipts,
    startSplitAgent: (_kind, _input, source) => {
      forks += 1;
      const chatId = `forked-chat-${forks}`;
      const state = scope(source.projectId, source.worktreeId);
      state.tabs.push({
        id: chatId,
        title: 'Forked chat',
        createdAt: CREATED_AT,
        messages: [],
      });
      submitTurn(state, chatId, `${chatId}-turn`);
      return Promise.resolve({
        ok: true,
        chatId,
        worktreeId: source.worktreeId,
        delivery: 'submitted',
        independent: true,
      });
    },
  });
  const seededChatIds = new Set([
    ...world.chats.map((chat) => chat.chatId),
    world.foreign.chatId,
  ]);
  return {
    runtime,
    control,
    startedChatIds: (): string[] =>
      Array.from(scopes.values()).flatMap((state) =>
        state.tabs
          .map((tab) => tab.id)
          .filter((chatId) => !seededChatIds.has(chatId)),
      ),
    surface: createDesktopAgentActionSurface(runtime, {
      brand: world.brand,
      ports: {
        experiments: {
          setEnabled: (request): Promise<AgentExperimentWriteResult> => {
            if (request.experimentId !== 'early-access')
              return Promise.reject(
                new AgentPortError('invalid_payload', 'Unknown experiment.'),
              );
            return Promise.resolve({
              experimentId: request.experimentId,
              storedChoice: request.enabled,
              effectiveEnabledAtCommit: request.enabled,
              listedAtCommit: true,
              generationAtCommit: 0,
              revisionAtCommit: 1,
            });
          },
        },
        settings,
        environment: holds.wrap(environment),
        limits: commitFailures.wrap(
          createInMemoryAgentActionLimits({
            limits: DESKTOP_AGENT_ACTION_LIMITS,
            now: () => clock,
          }),
        ),
        chatWatchers: desktopChatWatcherPort,
        split,
        receipts,
      },
    }),
  };
}

beforeAll(async () => {
  const world = loadConformanceWorld();
  await seedEmptyApprovalRuleSources([
    world.workspace.workspaceId,
    world.foreign.workspaceId,
  ]);
});

describe('desktop agent action host', () => {
  runAgentActionConformance({ describe, it }, (world) => {
    const host = makeDesktopHost(world);
    return {
      surface: host.surface,
      capabilities: desktopAgentActionCapabilities(host.runtime),
      call: ({
        callingChatId,
        ...identity
      }): AgentActionCall<CanopyInjectedToolRuntime> => {
        const caller = world.chats.find(
          (chat) => chat.chatId === callingChatId,
        );
        return {
          host: host.runtime,
          scope: caller
            ? {
                workspaceId: world.workspace.workspaceId,
                worktreeId: caller.worktreeId,
                chatId: caller.chatId,
              }
            : { ...world.current },
          ...identity,
        };
      },
      control: host.control,
      limitValues: DESKTOP_AGENT_ACTION_LIMITS,
    };
  });
});

describe('desktop agent action host watchers', () => {
  it('fires a chat.create watcher armed after its turn finished, once', async () => {
    const world = loadConformanceWorld();
    const host = makeDesktopHost(world);
    const call = (): AgentActionCall<CanopyInjectedToolRuntime> => ({
      host: host.runtime,
      scope: { ...world.current },
      turnKey: 'settled-turn',
      toolUseId: 'settled-start-tool',
      actorKey: 'desktop-actor',
    });
    const create = (): Promise<{ isError?: boolean; text: string }> =>
      host.surface.execute(
        'dispatch_action',
        {
          action: {
            type: 'chat.create',
            placement: 'current',
            message: 'Review the parser.',
            watchers: [{ label: 'Review finished' }],
          },
        },
        call(),
      );
    const hold = host.control.holdNextChatStart();
    mockWatcherState.failNextSetup = true;
    const timedOut = create();
    await hold.started;
    hold.finish('timeout');
    expect(JSON.parse((await timedOut).text)).toMatchObject({
      ok: false,
      error: { code: 'timeout', retryable: true },
    });
    const started = host.startedChatIds();
    expect(started).toHaveLength(1);
    const [chatId = ''] = started;
    await expect(host.control.completeTurn(chatId)).resolves.toEqual([]);

    const retried = z
      .object({
        ok: z.literal(true),
        result: z.object({
          chatId: z.string(),
          watchers: z.tuple([
            z.object({ ok: z.literal(true), watcherId: z.string() }),
          ]),
        }),
      })
      .parse(JSON.parse((await create()).text));
    expect(retried.result.chatId).toBe(chatId);
    await expect(host.control.firedWatchers()).resolves.toEqual([
      retried.result.watchers[0].watcherId,
    ]);
    expect(mockWatcherState.watchers).toEqual([]);
  });
});

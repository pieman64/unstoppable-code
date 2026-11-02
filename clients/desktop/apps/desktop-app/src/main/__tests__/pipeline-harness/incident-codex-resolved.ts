/** Real-host Codex server-request resolution incident regressions. */
import { EventEmitter } from 'node:events';
import {
  IPC_CHANNELS,
  type ApprovalRule,
  type ChatRuntimeState,
  type ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import type { SendableBrowserWindow } from '../../lib/window-send';
import type * as ApprovalPersistenceModule from '../../lib/approvals-persistence';
import type * as PreferencesStoreModule from '../../lib/preferences-store';
import type {
  PipelineChatTarget,
  PipelineHost,
  PipelineTraceEvent,
  ProviderTraceEvent,
} from './contracts';
import {
  createScenarioEnvironment,
  disposeScenario,
  SCENARIO_TEST_TIMEOUT_MS,
  startRoot,
} from './scenarios';
import {
  getScriptedCodexRootThreadId,
  resolveScriptedCodexServerRequest,
  sendAndResolveScriptedCodexServerRequest,
  sendScriptedCodexServerRequest,
} from './scripted-codex';
import type { PipelineStorage } from './storage';

type CodexEnvironment = Awaited<ReturnType<typeof createScenarioEnvironment>>;

interface CapturedWindowSend {
  channel: string;
  payload: unknown;
}

function createSendableWindow(): {
  window: SendableBrowserWindow;
  sends: CapturedWindowSend[];
} {
  const sends: CapturedWindowSend[] = [];
  const webContents = Object.assign(new EventEmitter(), {
    isCrashed: (): false => false,
    isDestroyed: (): false => false,
    send: (channel: string, payload: unknown): void => {
      sends.push({ channel, payload });
    },
    mainFrame: {
      detached: false,
      isDestroyed: (): false => false,
    },
  });
  return {
    window: {
      isDestroyed: (): false => false,
      webContents,
    },
    sends,
  };
}

async function installSyntheticWindow(
  window: SendableBrowserWindow,
): Promise<void> {
  const promptBridge = await import('../../approvals/prompt-bridge');
  const requestApprovalFromRenderer = promptBridge.requestApprovalFromRenderer;
  jest
    .spyOn(promptBridge, 'requestApprovalFromRenderer')
    .mockImplementation((options) =>
      requestApprovalFromRenderer({ ...options, getWindow: () => window }),
    );

  const questionBridge = await import('../../canopy-tools/session-runtime');
  const requestAnswersFromRenderer = questionBridge.requestAnswersFromRenderer;
  jest
    .spyOn(questionBridge, 'requestAnswersFromRenderer')
    .mockImplementation((options) =>
      requestAnswersFromRenderer({ ...options, getWindow: () => window }),
    );
}

async function createCodexEnvironment(host: PipelineHost): Promise<{
  env: CodexEnvironment;
  storage: PipelineStorage;
}> {
  let storage: PipelineStorage | undefined;
  const env = await createScenarioEnvironment(host, 'codex', {
    prepareStorage: (captured): Promise<void> => {
      storage = captured;
      return Promise.resolve();
    },
  });
  if (!storage) throw new Error('Codex resolved incident requires V2 storage');
  return { env, storage };
}

function isTargetRevision(
  target: PipelineChatTarget,
  event: PipelineTraceEvent,
): event is Extract<PipelineTraceEvent, { kind: 'revision' }> {
  return (
    event.kind === 'revision' &&
    event.projectId === target.projectId &&
    event.worktreeId === target.worktreeId
  );
}

async function waitFor(
  env: CodexEnvironment,
  predicate: () => boolean,
  description: string,
): Promise<void> {
  for (let elapsed = 0; elapsed < 2_000; elapsed += 25) {
    await env.host.drain();
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function providerFrames(env: CodexEnvironment): ProviderTraceEvent[] {
  return env.harness.recorder.events.filter(
    (event): event is ProviderTraceEvent =>
      event.kind === 'provider' &&
      event.provider === 'codex' &&
      event.target.projectId === env.target.projectId &&
      event.target.worktreeId === env.target.worktreeId &&
      event.target.chatId === env.target.chatId,
  );
}

function responseCount(
  env: CodexEnvironment,
  requestId: string | number,
): number {
  return providerFrames(env).filter(
    (event) =>
      event.direction === 'to-provider' &&
      event.type.startsWith('client-response:') &&
      event.ids?.requestId === String(requestId),
  ).length;
}

function completionCount(env: CodexEnvironment, turnKey: string): number {
  return providerFrames(env).filter(
    (event) =>
      event.direction === 'to-canopy' &&
      event.type === 'notification:turn/completed' &&
      event.turnKey === turnKey,
  ).length;
}

function completionTransitionCount(env: CodexEnvironment): number {
  let rootWasActive = false;
  let completions = 0;
  for (const event of env.harness.recorder.events) {
    if (!isTargetRevision(env.target, event)) continue;
    const runtime = event.chats[env.target.chatId]?.runtime;
    if (runtime?.activeTurn !== undefined) rootWasActive = true;
    if (
      rootWasActive &&
      runtime?.status === 'completed' &&
      runtime.activeTurn === undefined
    ) {
      completions += 1;
      rootWasActive = false;
    }
  }
  return completions;
}

function latestRuntimeStatus(env: CodexEnvironment): {
  status: ChatRuntimeState['status'] | undefined;
  activeTurn: ChatRuntimeState['activeTurn'];
} {
  const revision = [...env.harness.recorder.events]
    .reverse()
    .find((event) => isTargetRevision(env.target, event));
  const runtime =
    revision?.kind === 'revision'
      ? revision.chats[env.target.chatId]?.runtime
      : undefined;
  return {
    status: runtime?.status,
    activeTurn: runtime?.activeTurn,
  };
}

async function readQuestionState(
  env: CodexEnvironment,
): Promise<ChatStateSnapshot> {
  const chatState = await import('../../services/chat-state-service');
  return chatState.getChatStateService().getState({
    projectId: env.target.projectId,
    worktreeId: env.target.worktreeId,
  });
}

interface RememberedRuleSnapshot {
  workspace: readonly ApprovalRule[];
  global: readonly ApprovalRule[];
  session: readonly ApprovalRule[];
  workspaceWrites: number;
  globalWrites: number;
}

async function readRememberedRuleSnapshot(
  env: CodexEnvironment,
): Promise<RememberedRuleSnapshot> {
  const approvals = jest.requireMock<typeof ApprovalPersistenceModule>(
    '../../lib/approvals-persistence',
  );
  const preferences = jest.requireMock<typeof PreferencesStoreModule>(
    '../../lib/preferences-store',
  );
  // Harness policy reads are fixed snapshots; also observe the real writers.
  const workspaceWrites = jest.spyOn(approvals, 'addWorkspaceApprovalRule');
  const globalWrites = jest.spyOn(preferences, 'updatePreferencesFile');
  const [workspace, global, state] = await Promise.all([
    approvals.readWorkspaceApprovals(env.target.projectId),
    preferences.readPreferencesFile(),
    readQuestionState(env),
  ]);
  return {
    workspace: workspace.rules,
    global: global.globalApprovalRules,
    session:
      state.tabsFile.tabs.find((tab) => tab.id === env.target.chatId)
        ?.sessionApprovalRules ?? [],
    workspaceWrites: workspaceWrites.mock.calls.length,
    globalWrites: globalWrites.mock.calls.length,
  };
}

async function rememberedRuleChangesSince(
  env: CodexEnvironment,
  before: RememberedRuleSnapshot,
): Promise<number> {
  const after = await readRememberedRuleSnapshot(env);
  return (
    Number(
      JSON.stringify(after.workspace) !== JSON.stringify(before.workspace),
    ) +
    Number(JSON.stringify(after.global) !== JSON.stringify(before.global)) +
    Number(JSON.stringify(after.session) !== JSON.stringify(before.session)) +
    after.workspaceWrites -
    before.workspaceWrites +
    after.globalWrites -
    before.globalWrites
  );
}

async function waitForPendingQuestion(
  env: CodexEnvironment,
  chatId: string,
): Promise<string> {
  for (let elapsed = 0; elapsed < 2_000; elapsed += 25) {
    await env.host.drain();
    const state = await readQuestionState(env);
    const question = (state.tabsFile.pendingQuestions ?? []).find(
      (candidate) =>
        candidate.chatId === chatId && candidate.answeredAt === undefined,
    );
    if (question) return question.requestId;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for the real question prompt to pend');
}

const HOST_CASES = [
  {
    host: 'worktree',
    commandRequestId: 401,
    questionRequestId: 'worktree-question',
  },
  {
    host: 'cowork',
    commandRequestId: 'cowork-command',
    questionRequestId: 402,
  },
  {
    host: 'app-advisor',
    commandRequestId: 403,
    questionRequestId: 'advisor-question',
  },
] as const satisfies readonly {
  host: PipelineHost;
  commandRequestId: string | number;
  questionRequestId: string | number;
}[];

const QUESTION_PARAMS = {
  itemId: 'resolved-user-input-item',
  questions: [
    {
      id: 'choice',
      header: 'Choice',
      question: 'Pick an option',
      isOther: false,
      isSecret: false,
      options: [{ label: 'Option A', description: 'First option' }],
    },
  ],
} as const;

async function runPendingQuestionResolution(
  host: PipelineHost,
  requestId: string | number,
): Promise<void> {
  const { env, storage } = await createCodexEnvironment(host);
  const promptWindow = createSendableWindow();
  try {
    await installSyntheticWindow(promptWindow.window);
    const approvalRequests = await import('../../approvals/pending-approvals');
    const rememberedRulesBefore = await readRememberedRuleSnapshot(env);
    const root = await startRoot(env, `${host} resolved user input`);
    await sendScriptedCodexServerRequest(env.driver, {
      method: 'item/tool/requestUserInput',
      callId: 'resolved-user-input-item',
      requestId,
      params: { ...QUESTION_PARAMS, turnId: root.turnKey },
    });
    const questionId = await waitForPendingQuestion(env, env.target.chatId);
    expect(
      promptWindow.sends.some(
        (send) => send.channel === IPC_CHANNELS.mcpAskUser,
      ),
    ).toBe(true);

    await resolveScriptedCodexServerRequest(env.driver, requestId);
    await root.emitText(`continued after resolved question in ${host}`);
    await root.complete();
    await env.host.drain();

    const state = await readQuestionState(env);
    const result = {
      pendingApprovals: approvalRequests.pendingApprovalRequests(
        promptWindow.window.webContents,
      ).length,
      pendingQuestions: (state.tabsFile.pendingQuestions ?? []).filter(
        (question) =>
          question.chatId === env.target.chatId &&
          question.answeredAt === undefined,
      ).length,
      replies: responseCount(env, requestId),
      rememberedRuleWrites: await rememberedRuleChangesSince(
        env,
        rememberedRulesBefore,
      ),
      questionConsumed: !(state.tabsFile.pendingQuestions ?? []).some(
        (question) => question.requestId === questionId,
      ),
      continuation: storage
        .readCommittedTranscript(env.target)
        .toString('utf8')
        .includes(`continued after resolved question in ${host}`),
      completions: completionCount(env, root.turnKey),
      completionTransitions: completionTransitionCount(env),
      runtime: latestRuntimeStatus(env),
    };
    expect(result).toEqual({
      pendingApprovals: 0,
      pendingQuestions: 0,
      replies: 0,
      rememberedRuleWrites: 0,
      questionConsumed: true,
      continuation: true,
      completions: 1,
      completionTransitions: 1,
      runtime: { status: 'completed', activeTurn: undefined },
    });
  } finally {
    await disposeScenario(env);
  }
}

async function runStaleResolutionsRemainAnswerable(
  host: PipelineHost,
  commandRequestId: string | number,
  questionRequestId: string | number,
): Promise<void> {
  const { env, storage } = await createCodexEnvironment(host);
  const promptWindow = createSendableWindow();
  try {
    await installSyntheticWindow(promptWindow.window);
    const approvalRequests = await import('../../approvals/pending-approvals');
    const chatState = await import('../../services/chat-state-service');
    const rememberedRulesBefore = await readRememberedRuleSnapshot(env);
    const root = await startRoot(env, `${host} stale resolutions`);
    const command = `echo ${host}-stale-command`;
    await sendScriptedCodexServerRequest(env.driver, {
      method: 'item/commandExecution/requestApproval',
      callId: `${host}-stale-command-item`,
      requestId: commandRequestId,
      params: {
        kind: 'command',
        turnId: root.turnKey,
        itemId: `${host}-stale-command-item`,
        command,
        cwd: '/tmp',
      },
    });
    await waitFor(
      env,
      () =>
        approvalRequests.pendingApprovalRequests(
          promptWindow.window.webContents,
        ).length === 1,
      'the real command approval prompt to pend',
    );
    await sendScriptedCodexServerRequest(env.driver, {
      method: 'item/tool/requestUserInput',
      callId: `${host}-stale-question-item`,
      requestId: questionRequestId,
      params: {
        ...QUESTION_PARAMS,
        itemId: `${host}-stale-question-item`,
        turnId: root.turnKey,
      },
    });
    const pendingQuestionId = await waitForPendingQuestion(
      env,
      env.target.chatId,
    );
    const pendingApproval = approvalRequests.pendingApprovalRequests(
      promptWindow.window.webContents,
    )[0];
    if (!pendingApproval) {
      throw new Error('Expected the command approval prompt to remain pending');
    }

    await resolveScriptedCodexServerRequest(env.driver, commandRequestId, {
      threadId: 'mismatched-thread',
    });
    await resolveScriptedCodexServerRequest(env.driver, questionRequestId, {
      threadId: 'mismatched-question-thread',
    });
    const liveThreadId = getScriptedCodexRootThreadId(env.driver);
    if (!liveThreadId) throw new Error('Expected the live Codex root thread');
    await resolveScriptedCodexServerRequest(env.driver, 'unknown-request-id', {
      threadId: liveThreadId,
    });
    await env.host.drain();
    const stateBeforeAnswers = await chatState.getChatStateService().getState({
      projectId: env.target.projectId,
      worktreeId: env.target.worktreeId,
    });
    const unansweredQuestions = (
      stateBeforeAnswers.tabsFile.pendingQuestions ?? []
    ).filter(
      (question) =>
        question.chatId === env.target.chatId &&
        question.answeredAt === undefined,
    );
    expect({
      pendingApproval: approvalRequests
        .pendingApprovalRequests(promptWindow.window.webContents)
        .some((request) => request.requestId === pendingApproval.requestId),
      pendingQuestion: unansweredQuestions.some(
        (question) => question.requestId === pendingQuestionId,
      ),
      commandReplies: responseCount(env, commandRequestId),
      questionReplies: responseCount(env, questionRequestId),
      rememberedRuleWrites: await rememberedRuleChangesSince(
        env,
        rememberedRulesBefore,
      ),
    }).toEqual({
      pendingApproval: true,
      pendingQuestion: true,
      commandReplies: 0,
      questionReplies: 0,
      rememberedRuleWrites: 0,
    });

    const commandAnswered = approvalRequests.resolveApproval(
      pendingApproval.requestId,
      { behavior: 'allow', scope: 'once' },
      promptWindow.window.webContents,
      env.target,
    );
    const questionAnswered = await chatState
      .getChatStateService()
      .answerPendingQuestion(pendingQuestionId, [
        {
          questionId: 'choice',
          question: 'Pick an option',
          selectedOptions: ['Option A'],
        },
      ]);
    expect({ commandAnswered, questionAnswered }).toEqual({
      commandAnswered: true,
      questionAnswered: true,
    });
    await env.host.drain();
    await root.emitText(`continued after stale resolution in ${host}`);
    await root.complete();
    await env.host.drain();

    const result = {
      pendingApprovals: approvalRequests.pendingApprovalRequests(
        promptWindow.window.webContents,
      ).length,
      pendingQuestions:
        (await readQuestionState(env)).tabsFile.pendingQuestions?.filter(
          (question) =>
            question.chatId === env.target.chatId &&
            question.answeredAt === undefined,
        ).length ?? 0,
      commandReplies: responseCount(env, commandRequestId),
      questionReplies: responseCount(env, questionRequestId),
      rememberedRuleWrites: await rememberedRuleChangesSince(
        env,
        rememberedRulesBefore,
      ),
      continuation: storage
        .readCommittedTranscript(env.target)
        .toString('utf8')
        .includes(`continued after stale resolution in ${host}`),
      completions: completionCount(env, root.turnKey),
      completionTransitions: completionTransitionCount(env),
      runtime: latestRuntimeStatus(env),
    };
    expect(result).toEqual({
      pendingApprovals: 0,
      pendingQuestions: 0,
      commandReplies: 1,
      questionReplies: 1,
      rememberedRuleWrites: 0,
      continuation: true,
      completions: 1,
      completionTransitions: 1,
      runtime: { status: 'completed', activeTurn: undefined },
    });
  } finally {
    await disposeScenario(env);
  }
}

async function runPendingCommandResolution(
  host: PipelineHost,
  requestId: string | number,
): Promise<void> {
  const { env, storage } = await createCodexEnvironment(host);
  const promptWindow = createSendableWindow();
  try {
    await installSyntheticWindow(promptWindow.window);
    const approvalRequests = await import('../../approvals/pending-approvals');
    const rememberedRulesBefore = await readRememberedRuleSnapshot(env);
    const root = await startRoot(env, `${host} resolved command approval`);
    const command = `echo ${host}-resolved-command`;
    const commandItemId = `${host}-resolved-command-item`;
    await sendScriptedCodexServerRequest(env.driver, {
      method: 'item/commandExecution/requestApproval',
      callId: commandItemId,
      requestId,
      params: {
        kind: 'command',
        turnId: root.turnKey,
        itemId: commandItemId,
        command,
        cwd: '/tmp',
      },
    });
    await waitFor(
      env,
      () =>
        approvalRequests.pendingApprovalRequests(
          promptWindow.window.webContents,
        ).length === 1,
      'the real command approval prompt to pend',
    );
    expect(
      promptWindow.sends.some(
        (send) => send.channel === IPC_CHANNELS.approvalRequest,
      ),
    ).toBe(true);

    await resolveScriptedCodexServerRequest(env.driver, requestId);
    await root.emitText(`continued after resolved command in ${host}`);
    await root.complete();
    await env.host.drain();
    const state = await readQuestionState(env);
    const result = {
      pendingApprovals: approvalRequests.pendingApprovalRequests(
        promptWindow.window.webContents,
      ).length,
      pendingQuestions: (state.tabsFile.pendingQuestions ?? []).filter(
        (question) =>
          question.chatId === env.target.chatId &&
          question.answeredAt === undefined,
      ).length,
      replies: responseCount(env, requestId),
      rememberedRuleWrites: await rememberedRuleChangesSince(
        env,
        rememberedRulesBefore,
      ),
      continuation: storage
        .readCommittedTranscript(env.target)
        .toString('utf8')
        .includes(`continued after resolved command in ${host}`),
      completions: completionCount(env, root.turnKey),
      completionTransitions: completionTransitionCount(env),
      runtime: latestRuntimeStatus(env),
    };
    expect(result).toEqual({
      pendingApprovals: 0,
      pendingQuestions: 0,
      replies: 0,
      rememberedRuleWrites: 0,
      continuation: true,
      completions: 1,
      completionTransitions: 1,
      runtime: { status: 'completed', activeTurn: undefined },
    });
  } finally {
    await disposeScenario(env);
  }
}

async function runCommandResolvedBeforeDisplay(): Promise<void> {
  const { env, storage } = await createCodexEnvironment('worktree');
  const promptWindow = createSendableWindow();
  try {
    await installSyntheticWindow(promptWindow.window);
    const approvalRequests = await import('../../approvals/pending-approvals');
    const rememberedRulesBefore = await readRememberedRuleSnapshot(env);
    const root = await startRoot(env, 'command resolved before display');
    const requestId = 4401;
    await sendAndResolveScriptedCodexServerRequest(env.driver, {
      method: 'item/commandExecution/requestApproval',
      callId: 'early-command-item',
      requestId,
      params: {
        kind: 'command',
        turnId: root.turnKey,
        itemId: 'early-command-item',
        command: 'echo early-resolution',
        cwd: '/tmp',
      },
    });
    await root.emitText('continued after early command resolution');
    await root.complete();
    await env.host.drain();
    const result = {
      pendingApprovals: approvalRequests.pendingApprovalRequests(
        promptWindow.window.webContents,
      ).length,
      pendingQuestions:
        (await readQuestionState(env)).tabsFile.pendingQuestions?.filter(
          (question) =>
            question.chatId === env.target.chatId &&
            question.answeredAt === undefined,
        ).length ?? 0,
      replies: responseCount(env, requestId),
      rememberedRuleWrites: await rememberedRuleChangesSince(
        env,
        rememberedRulesBefore,
      ),
      continuation: storage
        .readCommittedTranscript(env.target)
        .toString('utf8')
        .includes('continued after early command resolution'),
      completions: completionCount(env, root.turnKey),
      completionTransitions: completionTransitionCount(env),
      runtime: latestRuntimeStatus(env),
    };
    expect(result).toEqual({
      pendingApprovals: 0,
      pendingQuestions: 0,
      replies: 0,
      rememberedRuleWrites: 0,
      continuation: true,
      completions: 1,
      completionTransitions: 1,
      runtime: { status: 'completed', activeTurn: undefined },
    });
  } finally {
    await disposeScenario(env);
  }
}

export function registerCodexResolvedIncidentTests(): void {
  describe('Codex resolved server requests', () => {
    it.each(HOST_CASES)(
      '$host clears a resolved command approval without replying',
      async ({ host, commandRequestId }) =>
        runPendingCommandResolution(host, commandRequestId),
      SCENARIO_TEST_TIMEOUT_MS,
    );
    it.each(HOST_CASES)(
      '$host clears a resolved built-in user-input request without replying',
      async ({ host, questionRequestId }) =>
        runPendingQuestionResolution(host, questionRequestId),
      SCENARIO_TEST_TIMEOUT_MS,
    );
    it.each(HOST_CASES)(
      '$host keeps mismatched-thread and unknown resolutions answerable',
      async ({ host, commandRequestId, questionRequestId }) =>
        runStaleResolutionsRemainAnswerable(
          host,
          commandRequestId,
          questionRequestId,
        ),
      SCENARIO_TEST_TIMEOUT_MS,
    );
    it(
      'clears an immediately resolved command request from the same provider batch',
      async () => runCommandResolvedBeforeDisplay(),
      SCENARIO_TEST_TIMEOUT_MS,
    );
  });
}

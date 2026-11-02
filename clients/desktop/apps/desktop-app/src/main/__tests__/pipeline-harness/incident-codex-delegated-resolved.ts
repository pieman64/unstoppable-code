/** Real delegated Codex server-request resolution incident regressions. */
import { EventEmitter } from 'node:events';
import { IPC_CHANNELS, type ApprovalRule } from '@canopy/desktop-shared/types';
import type { AgentDelegationEvent } from '@canopy/protocol/delegation';
import type {
  AgentRunRequest,
  NativeRunHandle,
} from '@canopy/desktop-shared/node/delegation';
import type { LocalDelegationRunner } from '@canopy/desktop-shared/node/delegation/local-runner';
import type { SendableBrowserWindow } from '../../lib/window-send';
import type * as ApprovalPersistenceModule from '../../lib/approvals-persistence';
import type * as PreferencesStoreModule from '../../lib/preferences-store';
import type * as ObservabilityModule from '../../observability';
import type { SessionDiagnosticRecord } from '../../observability/service';
import type { ApprovalSessionHandle } from '../../approvals/approval-service';
import type { ProviderTraceEvent } from './contracts';
import {
  createScenarioEnvironment,
  disposeScenario,
  SCENARIO_TEST_TIMEOUT_MS,
  startRoot,
} from './scenarios';
import {
  resolveScriptedCodexServerRequest,
  sendScriptedCodexServerRequest,
} from './scripted-codex';

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
}

function captureApprovalDiagnostics(): SessionDiagnosticRecord[] {
  const diagnostics: SessionDiagnosticRecord[] = [];
  const observability = jest.requireMock<typeof ObservabilityModule>(
    '../../observability',
  );
  const service = new Proxy(observability.getObservabilityService(), {
    get(_target, property): unknown {
      if (property === 'then') return undefined;
      if (property === 'recordSessionDiagnostic')
        return (record: SessionDiagnosticRecord): void => {
          diagnostics.push(record);
        };
      return (): void => undefined;
    },
  });
  jest.spyOn(observability, 'getObservabilityService').mockReturnValue(service);
  return diagnostics;
}

async function waitFor(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  for (let elapsed = 0; elapsed < 2_000; elapsed += 25) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForResolutionCleanup(
  isSettled: () => boolean,
): Promise<void> {
  for (let elapsed = 0; elapsed < 2_000; elapsed += 25) {
    if (isSettled()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function bounded<T>(
  operation: Promise<T>,
  description: string,
  timeoutMs = 5_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`Timed out after ${timeoutMs}ms: ${description}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function providerFrames(
  env: CodexEnvironment,
  turnKey: string,
): ProviderTraceEvent[] {
  return env.harness.recorder.events.filter(
    (event): event is ProviderTraceEvent =>
      event.kind === 'provider' &&
      event.provider === 'codex' &&
      event.target.chatId === env.target.chatId &&
      event.turnKey === turnKey,
  );
}

function hasRequestId(value: unknown, requestId: string): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    'requestId' in value &&
    value.requestId === requestId
  );
}

function hasSubagentId(value: unknown, subagentId: string): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    'subagentId' in value &&
    value.subagentId === subagentId
  );
}

function approvalEvents(
  events: readonly AgentDelegationEvent['event'][],
): boolean[] {
  return events.flatMap((event) =>
    event.type === 'approval' ? [event.pending] : [],
  );
}

function responseCount(
  env: CodexEnvironment,
  turnKey: string,
  requestId: string | number,
): number {
  return providerFrames(env, turnKey).filter(
    (event) =>
      event.direction === 'to-provider' &&
      event.type.startsWith('client-response:') &&
      event.ids?.requestId === String(requestId),
  ).length;
}

interface RuleSnapshot {
  workspace: readonly ApprovalRule[];
  global: readonly ApprovalRule[];
  session: readonly ApprovalRule[];
  workspaceWrites: number;
  globalWrites: number;
}

async function readRuleSnapshot(
  env: CodexEnvironment,
  sessionRules: readonly ApprovalRule[],
): Promise<RuleSnapshot> {
  const approvals = jest.requireMock<typeof ApprovalPersistenceModule>(
    '../../lib/approvals-persistence',
  );
  const preferences = jest.requireMock<typeof PreferencesStoreModule>(
    '../../lib/preferences-store',
  );
  const workspaceWrites = jest.spyOn(approvals, 'addWorkspaceApprovalRule');
  const globalWrites = jest.spyOn(preferences, 'updatePreferencesFile');
  const chatState = await import('../../services/chat-state-service');
  const [workspace, global, state] = await Promise.all([
    approvals.readWorkspaceApprovals(env.target.projectId),
    preferences.readPreferencesFile(),
    chatState.getChatStateService().getState({
      projectId: env.target.projectId,
      worktreeId: env.target.worktreeId,
    }),
  ]);
  return {
    workspace: workspace.rules,
    global: global.globalApprovalRules,
    session: [
      ...(state.tabsFile.tabs.find((tab) => tab.id === env.target.chatId)
        ?.sessionApprovalRules ?? []),
      ...sessionRules,
    ],
    workspaceWrites: workspaceWrites.mock.calls.length,
    globalWrites: globalWrites.mock.calls.length,
  };
}

function ruleChanges(before: RuleSnapshot, after: RuleSnapshot): number {
  return (
    Number(
      JSON.stringify(before.workspace) !== JSON.stringify(after.workspace),
    ) +
    Number(JSON.stringify(before.global) !== JSON.stringify(after.global)) +
    Number(JSON.stringify(before.session) !== JSON.stringify(after.session)) +
    after.workspaceWrites -
    before.workspaceWrites +
    after.globalWrites -
    before.globalWrites
  );
}

function createRunRequest(
  env: CodexEnvironment,
  turnId: string,
  cwd: string,
  signal: AbortSignal,
): AgentRunRequest {
  return {
    delegationId: 'delegated-resolution-incident',
    runGeneration: 1,
    launchKey: 'delegated-resolution-launch',
    parent: {
      harnessId: 'codex',
      projectId: env.target.projectId,
      worktreeId: env.target.worktreeId,
      chatId: env.target.chatId,
      sessionKey: 'codex-parent-session',
      turnId,
      toolCallId: 'delegate-codex-call',
      runtimeGeneration: 1,
      depth: 0,
    },
    task: {
      modelId: 'gpt-test',
      description: 'Exercise delegated Codex approval resolution',
      prompt: 'Continue after the provider resolves an approval request.',
      executionMode: 'foreground',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
    },
    route: {
      selectedModelId: 'gpt-test',
      runtimeModelId: 'gpt-test',
      harnessId: 'codex',
      runtimeKind: 'codex-app-server',
      runnerRegistrationId: 'codex-local',
      runtimeVersion: '1',
      adapterVersion: '1',
      modelSource: 'test',
      providerType: 'codex',
      assignmentRevision: 'assignment-1',
      billingAuthority: 'native',
      aiCreditsRouted: false,
      capabilities: ['read'],
      supportedThinkingLevels: [],
      capabilitySnapshotHash: 'delegated-resolution-hash',
      capabilityGeneration: 1,
      policyRevision: 'read-only-1',
    },
    cwd,
    effectivePermission: 'read-only',
    signal,
  } satisfies AgentRunRequest;
}

async function runDelegatedResolvedApproval(): Promise<void> {
  let env: CodexEnvironment;
  try {
    env = await bounded(
      createScenarioEnvironment('worktree', 'codex'),
      'create Codex delegated-resolution scenario',
      60_000,
    );
  } catch (error) {
    jest.restoreAllMocks();
    throw error;
  }
  const promptWindow = createSendableWindow();
  const cwd = process.cwd();
  const requestId = 6501;
  const childItemId = 'delegated-resolved-command';
  const unrelatedToolUseId = 'unrelated-pending-tool';
  const requestController = new AbortController();
  const childSessionRules: ApprovalRule[] = [];
  const unrelatedSessionRules: ApprovalRule[] = [];
  let rootTurn: Awaited<ReturnType<typeof startRoot>> | undefined;
  let childTurn: Awaited<ReturnType<typeof startRoot>> | undefined;
  let runner: LocalDelegationRunner | undefined;
  let runHandle: NativeRunHandle | undefined;
  let childApproval: ApprovalSessionHandle | undefined;
  let unrelatedApproval: ApprovalSessionHandle | undefined;
  let unrelatedCheck: ReturnType<ApprovalSessionHandle['check']> | undefined;
  let runnerClosed = false;
  let scenarioFailed = false;
  const reportedErrors: unknown[] = [];
  const delegatedEvents: AgentDelegationEvent['event'][] = [];
  let resolveTerminal:
    | ((event: AgentDelegationEvent['event']) => void)
    | undefined;
  const terminal = new Promise<AgentDelegationEvent['event']>((resolve) => {
    resolveTerminal = resolve;
  });

  try {
    await installSyntheticWindow(promptWindow.window);
    const approvalRequests = await import('../../approvals/pending-approvals');
    const rememberedRulesBefore = await readRuleSnapshot(
      env,
      childSessionRules,
    );
    rootTurn = await startRoot(env, 'delegated Codex resolved approval');
    const diagnostics = captureApprovalDiagnostics();

    const [
      { createCodexDelegationRunner },
      { DelegationNativePolicy },
      { createApprovalSession },
    ] = await Promise.all([
      import('../../agents/delegation/codex-runner'),
      import('../../agents/delegation/native-policy'),
      import('../../approvals/approval-service'),
    ]);
    runner = createCodexDelegationRunner({
      available: () => Promise.resolve({ available: true }),
      prepare: (context) => {
        const approval = createApprovalSession({
          sessionKey: `${context.request.parent.sessionKey}:delegated:${context.request.delegationId}`,
          projectId: env.target.projectId,
          worktreeId: env.target.worktreeId,
          chatId: env.target.chatId,
          provider: 'codex',
          workspaceRoot: cwd,
          mode: 'ask',
          sessionRules: childSessionRules,
          getWindow: () => promptWindow.window,
        });
        childApproval = approval;
        context.retain((): Promise<void> => {
          approval.dispose();
          return Promise.resolve();
        });
        return Promise.resolve({
          model: 'gpt-test',
          profile: {
            environmentPolicy: 'restricted',
            includeCanopySecrets: false,
          },
          tools: new DelegationNativePolicy({
            cwd,
            writePaths: [],
            approval,
            mode: (): 'ask' => 'ask',
            allowed: (): Promise<boolean> => Promise.resolve(true),
            signal: context.signal,
            delegationId: context.request.delegationId,
            emit: (event: AgentDelegationEvent['event']): Promise<void> =>
              context.emit(event),
          }),
        });
      },
      reportError: (error) => reportedErrors.push(error),
    });

    const runRequest = createRunRequest(
      env,
      rootTurn.turnKey,
      cwd,
      requestController.signal,
    );
    runHandle = await runner.start(runRequest, (envelope) => {
      delegatedEvents.push(envelope.event);
      if (envelope.event.type === 'terminal') resolveTerminal?.(envelope.event);
      return Promise.resolve();
    });
    childTurn = await env.driver.nextTurn({ timeoutMs: 10_000 });

    await sendScriptedCodexServerRequest(env.driver, {
      method: 'item/commandExecution/requestApproval',
      callId: childItemId,
      requestId,
      params: {
        kind: 'command',
        turnId: childTurn.turnKey,
        itemId: childItemId,
        command: 'echo resolved-by-provider',
        cwd,
      },
    });
    await waitFor(
      () =>
        approvalRequests
          .pendingApprovalRequests(promptWindow.window.webContents)
          .some((approval) => approval.toolUseId === childItemId),
      'the delegated provider approval card to pend',
    );

    const unrelatedTarget = {
      ...env.target,
      chatId: 'unrelated-approval-session',
    };
    unrelatedApproval = createApprovalSession({
      sessionKey: 'unrelated-prompt-session',
      projectId: unrelatedTarget.projectId,
      worktreeId: unrelatedTarget.worktreeId,
      chatId: unrelatedTarget.chatId,
      provider: 'codex',
      workspaceRoot: cwd,
      mode: 'ask',
      sessionRules: unrelatedSessionRules,
      getWindow: () => promptWindow.window,
      trackChatTurn: false,
    });
    unrelatedCheck = unrelatedApproval.check(
      { kind: 'tool', toolName: 'Unrelated tool' },
      {
        title: 'Unrelated pending approval',
        details: {
          kind: 'tool',
          toolName: 'Unrelated tool',
          inputSummary: 'separate request to verify prompt isolation',
        },
        toolUseId: unrelatedToolUseId,
      },
    );
    void unrelatedCheck.catch(() => undefined);
    await waitFor(
      () =>
        approvalRequests
          .pendingApprovalRequests(promptWindow.window.webContents)
          .some((approval) => approval.toolUseId === unrelatedToolUseId),
      'the unrelated approval card to pend',
    );

    const pendingBeforeResolution = approvalRequests.pendingApprovalRequests(
      promptWindow.window.webContents,
    );
    const childApprovalEvent = pendingBeforeResolution.find(
      (approval) => approval.toolUseId === childItemId,
    );
    if (!childApprovalEvent)
      throw new Error('Expected the delegated provider approval request');
    const rendererChildApproval = promptWindow.sends.some(
      (send) =>
        send.channel === IPC_CHANNELS.approvalRequest &&
        hasRequestId(send.payload, childApprovalEvent.requestId) &&
        hasSubagentId(send.payload, runRequest.delegationId),
    );
    expect({
      rendererApprovalRequests: promptWindow.sends.filter(
        (send) => send.channel === IPC_CHANNELS.approvalRequest,
      ).length,
      childStarted: delegatedEvents.some(
        (event) =>
          event.type === 'started' && (event.nativeSessionId ?? '').length > 0,
      ),
      childApprovalTransition: approvalEvents(delegatedEvents),
      pendingToolUseIds: pendingBeforeResolution
        .map((approval) => approval.toolUseId)
        .sort(),
      rendererChildApproval,
      pendingChildSubagentId: childApprovalEvent.subagentId,
    }).toEqual({
      rendererApprovalRequests: 2,
      childStarted: true,
      childApprovalTransition: [true],
      pendingToolUseIds: [childItemId, unrelatedToolUseId].sort(),
      rendererChildApproval: true,
      pendingChildSubagentId: runRequest.delegationId,
    });

    await resolveScriptedCodexServerRequest(env.driver, requestId);
    const childTurnKey = childTurn.turnKey;
    await waitFor(
      () =>
        providerFrames(env, childTurnKey).some(
          (event) =>
            event.direction === 'to-canopy' &&
            event.type === 'notification:serverRequest/resolved' &&
            event.ids?.requestId === String(requestId),
        ),
      'the provider resolution frame to reach the real Codex runtime',
    );

    const resolutionFrames = providerFrames(env, childTurn.turnKey).filter(
      (event) =>
        event.direction === 'to-canopy' &&
        event.type === 'notification:serverRequest/resolved' &&
        event.ids?.requestId === String(requestId),
    );
    expect(resolutionFrames).toHaveLength(1);

    await waitForResolutionCleanup(() => {
      const stillPending = approvalRequests
        .pendingApprovalRequests(promptWindow.window.webContents)
        .some(
          (approval) => approval.requestId === childApprovalEvent.requestId,
        );
      const cancellationSent = promptWindow.sends.some(
        (send) =>
          send.channel === IPC_CHANNELS.approvalCancelled &&
          hasRequestId(send.payload, childApprovalEvent.requestId),
      );
      return (
        !stillPending &&
        cancellationSent &&
        approvalEvents(delegatedEvents).includes(false)
      );
    });

    const pending = approvalRequests.pendingApprovalRequests(
      promptWindow.window.webContents,
    );
    const resolutionState = {
      pendingToolUseIds: pending
        .filter((approval) => approval.toolUseId)
        .map((approval) => approval.toolUseId)
        .sort(),
      cancelledRequestIds: promptWindow.sends
        .filter((send) => send.channel === IPC_CHANNELS.approvalCancelled)
        .map((send) => send.payload)
        .filter((payload) =>
          hasRequestId(payload, childApprovalEvent.requestId),
        ).length,
      approvalTransitions: approvalEvents(delegatedEvents),
      providerReplies: responseCount(env, childTurn.turnKey, requestId),
      approvalDecisions: diagnostics.filter(
        (record) => record.kind === 'approval_decision',
      ).length,
      rememberedRuleChanges: ruleChanges(
        rememberedRulesBefore,
        await readRuleSnapshot(env, childSessionRules),
      ),
    };
    expect(resolutionState).toEqual({
      pendingToolUseIds: [unrelatedToolUseId],
      cancelledRequestIds: 1,
      approvalTransitions: [true, false],
      providerReplies: 0,
      approvalDecisions: 0,
      rememberedRuleChanges: 0,
    });

    const unrelatedRequest = pending.find(
      (approval) => approval.toolUseId === unrelatedToolUseId,
    );
    if (!unrelatedRequest)
      throw new Error(
        'Expected the unrelated approval request to remain pending',
      );
    expect(
      approvalRequests.resolveApproval(
        unrelatedRequest.requestId,
        { behavior: 'allow', scope: 'once' },
        promptWindow.window.webContents,
        unrelatedTarget,
      ),
    ).toBe(true);
    expect(await unrelatedCheck).toMatchObject({ decision: 'allow' });
    expect(
      diagnostics.filter((record) => record.kind === 'approval_decision'),
    ).toHaveLength(1);

    await childTurn.emitText('continued after provider resolution');
    await childTurn.complete();
    expect(await terminal).toMatchObject({
      type: 'terminal',
      status: 'completed',
      finalText: 'continued after provider resolution',
    });
    expect(reportedErrors).toEqual([]);
    await runner.close(runHandle);
    runnerClosed = true;
    await rootTurn.complete();
    await env.host.drain();

    expect({
      pendingApprovals: approvalRequests.pendingApprovalRequests(
        promptWindow.window.webContents,
      ).length,
      providerReplies: responseCount(env, childTurn.turnKey, requestId),
      approvalTransitions: approvalEvents(delegatedEvents),
      rememberedRuleChanges: ruleChanges(
        rememberedRulesBefore,
        await readRuleSnapshot(env, childSessionRules),
      ),
    }).toEqual({
      pendingApprovals: 0,
      providerReplies: 0,
      approvalTransitions: [true, false],
      rememberedRuleChanges: 0,
    });
  } catch (error) {
    scenarioFailed = true;
    throw error;
  } finally {
    childApproval?.dispose();
    unrelatedApproval?.dispose();
    if (runner && runHandle && !runnerClosed) {
      await bounded(
        runner.stop(runHandle, 'user_cancelled'),
        'delegated runner teardown',
      ).catch(() => undefined);
    }
    try {
      await bounded(disposeScenario(env), 'pipeline harness teardown').catch(
        (error: unknown) => {
          if (!scenarioFailed) throw error;
        },
      );
    } finally {
      jest.restoreAllMocks();
    }
  }
}

export function registerCodexDelegatedResolvedIncidentTests(): void {
  describe('Codex delegated resolved server requests', () => {
    it(
      'cancels only the resolved approval and continues the delegated run',
      async () => runDelegatedResolvedApproval(),
      SCENARIO_TEST_TIMEOUT_MS * 2,
    );
  });
}

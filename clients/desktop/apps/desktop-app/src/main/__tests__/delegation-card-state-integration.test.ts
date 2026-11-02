import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardStateDraft } from '@canopy/protocol/canopy-core';
import type { DelegationTranscriptPortResult } from '@canopy/desktop-shared/node/delegation/transcript-port';
import type { integrationBacking } from './helpers/delegation-card-integration-backing';

jest.mock('../services/background-execution-context', () => ({
  ...jest.requireActual<object>('../services/background-execution-context'),
  backgroundExecutionContextEnabled: (): boolean => false,
}));
// Cold imports of the real repository, broker and host exceed 5 s under CI load.
jest.setTimeout(60_000);

let mockRoot = '';
jest.mock('../lib/paths', () => ({
  ...jest.requireActual<object>('../lib/paths'),
  getWorktreeDataDir: (projectId: string, worktreeId: string): string =>
    join(mockRoot, projectId, worktreeId),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<null> => Promise.resolve(null),
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
}));

function value<T>(result: DelegationTranscriptPortResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

// Input and oracle are independent literals copied from the S2b reader matrix.
const draft: CardStateDraft = {
  version: 2,
  status: 'running',
  outputTruncated: true,
  prompt: 'Amended prompt',
  requestedModelId: 'durable-model',
  routeSnapshot: {
    selectedModelId: 'selected',
    runtimeModelId: 'runtime',
    harnessId: 'codex',
    runtimeKind: 'sdk',
    runnerRegistrationId: 'runner',
    runtimeVersion: '1',
    adapterVersion: '1',
    modelSource: 'agent',
    providerType: 'openai',
    assignmentRevision: '1',
    billingAuthority: 'local',
    aiCreditsRouted: false,
    capabilities: [],
    supportedThinkingLevels: [],
    capabilitySnapshotHash: 'hash',
    capabilityGeneration: 1,
    policyRevision: '1',
    requestedThinkingLevel: 'high',
    effectiveThinkingLevel: 'medium',
  },
  nativeSessionId: 'durable-session',
  childDelegationIds: ['durable-child'],
  nestedDelegation: 'not_enabled',
  isolatedWorkspace: {
    revision: 'durable-workspace',
    dirtyParentChangesIncluded: false,
  },
};
const running = {
  status: 'running',
  outputTruncated: true,
  requestedModelId: 'durable-model',
  routeSnapshot: {
    selectedModelId: 'selected',
    runtimeModelId: 'runtime',
    harnessId: 'codex',
    runtimeKind: 'sdk',
    runnerRegistrationId: 'runner',
    runtimeVersion: '1',
    adapterVersion: '1',
    modelSource: 'agent',
    providerType: 'openai',
    assignmentRevision: '1',
    billingAuthority: 'local',
    aiCreditsRouted: false,
    capabilities: [],
    supportedThinkingLevels: [],
    capabilitySnapshotHash: 'hash',
    capabilityGeneration: 1,
    policyRevision: '1',
    requestedThinkingLevel: 'high',
    effectiveThinkingLevel: 'medium',
  },
  nativeSessionId: 'durable-session',
  childDelegationIds: ['durable-child'],
  nestedDelegation: 'not_enabled',
  isolatedWorkspace: {
    revision: 'durable-workspace',
    dirtyParentChangesIncluded: false,
  },
};
const terminal = {
  ...running,
  status: 'completed',
  resultIndex: 1,
  finalText: 'Durable final text',
  error: {
    code: 'runtime_error',
    message: 'Durable error text',
    retryable: false,
  },
  usage: { inputTokens: 7, outputTokens: 9 },
};

describe('E8 production-default card readers and Portal seed', () => {
  let previousDataDir: string | undefined;
  let backing: Awaited<ReturnType<typeof integrationBacking>> | undefined;
  beforeAll(() => jest.resetModules());
  beforeEach(async () => {
    mockRoot = await mkdtemp(join(tmpdir(), 'card-integration-'));
    previousDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = join(mockRoot, 'data');
    const paths = await import('@canopy/desktop-shared/canopy-paths');
    paths.resetResolvedCanopyDataDirForTests();
    jest.spyOn(Date, 'now').mockReturnValue(100_000);
  });
  afterEach(async () => {
    await backing?.harness.broker.close();
    await backing?.service.drain();
    const singleton = await import('../services/chat-state-service');
    await singleton.getChatStateService().drain();
    singleton.resetChatStateServiceForTests();
    backing = undefined;
    const { getAppAdvisorWatcherService } =
      await import('../app-advisor/watchers');
    getAppAdvisorWatcherService().shutdown();
    await getAppAdvisorWatcherService().drain();
    jest.restoreAllMocks();
    if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previousDataDir;
    await rm(mockRoot, { recursive: true, force: true });
  });

  it.each(
    ['running', 'settled', 'applied', 'discarded', 'null'].flatMap((state) =>
      ['tree', 'header', 'advisor', 'portal'].map((reader) => ({
        state,
        reader,
      })),
    ),
  )(
    '$state: $reader shows the independent durable oracle',
    async ({ state, reader }) => {
      // 12b: the broker is the stream card writer. This reader matrix supplies
      // its own descriptor states, so broker publication is stubbed out here.
      const { CardPublicationQueue } =
        await import('@canopy/desktop-shared/node/delegation/card-publication-queue');
      jest
        .spyOn(CardPublicationQueue.prototype, 'enqueue')
        .mockImplementation(() => undefined);
      const helper =
        await import('./helpers/delegation-card-integration-backing');
      backing = await helper.integrationBacking(mockRoot);
      const { port, scope, service: chatState } = backing;
      const singleton = await import('../services/chat-state-service');
      singleton.resetChatStateServiceForTests(chatState);
      const { chatId, delegationId, target } =
        await import('./helpers/delegation-two-scope-backing');
      const selected = target(1);
      if (state !== 'null')
        value(
          await port.updateCardState({
            target: selected,
            cardRevision: 1,
            cardDraft: draft,
          }),
        );
      if (state !== 'running' && state !== 'null') {
        await backing.harness.runner.sink?.({
          delegationId,
          runGeneration: 1,
          sequence: 2,
          occurredAt: 200,
          event: {
            type: 'terminal',
            status: 'completed',
            finalText: 'Durable final text',
            error: {
              code: 'runtime_error',
              message: 'Durable error text',
              retryable: false,
            },
            usage: { inputTokens: 7, outputTokens: 9 },
          },
        });
        const settled = value(
          await port.generation({ chatId, delegationId, runGeneration: 1 }),
        );
        expect(settled.result).toMatchObject({
          resultIndex: 1,
          answer: { kind: 'body', role: 'final', byteLength: 18 },
        });
      }
      const applied: CardStateDraft = {
        ...draft,
        isolatedWorkspace: {
          revision: 'applied',
          dirtyParentChangesIncluded: false,
        },
        control: {
          operationId: 'apply',
          operation: 'apply',
          status: 'completed',
        },
      };
      if (state === 'applied' || state === 'discarded')
        value(
          await port.updateCardState({
            target: selected,
            cardRevision: 2,
            cardDraft: applied,
          }),
        );
      if (state === 'discarded')
        value(
          await port.updateCardState({
            target: selected,
            cardRevision: 3,
            cardDraft: {
              ...applied,
              workspaceDiscarded: true,
              control: {
                operationId: 'discard',
                operation: 'discard',
                status: 'completed',
              },
            },
          }),
        );
      const expected =
        state === 'null'
          ? {
              status: 'running',
              outputTruncated: false,
            }
          : state === 'running'
            ? running
            : {
                ...terminal,
                ...(state === 'applied' || state === 'discarded'
                  ? {
                      isolatedWorkspace: {
                        revision: 'applied',
                        dirtyParentChangesIncluded: false,
                      },
                      control: {
                        operationId: state === 'applied' ? 'apply' : 'discard',
                        operation: state === 'applied' ? 'apply' : 'discard',
                        status: 'completed',
                      },
                    }
                  : {}),
                ...(state === 'discarded' ? { workspaceDiscarded: true } : {}),
              };
      const prompt = state === 'null' ? 'Creation prompt' : 'Amended prompt';
      const sessions = await import('../agents/session-manager');
      const actor = jest
        .spyOn(sessions, 'getOrCreateSession')
        .mockImplementation(() => {
          throw new Error('Read created actor');
        });
      const { AgentDelegationBroker } =
        await import('@canopy/desktop-shared/node/delegation/broker');
      const broker = jest
        .spyOn(AgentDelegationBroker.prototype, 'initialize')
        .mockImplementation(() => {
          throw new Error('Read created broker');
        });
      const service = await import('../agents/delegation/service');
      const advisor = await import('../app-advisor/delegation-read-actions');
      const roots = await service.readManagedDelegationRootsForUser(scope);
      // Cold roots are summary-only and never claim live execution without an actor.
      expect(roots).toEqual([
        { chatId, total: 1, live: 0, lastActivityAt: 100_000 },
      ]);
      if (reader === 'tree') {
        const tree = await service.readManagedDelegationTreeForUser({
          ...scope,
          chatId,
        });
        expect(tree).toHaveLength(1);
        expect(tree[0]).toMatchObject({
          prompt,
          description: 'Creation description',
          snapshot: expected,
        });
      }
      if (reader === 'header') {
        const header = await service.readManagedDelegationTranscriptForUser({
          ...scope,
          chatId,
          delegationId,
          runGeneration: 1,
          limit: 1,
        });
        expect(header).toMatchObject({
          ok: true,
          task: { prompt, description: 'Creation description' },
          snapshot: expected,
        });
      }
      if (reader === 'advisor') {
        const action = await advisor.dispatchDelegationReadAction({
          type: 'delegation.tree',
          ...scope,
          chatId,
        });
        expect(action.ok).toBe(true);
        if (!action.ok) throw new Error('Advisor read failed');
        expect(action.result).toMatchObject([{ snapshot: expected }]);
      }
      if (reader === 'portal') {
        const { getWorktreeChatTranscriptSeed } =
          await import('../services/chat-service');
        const seed = await getWorktreeChatTranscriptSeed({
          workspaceId: scope.projectId,
          worktreeId: scope.worktreeId,
          chatId,
        });
        const card = seed.messages
          .flatMap((message) => message.parts)
          .find((part) => part !== undefined && part.kind === 'agent');
        expect(card).toMatchObject({
          kind: 'agent',
          data: { delegation: { ...expected, prompt } },
        });
      }
      expect(actor).not.toHaveBeenCalled();
      expect(broker).not.toHaveBeenCalled();
      const descriptor = await backing.repository.getChildStreamState(
        scope,
        selected,
      );
      if (state === 'null') expect(descriptor?.cardState).toBeNull();
      else if (state !== 'running') {
        expect(descriptor?.cardState).toMatchObject({
          version: 2,
          canonical: {
            status: 'completed',
            resultIndex: 1,
            finalText: 'Durable final text',
            error: {
              code: 'runtime_error',
              message: 'Durable error text',
              retryable: false,
            },
            usage: { inputTokens: 7, outputTokens: 9 },
          },
        });
        const stored = descriptor?.cardState;
        expect(
          stored?.version === 2 ? stored.canonical?.finalTextRef : undefined,
        ).toBeDefined();
      }
    },
  );

  it('legacy chat-log-v1 keeps its stored card byte-identical without descriptor lookup', async () => {
    const helper =
      await import('./helpers/delegation-card-integration-backing');
    backing = await helper.integrationBacking(mockRoot, true);
    const { scope, service: chatState, repository, row } = backing;
    const singleton = await import('../services/chat-state-service');
    singleton.resetChatStateServiceForTests(chatState);
    const { chatId, delegationId } =
      await import('./helpers/delegation-two-scope-backing');
    const { ChatStateV2Backend } =
      await import('../services/chat-state-v2-backend');
    const descriptor = jest.spyOn(
      ChatStateV2Backend.prototype,
      'childStreamDescriptor',
    );
    const generation = jest.spyOn(repository, 'generation');
    const service = await import('../agents/delegation/service');
    const advisor = await import('../app-advisor/delegation-read-actions');
    const roots = await service.readManagedDelegationRootsForUser(scope);
    expect(roots).toEqual([
      { chatId, total: 1, live: 0, lastActivityAt: 100_000 },
    ]);
    const tree = await service.readManagedDelegationTreeForUser({
      ...scope,
      chatId,
    });
    const header = await service.readManagedDelegationTranscriptForUser({
      ...scope,
      chatId,
      delegationId,
    });
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      description: 'Stale record description',
      prompt: 'Stale record prompt',
      snapshot: { status: 'running', nativeSessionId: 'retained-native' },
    });
    expect(header).toMatchObject({
      ok: true,
      task: {
        description: 'Stale record description',
        prompt: 'Stale record prompt',
      },
      snapshot: { status: 'running', nativeSessionId: 'retained-native' },
    });
    expect(
      await advisor.dispatchDelegationReadAction({
        type: 'delegation.tree',
        ...scope,
        chatId,
      }),
    ).toEqual({ ok: true, result: tree });
    const tabs = await chatState.getCompatibilityTabs(scope, {
      chatIds: [chatId],
      pageOnly: true,
    });
    expect(
      JSON.stringify(
        tabs.tabs
          .find((tab) => tab.id === chatId)
          ?.messages.find((message) => message.id === row.id),
      ),
    ).toBe(JSON.stringify(row));
    const { getWorktreeChatTranscriptSeed } =
      await import('../services/chat-service');
    const seed = await getWorktreeChatTranscriptSeed({
      workspaceId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId,
    });
    expect(
      seed.messages.find((message) => message.messageId === 'creation-card'),
    ).toEqual({
      chatId: 'colliding-chat',
      createdAtMs: 100,
      messageId: 'creation-card',
      role: 'assistant',
      status: 'complete',
      text: '',
      parts: [
        {
          kind: 'agent',
          data: {
            subBlocks: [],
            delegation: {
              type: 'delegated_agent_call',
              agentBlockId:
                'delegated-agent-11111111-1111-4111-8111-111111111111',
              delegationId: '11111111-1111-4111-8111-111111111111',
              runGeneration: 1,
              sequence: 1,
              parentHarnessId: 'claude',
              parentTurnId: 'turn-1',
              parentToolCallId: 'call-1',
              createdAt: 100,
              selectedModelId: 'model',
              runtimeModelId: 'model',
              targetHarnessId: 'third-harness',
              routeSnapshot: {
                selectedModelId: 'model',
                runtimeModelId: 'model',
                harnessId: 'third-harness',
                runtimeKind: 'sdk',
                runnerRegistrationId: 'runner',
                runtimeVersion: '1',
                adapterVersion: '1',
                modelSource: 'agent',
                providerType: 'openai',
                assignmentRevision: '1',
                billingAuthority: 'local',
                aiCreditsRouted: false,
                capabilities: [],
                supportedThinkingLevels: [],
                capabilitySnapshotHash: 'hash',
                capabilityGeneration: 1,
                policyRevision: '1',
              },
              description: 'Creation description',
              prompt: 'Creation prompt',
              executionMode: 'background',
              status: 'running',
              outputTruncated: false,
              // The Portal projection carries the store marker (16a).
              transcriptStore: 'chat-log-v1',
            },
          },
        },
      ],
    });
    expect(descriptor).not.toHaveBeenCalled();
    expect(generation).not.toHaveBeenCalled();
  });
});

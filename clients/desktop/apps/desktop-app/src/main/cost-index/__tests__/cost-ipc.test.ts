jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
  ipcMain: {
    handle: jest.fn(),
    on: jest.fn(),
    removeHandler: jest.fn(),
    removeListener: jest.fn(),
  },
}));

import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  type FileTreeDirectoryResponse,
  type FileTreeRootsResponse,
} from '@canopy/desktop-shared/types';
import { CostIndexRefreshParamsSchema } from '@canopy/protocol/canopy-core';
import {
  createEmptyCostTotals,
  costScopeKey,
  type CostChatView,
  type CostRefreshReceipt,
  type CostScopeRef,
  type CostScopeView,
  type CostUpdatedEvent,
  type PipelineRunCostView,
} from '@canopy/protocol/cost-view';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import {
  createCostScopeWatchManager,
  getCostChatForView,
  getCostPipelineRunForView,
  getCostScopeForView,
  refreshCostForView,
  type CostScopeWatchEvents,
  type CostScopeWatchTarget,
} from '../../ipc/cost';
import type { CostService } from '../service';

const SCOPE: CostScopeRef = {
  kind: 'entry',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};
const OTHER_SCOPE: CostScopeRef = {
  kind: 'retained',
  projectId: 'project-1',
  containerId: 'container-1',
};

const scopeView: CostScopeView = {
  scope: SCOPE,
  updatedAt: null,
  building: false,
  retentionDays: 7,
  totals: createEmptyCostTotals(),
  chats: [],
  pipelineRuns: [],
  hasCodexEstimate: false,
};
const chatView: CostChatView = {
  kind: 'summary',
  chat: {
    chatId: 'chat-1',
    label: 'Chat',
    state: 'open',
    totals: createEmptyCostTotals(),
    turnCount: 0,
    lastActivityAt: '2026-10-01T12:00:00Z',
    running: false,
    models: [],
  },
};
const pipelineRunView: PipelineRunCostView = {
  run: {
    executionId: 'run-1',
    pipelineName: 'Pipeline',
    startedAt: '2026-10-01T12:00:00Z',
    status: 'succeeded',
    totals: createEmptyCostTotals(),
    agentStepCount: 0,
  },
  updatedAt: null,
  steps: [],
  subagents: [],
  delegations: [],
  childRuns: [],
  byModel: [],
};
const refreshReceipt: CostRefreshReceipt = {
  ran: true,
  updatedAt: '2026-10-01T12:00:00Z',
  revision: 2,
};

const filesystemServices = {
  listFileTreeRoots: (): Promise<FileTreeRootsResponse> =>
    Promise.resolve({ roots: [] }),
  listFileTreeDirectory: (): Promise<FileTreeDirectoryResponse> =>
    Promise.resolve({ entries: [] }),
};

const caller: CanopyCallerDescriptor = {
  principalId: 'principal-1',
  clientInstanceId: 'client-1',
  authorityId: 'authority-1',
  interfaceKind: 'test',
  grants: ['worker.filesystem.read', 'core.chat.read'],
};

describe('cost IPC', () => {
  let service: CostService;
  let dispatcher: ReturnType<typeof createDesktopRuntime>;

  beforeEach(() => {
    service = {
      getScope: jest.fn(() => Promise.resolve(scopeView)),
      getChat: jest.fn(() => Promise.resolve(chatView)),
      getPipelineRun: jest.fn(() => Promise.resolve(pipelineRunView)),
      refresh: jest.fn(() => Promise.resolve(refreshReceipt)),
    };
    dispatcher = createDesktopRuntime({
      services: filesystemServices,
      costService: service,
    });
  });

  afterEach(async () => {
    await dispatcher.shutdown();
  });

  it('validates scope requests and maps bare DTOs to CostViewResult', async () => {
    const querySpy = jest.spyOn(dispatcher, 'query');
    await expect(
      getCostScopeForView(dispatcher, caller, {
        scope: { kind: 'entry', projectId: '', worktreeId: 'worktree-1' },
      }),
    ).resolves.toMatchObject({ status: 'error', reason: 'INVALID_INPUT' });
    await expect(
      getCostScopeForView(dispatcher, caller, {
        scope: { ...SCOPE, hostPath: '/outside-the-DTO' },
      }),
    ).resolves.toMatchObject({ status: 'error', reason: 'INVALID_INPUT' });
    expect(querySpy).not.toHaveBeenCalled();

    await expect(
      getCostScopeForView(dispatcher, caller, { scope: SCOPE }),
    ).resolves.toEqual({ status: 'ok', value: scopeView });
    expect(querySpy).toHaveBeenCalledWith(
      'core.cost.scope.get',
      { scope: SCOPE },
      {
        caller: {
          principalId: caller.principalId,
          clientInstanceId: caller.clientInstanceId,
          authorityId: caller.authorityId,
          interfaceKind: caller.interfaceKind,
          grants: ['core.cost.read'],
        },
      },
    );
  });

  it('validates chat and pipeline identifiers before dispatch', async () => {
    const querySpy = jest.spyOn(dispatcher, 'query');
    await expect(
      getCostChatForView(dispatcher, caller, {
        scope: SCOPE,
        chatId: '../chat',
      }),
    ).resolves.toMatchObject({ status: 'error', reason: 'INVALID_INPUT' });
    await expect(
      getCostPipelineRunForView(dispatcher, caller, {
        scope: SCOPE,
        executionId: '',
      }),
    ).resolves.toMatchObject({ status: 'error', reason: 'INVALID_INPUT' });
    expect(querySpy).not.toHaveBeenCalled();

    await expect(
      getCostChatForView(dispatcher, caller, {
        scope: SCOPE,
        chatId: 'chat-1',
        detail: 'summary',
      }),
    ).resolves.toEqual({ status: 'ok', value: chatView });
    await expect(
      getCostPipelineRunForView(dispatcher, caller, {
        scope: SCOPE,
        executionId: 'run-1',
      }),
    ).resolves.toEqual({ status: 'ok', value: pipelineRunView });
    expect(querySpy).toHaveBeenCalledTimes(2);
    expect(querySpy.mock.calls[0]?.[2].caller.grants).toEqual([
      'core.cost.read',
    ]);
    expect(querySpy.mock.calls[1]?.[2].caller.grants).toEqual([
      'core.cost.read',
    ]);
  });

  it('accepts provider subagent ids and rejects unsafe ones', async () => {
    const querySpy = jest.spyOn(dispatcher, 'query');
    // Claude subagents keep their native tool-use id.
    const claudeSubagentId = 'toolu_01AbCdEfGhIjKlMnOpQrStUv';
    await expect(
      getCostChatForView(dispatcher, caller, {
        scope: SCOPE,
        chatId: 'chat-1',
        subagentId: claudeSubagentId,
      }),
    ).resolves.toEqual({ status: 'ok', value: chatView });
    expect(querySpy).toHaveBeenCalledWith(
      'core.cost.chat.get',
      { scope: SCOPE, chatId: 'chat-1', subagentId: claudeSubagentId },
      expect.anything(),
    );

    for (const subagentId of [
      '../agent',
      'a\\b',
      'agent\u0000',
      ' padded',
      `a${'b'.repeat(240)}`,
    ]) {
      await expect(
        getCostChatForView(dispatcher, caller, {
          scope: SCOPE,
          chatId: 'chat-1',
          subagentId,
        }),
      ).resolves.toMatchObject({ status: 'error', reason: 'INVALID_INPUT' });
    }
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it('keys refresh through both instruction params and dispatcher metadata', async () => {
    const instructionSpy = jest.spyOn(dispatcher, 'instruction');
    await expect(
      refreshCostForView(dispatcher, caller, {
        scope: SCOPE,
        trigger: 'manual',
      }),
    ).resolves.toEqual({ status: 'ok', value: refreshReceipt });
    expect(instructionSpy).toHaveBeenCalledTimes(1);
    const [name, params, options] = instructionSpy.mock.calls[0] ?? [];
    expect(name).toBe('core.cost.index.refresh');
    const keyedParams = CostIndexRefreshParamsSchema.safeParse(params);
    expect(keyedParams.success).toBe(true);
    if (!keyedParams.success) throw new Error('Expected keyed cost refresh');
    expect(keyedParams.data).toMatchObject({
      scope: SCOPE,
      trigger: 'manual',
    });
    expect(options.caller.grants).toEqual(['core.cost.read']);
    expect(options.metadata).toEqual(keyedParams.data._meta);

    await expect(
      refreshCostForView(dispatcher, caller, {
        scope: SCOPE,
        trigger: 'not-a-trigger',
      }),
    ).resolves.toMatchObject({ status: 'error', reason: 'INVALID_INPUT' });
    expect(instructionSpy).toHaveBeenCalledTimes(1);
  });
});

describe('cost scope watch manager', () => {
  let updateListener: ((event: CostUpdatedEvent) => void) | undefined;
  let destroyedListener: (() => void) | undefined;
  let removedDestroyedListener: (() => void) | undefined;
  let watched: Set<string>;
  let watchCalls: Array<{ windowId: number; scope: CostScopeRef }>;
  let unwatchCalls: Array<{ windowId: number; scope: CostScopeRef }>;
  let dropCalls: number[];
  let targetDestroyed: boolean;
  let events: CostScopeWatchEvents;
  let target: CostScopeWatchTarget & { send: jest.Mock };
  let otherWindow: CostScopeWatchTarget & { send: jest.Mock };

  beforeEach(() => {
    updateListener = undefined;
    destroyedListener = undefined;
    removedDestroyedListener = undefined;
    watched = new Set();
    watchCalls = [];
    unwatchCalls = [];
    dropCalls = [];
    targetDestroyed = false;
    events = {
      watchCostScope: (windowId, scope): void => {
        watchCalls.push({ windowId, scope });
        watched.add(costScopeKey(scope));
      },
      unwatchCostScope: (windowId, scope): void => {
        unwatchCalls.push({ windowId, scope });
        watched.delete(costScopeKey(scope));
      },
      dropCostScopeWatches: (windowId): void => {
        dropCalls.push(windowId);
        watched.clear();
      },
      isCostScopeWatched: jest.fn((scope) => watched.has(costScopeKey(scope))),
      onCostUpdated: (listener): (() => void) => {
        updateListener = listener;
        return (): void => {
          updateListener = undefined;
        };
      },
    };
    target = {
      id: 7,
      isDestroyed: (): boolean => targetDestroyed,
      once: jest.fn((_event, listener) => {
        destroyedListener = listener;
      }),
      removeListener: (_event, listener): void => {
        removedDestroyedListener = listener;
      },
      send: jest.fn(),
    };
    otherWindow = {
      id: 8,
      isDestroyed: jest.fn(() => false),
      once: jest.fn(),
      removeListener: (): void => {},
      send: jest.fn(),
    };
  });

  it('tracks scopes by WebContents but broadcasts each update to every window', () => {
    const manager = createCostScopeWatchManager(events, () => [
      target,
      otherWindow,
    ]);
    manager.watch(target, SCOPE);
    manager.watch(target, SCOPE);
    expect(watchCalls).toEqual([{ windowId: 7, scope: SCOPE }]);

    updateListener?.({ scopes: [SCOPE, OTHER_SCOPE], revision: 4 });
    expect(target.send).toHaveBeenCalledTimes(1);
    expect(target.send).toHaveBeenCalledWith(IPC_CHANNELS.costUpdated, {
      scopes: [SCOPE, OTHER_SCOPE],
      revision: 4,
    });
    expect(otherWindow.send).toHaveBeenCalledWith(IPC_CHANNELS.costUpdated, {
      scopes: [SCOPE, OTHER_SCOPE],
      revision: 4,
    });

    manager.unwatch(target, SCOPE);
    expect(unwatchCalls).toEqual([]);
    updateListener?.({ scopes: [SCOPE], revision: 5 });
    expect(target.send).toHaveBeenCalledTimes(2);
    expect(otherWindow.send).toHaveBeenCalledTimes(2);
    manager.unwatch(target, SCOPE);
    expect(unwatchCalls).toEqual([{ windowId: 7, scope: SCOPE }]);
    expect(dropCalls).toEqual([7]);
    updateListener?.({ scopes: [SCOPE], revision: 6 });
    expect(target.send).toHaveBeenCalledTimes(3);
    expect(otherWindow.send).toHaveBeenCalledTimes(3);
    manager.dispose();
  });

  it('drops every watch when the owning WebContents is destroyed', () => {
    const manager = createCostScopeWatchManager(events);
    manager.watch(target, SCOPE);
    manager.watch(target, OTHER_SCOPE);
    expect(watched.size).toBe(2);

    destroyedListener?.();
    expect(dropCalls).toEqual([7]);
    expect(watched.size).toBe(0);
    expect(removedDestroyedListener).toBe(destroyedListener);
    targetDestroyed = true;
    updateListener?.({ scopes: [SCOPE, OTHER_SCOPE], revision: 6 });
    expect(target.send).not.toHaveBeenCalled();
    manager.dispose();
  });
});

import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type {
  FileTreeDirectoryResponse,
  FileTreeRootsResponse,
} from '@canopy/desktop-shared/types';
import {
  createEmptyCostTotals,
  type CostChatView,
  type CostRefreshReceipt,
  type CostScopeView,
  type PipelineRunCostView,
} from '@canopy/protocol/cost-view';
import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { createCoreCostAdapter } from '../../canopy-runtime/core-cost-adapter';
import { CostServiceError } from '../errors';
import type { CostService } from '../service';

const SCOPE = {
  kind: 'entry',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
} as const;

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
  revision: 1,
};

const filesystemServices = {
  listFileTreeRoots: (): Promise<FileTreeRootsResponse> =>
    Promise.resolve({ roots: [] }),
  listFileTreeDirectory: (): Promise<FileTreeDirectoryResponse> =>
    Promise.resolve({ entries: [] }),
};

const readCaller: CanopyCallerDescriptor = {
  principalId: 'principal-1',
  clientInstanceId: 'client-1',
  authorityId: 'authority-1',
  interfaceKind: 'test',
  grants: ['core.cost.read'],
};

describe('core cost dispatcher', () => {
  const serviceCalls: string[] = [];
  let service: CostService;
  let dispatcher: ReturnType<typeof createDesktopRuntime>;

  beforeEach(() => {
    serviceCalls.length = 0;
    service = {
      getScope: jest.fn((request): Promise<CostScopeView> => {
        serviceCalls.push('getScope');
        expect(request.scope).toEqual(SCOPE);
        return Promise.resolve(scopeView);
      }),
      getChat: jest.fn((request): Promise<CostChatView> => {
        serviceCalls.push('getChat');
        expect(request.chatId).toBe('chat-1');
        return Promise.resolve(chatView);
      }),
      getPipelineRun: jest.fn((request): Promise<PipelineRunCostView> => {
        serviceCalls.push('getPipelineRun');
        expect(request.executionId).toBe('run-1');
        return Promise.resolve(pipelineRunView);
      }),
      refresh: jest.fn((request): Promise<CostRefreshReceipt> => {
        serviceCalls.push('refresh');
        expect(request.trigger).toBe('manual');
        return Promise.resolve(refreshReceipt);
      }),
    };
    dispatcher = createDesktopRuntime({
      services: filesystemServices,
      costService: service,
    });
  });

  afterEach(async () => {
    await dispatcher.shutdown();
  });

  it('registers the owner adapter and returns bare cost DTOs from core queries', async () => {
    await expect(
      dispatcher.query(
        'core.cost.scope.get',
        { scope: SCOPE },
        { caller: readCaller },
      ),
    ).resolves.toEqual(scopeView);
    await expect(
      dispatcher.query(
        'core.cost.chat.get',
        { scope: SCOPE, chatId: 'chat-1', detail: 'summary' },
        { caller: readCaller },
      ),
    ).resolves.toEqual(chatView);
    await expect(
      dispatcher.query(
        'core.cost.pipelineRun.get',
        { scope: SCOPE, executionId: 'run-1' },
        { caller: readCaller },
      ),
    ).resolves.toEqual(pipelineRunView);
    expect(serviceCalls).toEqual(['getScope', 'getChat', 'getPipelineRun']);
  });

  it('requires the core.cost.read grant before invoking the service', async () => {
    const callerWithoutGrant = { ...readCaller, grants: [] };
    await expect(
      dispatcher.query(
        'core.cost.scope.get',
        { scope: SCOPE },
        { caller: callerWithoutGrant },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(serviceCalls).toEqual([]);
  });

  it('resolves a lazy service only after a cost handler is invoked', async () => {
    const getService = jest.fn((): CostService => service);
    const adapter = createCoreCostAdapter(getService);
    expect(getService).not.toHaveBeenCalled();
    const context: CanopyHandlerContext = {
      requestId: 'request-1',
      caller: readCaller,
      metadata: {},
      signal: new AbortController().signal,
    };

    await expect(
      adapter.queries['core.cost.scope.get']({ scope: SCOPE }, context),
    ).resolves.toEqual(scopeView);
    expect(getService).toHaveBeenCalledTimes(1);
  });

  it('requires matching keyed instruction metadata and calls the service once', async () => {
    const key = 'cost-refresh-1';
    await expect(
      dispatcher.instruction(
        'core.cost.index.refresh',
        {
          scope: SCOPE,
          trigger: 'manual',
          _meta: { idempotencyKey: key },
        },
        { caller: readCaller, metadata: { idempotencyKey: key } },
      ),
    ).resolves.toEqual(refreshReceipt);
    expect(serviceCalls).toEqual(['refresh']);

    await expect(
      dispatcher.instruction(
        'core.cost.index.refresh',
        {
          scope: SCOPE,
          trigger: 'manual',
          _meta: { idempotencyKey: 'missing-metadata' },
        },
        { caller: readCaller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(serviceCalls).toEqual(['refresh']);
  });

  it('maps service failures to Canopy operation errors with content-free reasons', async () => {
    const failedGetScope = jest.fn(
      (): Promise<CostScopeView> =>
        Promise.reject(
          new CostServiceError('runtime_unavailable', 'ignored host detail'),
        ),
    );
    service.getScope = failedGetScope;
    try {
      await dispatcher.query(
        'core.cost.scope.get',
        { scope: SCOPE },
        { caller: readCaller },
      );
      throw new Error('Expected the operation to fail');
    } catch (error) {
      if (!(error instanceof CanopyOperationError)) {
        throw new Error('Expected a Canopy operation error');
      }
      expect(error).toMatchObject({
        payload: {
          kind: 'unavailable',
          code: 'core.cost.runtimeUnavailable',
          details: { reason: 'runtime_unavailable' },
          retry: { kind: 'same_request' },
        },
      });
      expect(error.payload.message).not.toContain('ignored host detail');
    }
    expect(failedGetScope).toHaveBeenCalledTimes(1);
  });
});

import type { CostClient } from '@canopy/app-core';
import {
  createEmptyCostTotals,
  type CostScopeRef,
  type CostScopeView,
  type CostUpdatedEvent,
  type CostViewResult,
} from '@canopy/protocol/cost-view';
import type { CostApi } from '@canopy/desktop-shared/types';
import { createIpcCostClient } from '../ipc-cost-client';

const SCOPE: CostScopeRef = {
  kind: 'entry',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};

const scopeView: CostScopeView = {
  scope: SCOPE,
  updatedAt: null,
  building: true,
  retentionDays: 7,
  totals: createEmptyCostTotals(),
  chats: [],
  pipelineRuns: [],
  hasCodexEstimate: false,
};

const okay: CostViewResult<CostScopeView> = {
  status: 'ok',
  value: scopeView,
};
const unavailable: CostViewResult<never> = {
  status: 'unavailable',
  reason: 'no_scope',
};
const error: CostViewResult<never> = {
  status: 'error',
  reason: 'NOT_FOUND',
  message: 'The cost row was not found.',
};

function costApi(overrides: Partial<CostApi> = {}): CostApi {
  return {
    getScope: jest.fn<
      ReturnType<CostApi['getScope']>,
      Parameters<CostApi['getScope']>
    >(() => Promise.resolve(okay)),
    getChat: jest.fn<
      ReturnType<CostApi['getChat']>,
      Parameters<CostApi['getChat']>
    >(() => Promise.resolve(error)),
    getPipelineRun: jest.fn<
      ReturnType<CostApi['getPipelineRun']>,
      Parameters<CostApi['getPipelineRun']>
    >(() => Promise.resolve(error)),
    refresh: jest.fn<
      ReturnType<CostApi['refresh']>,
      Parameters<CostApi['refresh']>
    >(() => Promise.resolve(unavailable)),
    watchScope: jest.fn<
      ReturnType<CostApi['watchScope']>,
      Parameters<CostApi['watchScope']>
    >(() => () => undefined),
    onUpdated: jest.fn<
      ReturnType<CostApi['onUpdated']>,
      Parameters<CostApi['onUpdated']>
    >(() => () => undefined),
    ...overrides,
  };
}

test('passes through successful, unavailable and error results from CostApi', async () => {
  const api = costApi();
  const client = createIpcCostClient(() => api);
  const chatRequest = { scope: SCOPE, chatId: 'chat-1' };
  const runRequest = { scope: SCOPE, executionId: 'run-1' };
  const refreshRequest = { scope: SCOPE, trigger: 'manual' as const };

  await expect(client.getScope({ scope: SCOPE })).resolves.toEqual(okay);
  await expect(client.getChat(chatRequest)).resolves.toEqual(error);
  await expect(client.getPipelineRun(runRequest)).resolves.toEqual(error);
  await expect(client.refresh(refreshRequest)).resolves.toEqual(unavailable);
});

test('turns a rejected IPC read into an UNKNOWN error result', async () => {
  const api = costApi({
    getScope: jest.fn<
      ReturnType<CostApi['getScope']>,
      Parameters<CostApi['getScope']>
    >(() => Promise.reject(new Error('IPC is unavailable.'))),
  });
  const client = createIpcCostClient(() => api);

  await expect(client.getScope({ scope: SCOPE })).resolves.toEqual({
    status: 'error',
    reason: 'UNKNOWN',
    message: 'IPC is unavailable.',
  });
});

test('reports an unavailable runtime when the preload API is missing', async () => {
  const client = createIpcCostClient(() => undefined);

  await expect(client.getScope({ scope: SCOPE })).resolves.toEqual({
    status: 'unavailable',
    reason: 'runtime_unavailable',
  });
  const release = client.watchScope(SCOPE);
  expect(() => release()).not.toThrow();
  const unsubscribe = client.subscribeUpdates(jest.fn());
  expect(() => unsubscribe()).not.toThrow();
});

test('releases a scope watch only once', () => {
  const release = jest.fn<void, []>();
  const client = createIpcCostClient(() =>
    costApi({
      watchScope: jest.fn<
        ReturnType<CostApi['watchScope']>,
        Parameters<CostApi['watchScope']>
      >(() => release),
    }),
  );

  const stopWatching = client.watchScope(SCOPE);
  stopWatching();
  stopWatching();

  expect(release).toHaveBeenCalledTimes(1);
});

test('delivers cost update events and unsubscribes', () => {
  const listeners: Array<(event: CostUpdatedEvent) => void> = [];
  const unsubscribe = jest.fn();
  const api = costApi({
    onUpdated: (callback): (() => void) => {
      listeners.push(callback);
      return unsubscribe;
    },
  });
  const client: CostClient = createIpcCostClient(() => api);
  const handler = jest.fn();
  const event: CostUpdatedEvent = { scopes: [SCOPE], revision: 3 };
  const stopListening = client.subscribeUpdates(handler);
  const listener = listeners[0];

  expect(listener).toBeDefined();
  if (listener !== undefined) listener(event);
  expect(handler).toHaveBeenCalledWith(event);
  stopListening();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

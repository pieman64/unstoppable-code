// A new_worktree start whose worktree.create fails retryably in the renderer
// runs again on retry, end to end through the port's renderer bridge: the
// main-process bridge and the renderer caches apply one replay rule.
// Deterministic: timers are fake (the bridge's request timeout never fires on
// wall time), renderer responses settle on promise microtasks, and every
// module the port loads lazily is loaded before the test runs.

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: jest.fn(),
  ipcMain: { removeHandler: jest.fn(), handle: jest.fn() },
}));
jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../../lib/window-send', () => ({
  sendToWindowDetailed: jest.fn(() => ({ delivered: true })),
}));
jest.mock('../../canopy-runtime/desktop-runtime-access', () => ({
  getDesktopCanopyRuntime: (): object => ({
    query: jest.fn(),
    instruction: (_name: string, params: { commandId: string }) =>
      Promise.resolve({
        commandId: params.commandId,
        revision: 1,
        outcome: 'applied',
      }),
  }),
}));

import type { AgentActionCall } from '@canopy/agent-actions';
import { isReplayableAppAdvisorResponse } from '@canopy/desktop-shared/lib/app-advisor-replay';
import {
  getAppAdvisorRendererToolRequestOriginChatId,
  getRendererToolRequestScopeKey,
  IPC_CHANNELS,
  type AppAdvisorRendererToolRequest,
  type AppAdvisorRendererToolResponse,
} from '@canopy/desktop-shared/types';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import {
  registerAppAdvisorHandlers,
  type AppAdvisorWindowAccessors,
} from '../../ipc/app-advisor';
import '../../canopy-tools/show-files-runtime';
import { registerIpcHandler } from '../../ipc/register';
import { sendToWindowDetailed } from '../../lib/window-send';
import {
  createDesktopEnvironmentPort,
  desktopEnvironmentPortDeps,
} from '../desktop-environment-port';
import { createDesktopAgentLineage } from '../desktop-limits-port';
import { seedEmptyApprovalRuleSources } from '../../__tests__/helpers/approval-rule-sources';

function respond(response: AppAdvisorRendererToolResponse): void {
  const handler = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.appAdvisorToolResponse,
    )?.[1];
  if (typeof handler !== 'function') throw new Error('No response handler');
  void handler(undefined as never, response);
}

function isToolRequest(value: unknown): value is AppAdvisorRendererToolRequest {
  return typeof value === 'object' && value !== null && 'requestId' in value;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

beforeAll(async () => {
  await seedEmptyApprovalRuleSources(['ws-1']);
});

it('runs a retried new_worktree start again after a retryable renderer failure', async () => {
  registerAppAdvisorHandlers({} as AppAdvisorWindowAccessors);
  // The renderer: a request id it settled replayably is answered from its
  // cache; anything else runs the action.
  const rendererCache = new Map<string, AppAdvisorRendererToolResponse>();
  let worktreeCreates = 0;
  jest
    .mocked(sendToWindowDetailed)
    .mockImplementation((_window, channel, payload) => {
      if (channel !== IPC_CHANNELS.appAdvisorToolRequest) {
        return { delivered: true };
      }
      if (!isToolRequest(payload) || payload.kind !== 'dispatch_action') {
        return { delivered: true };
      }
      const originChatId =
        getAppAdvisorRendererToolRequestOriginChatId(payload);
      const cacheKey = getRendererToolRequestScopeKey(
        payload.requestId,
        originChatId,
      );
      const cached = rendererCache.get(cacheKey);
      let response: AppAdvisorRendererToolResponse;
      if (cached) {
        response = cached;
      } else if (payload.action.type === 'worktree.create') {
        worktreeCreates += 1;
        response =
          worktreeCreates === 1
            ? {
                requestId: payload.requestId,
                ok: false,
                error: {
                  code: 'execution_failed',
                  message:
                    'Fresh source worktree status could not be verified.',
                  retryable: true,
                },
              }
            : {
                requestId: payload.requestId,
                ok: true,
                result: { workspaceId: 'ws-1', worktreeId: 'wt-new' },
              };
      } else {
        response = { requestId: payload.requestId, ok: true };
      }
      if (originChatId) response = { ...response, originChatId };
      if (isReplayableAppAdvisorResponse(response)) {
        rendererCache.set(cacheKey, response);
      }
      void Promise.resolve().then(() => respond(response));
      return { delivered: true };
    });

  const runtime: CanopyInjectedToolRuntime = {
    requestUserAnswers: () => Promise.resolve([]),
    loadScriptOutput: () => Promise.resolve({ found: false, lines: [] }),
    worktreeActionRuntime: {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-parent',
      cwd: '/worktree',
      getWindow: () => null,
    },
  };
  const call: AgentActionCall<CanopyInjectedToolRuntime> = {
    host: runtime,
    scope: { workspaceId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-parent' },
  };
  const reserveChat = jest.fn(() => Promise.resolve());
  const port = createDesktopEnvironmentPort(
    desktopEnvironmentPortDeps({
      chatApprovalPolicy: () =>
        Promise.resolve({
          mode: 'ask',
          sessionRules: [],
          root: '/ws/worktrees/wt-1',
        }),
      newChatApprovalMode: () => Promise.resolve('ask'),
      chatExecutionRoot: (chat) =>
        Promise.resolve(`/ws/worktrees/${chat.worktreeId}`),
      reserveChat,
      messageCommitted: () => Promise.resolve(false),
      agentSenderFields: () => Promise.resolve(undefined),
      lineage: createDesktopAgentLineage(),
    }),
  );
  const input = {
    scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
    placement: 'new_worktree' as const,
    message: { text: 'Prototype it.' },
    lineage: { parentChatId: 'chat-parent', depth: 1 },
    idempotencyKey: 'e2e-retry',
  };

  await expect(port.startChat(input, call)).rejects.toMatchObject({
    code: 'execution_failed',
    retryable: true,
  });
  await expect(port.startChat(input, call)).resolves.toMatchObject({
    worktreeId: 'wt-new',
    delivery: 'queued_for_setup',
  });
  expect(worktreeCreates).toBe(2);
  expect(reserveChat).toHaveBeenCalledTimes(1);
});

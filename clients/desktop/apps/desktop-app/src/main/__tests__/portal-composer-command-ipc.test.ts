jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindowDetailed: jest.fn(() => ({ delivered: true })),
}));

import {
  IPC_CHANNELS,
  type PortalChatComposerCommandResult,
  type PortalChatComposerSetterRequest,
} from '@canopy/desktop-shared/types';
import {
  registerPortalComposerCommandHandlers,
  requestPortalComposerCommand,
} from '../ipc/portal-composer-command';
import { registerIpcHandler } from '../ipc/register';
import { sendToWindowDetailed } from '../lib/window-send';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedSendToWindowDetailed = jest.mocked(sendToWindowDetailed);

type RegisteredIpcHandler = (event: unknown, ...args: unknown[]) => unknown;

function isRegisteredIpcHandler(value: unknown): value is RegisteredIpcHandler {
  return typeof value === 'function';
}

function getHandler(channel: string): RegisteredIpcHandler {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );
  if (!call) {
    throw new Error(`Expected handler for ${channel}`);
  }
  const handler: unknown = call[1];
  if (!isRegisteredIpcHandler(handler)) {
    throw new Error(`Expected registered handler for ${channel}`);
  }
  return handler;
}

function request(requestId: string): PortalChatComposerSetterRequest {
  return {
    requestId,
    command: {
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      kind: 'plan',
      planMode: true,
    },
  };
}

function respond(result: PortalChatComposerCommandResult): void {
  getHandler(IPC_CHANNELS.chatPortalComposerCommandResult)(undefined, result);
}

describe('Portal composer command IPC bridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
    registerPortalComposerCommandHandlers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits for the correlated renderer result', async () => {
    const command = request('setter-success');
    const promise = requestPortalComposerCommand(command, {
      getMainWindow: () => null,
    });

    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatPortalComposerCommand,
      command,
    );

    respond({ requestId: command.requestId, ok: true });
    await expect(promise).resolves.toEqual({
      requestId: command.requestId,
      ok: true,
    });
  });

  it('settles immediately when the renderer cannot receive the request', async () => {
    mockedSendToWindowDetailed.mockReturnValue({
      delivered: false,
      reason: 'no_window',
    });

    await expect(
      requestPortalComposerCommand(request('setter-unavailable'), {
        getMainWindow: () => null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'execution_failed',
      retryable: true,
    });
  });

  it('deduplicates waiters and times out an abandoned request', async () => {
    jest.useFakeTimers();
    const command = request('setter-timeout');
    const first = requestPortalComposerCommand(command, {
      getMainWindow: () => null,
    });
    const second = requestPortalComposerCommand(command, {
      getMainWindow: () => null,
    });

    jest.advanceTimersByTime(30_000);

    await expect(first).resolves.toMatchObject({
      requestId: command.requestId,
      ok: false,
      code: 'execution_failed',
      retryable: true,
    });
    await expect(second).resolves.toMatchObject({
      requestId: command.requestId,
      ok: false,
    });
    expect(mockedSendToWindowDetailed).toHaveBeenCalledTimes(1);

    // A late renderer result is ignored after the timeout settles the request.
    expect(() => {
      respond({ requestId: command.requestId, ok: true });
    }).not.toThrow();
  });

  it('rejects malformed renderer results without settling the request', () => {
    expect(() => {
      getHandler(IPC_CHANNELS.chatPortalComposerCommandResult)(undefined, {
        requestId: 'setter-malformed',
        ok: false,
      });
    }).toThrow(/Invalid Portal composer command failure result/i);
  });
});

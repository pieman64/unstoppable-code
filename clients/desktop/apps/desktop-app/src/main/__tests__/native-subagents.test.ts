import {
  IPC_CHANNELS,
  type NativeSubagentInterruptRequest,
  type NativeSubagentInterruptResult,
} from '@canopy/desktop-shared/types';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const mockGetClaudeTask = jest.fn();
const mockGetCodexState = jest.fn();
const mockStopClaudeSubagent = jest.fn();

jest.mock('../agents/session-manager', () => ({
  getClaudeNativeSubagentTaskForSession: (...args: unknown[]): unknown =>
    mockGetClaudeTask(...args),
  getCodexNativeSubagentInterruptState: (...args: unknown[]): unknown =>
    mockGetCodexState(...args),
}));

jest.mock('../agents/claude-session', () => ({
  stopNativeSubagentForClaudeSession: (...args: unknown[]): unknown =>
    mockStopClaudeSubagent(...args),
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ): void => {
    handlers.set(channel, handler);
  },
}));

import {
  interruptNativeSubagent,
  registerNativeSubagentHandlers,
} from '../ipc/native-subagents';

const TARGET = {
  projectId: 'project-a',
  worktreeId: 'worktree-a',
  chatId: 'chat-a',
};

function request(
  values: Partial<NativeSubagentInterruptRequest> = {},
): NativeSubagentInterruptRequest {
  return {
    ...TARGET,
    subagentKind: 'claude-native',
    subagentId: 'toolu_01TaskOne',
    ...values,
  };
}

function invokeRegisteredHandler(
  value: unknown,
): Promise<NativeSubagentInterruptResult> {
  const handler = handlers.get(IPC_CHANNELS.nativeSubagentInterrupt);
  if (!handler) throw new Error('Native subagent interrupt handler missing');
  return Promise.resolve(
    handler(undefined, value),
  ) as Promise<NativeSubagentInterruptResult>;
}

beforeEach(() => {
  handlers.clear();
  jest.clearAllMocks();
  registerNativeSubagentHandlers();
});

describe('native subagent interrupt IPC', () => {
  it('registers one typed native interrupt channel', () => {
    expect(handlers.has(IPC_CHANNELS.nativeSubagentInterrupt)).toBe(true);
  });

  it('stops the correlated Claude Task from the requested chat only', async () => {
    mockGetClaudeTask.mockReturnValue({
      taskId: 'provider-task-42',
      backgrounded: true,
    });
    mockStopClaudeSubagent.mockResolvedValue('stopped');

    await expect(invokeRegisteredHandler(request())).resolves.toEqual({
      ok: true,
    });
    expect(mockGetClaudeTask).toHaveBeenCalledWith(
      'project-a',
      'worktree-a',
      'chat-a',
      'toolu_01TaskOne',
    );
    expect(mockStopClaudeSubagent).toHaveBeenCalledWith(
      'project-a',
      'worktree-a',
      'chat-a',
      'toolu_01TaskOne',
      'provider-task-42',
      true,
    );
  });

  it.each([
    ['uppercase project id', request({ projectId: 'Project-a' })],
    ['path-like chat id', request({ chatId: '../other-chat' })],
    ['provider id with a path separator', request({ subagentId: 'toolu/a' })],
    [
      'overlong provider id',
      request({ subagentId: `toolu_${'a'.repeat(256)}` }),
    ],
    ['extra request property', { ...request(), rootSessionId: 'root' }],
  ])(
    'rejects %s before consulting or stopping a provider task',
    async (_name, value) => {
      await expect(invokeRegisteredHandler(value)).resolves.toMatchObject({
        ok: false,
        code: 'failed',
        error: 'Invalid native subagent request.',
      });
      expect(mockGetClaudeTask).not.toHaveBeenCalled();
      expect(mockGetCodexState).not.toHaveBeenCalled();
      expect(mockStopClaudeSubagent).not.toHaveBeenCalled();
    },
  );

  it('returns not_found for a stale or wrong-chat Claude UI id', async () => {
    mockGetClaudeTask.mockReturnValue(undefined);

    await expect(
      interruptNativeSubagent(request({ chatId: 'other-chat' })),
    ).resolves.toEqual({
      ok: false,
      code: 'not_found',
      error: 'Native subagent was not found in this chat.',
    });
    expect(mockGetClaudeTask).toHaveBeenCalledWith(
      'project-a',
      'worktree-a',
      'other-chat',
      'toolu_01TaskOne',
    );
    expect(mockStopClaudeSubagent).not.toHaveBeenCalled();
  });

  it('refuses a Claude foreground task that cannot safely background', async () => {
    mockGetClaudeTask.mockReturnValue({
      taskId: 'task-provider',
      backgrounded: false,
    });
    mockStopClaudeSubagent.mockResolvedValue('unsupported');
    await expect(interruptNativeSubagent(request())).resolves.toMatchObject({
      ok: false,
      code: 'unsupported',
    });
  });

  it('maps an already-finished Claude child to not_running', async () => {
    mockGetClaudeTask.mockReturnValue({
      taskId: 'provider-task-42',
      backgrounded: true,
    });
    mockStopClaudeSubagent.mockResolvedValue('not_running');

    await expect(interruptNativeSubagent(request())).resolves.toMatchObject({
      ok: false,
      code: 'not_running',
    });
  });

  it('fails closed when the Claude provider cannot stop the child', async () => {
    mockGetClaudeTask.mockReturnValue({
      taskId: 'provider-task-42',
      backgrounded: true,
    });
    mockStopClaudeSubagent.mockRejectedValue(new Error('query unavailable'));

    await expect(interruptNativeSubagent(request())).resolves.toMatchObject({
      ok: false,
      code: 'failed',
    });
  });

  it('returns unsupported for a correlated running Codex child without touching its root', async () => {
    mockGetCodexState.mockReturnValue('running');

    await expect(
      interruptNativeSubagent(
        request({
          subagentKind: 'codex-native',
          subagentId: 'child-thread-42',
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'unsupported' });

    expect(mockGetCodexState).toHaveBeenCalledWith(
      'project-a',
      'worktree-a',
      'chat-a',
      'child-thread-42',
    );
    // The IPC operation deliberately has no Codex root-turn interrupt path:
    // using it here could stop the root and clear its approvals or questions.
    expect(mockGetClaudeTask).not.toHaveBeenCalled();
    expect(mockStopClaudeSubagent).not.toHaveBeenCalled();
  });

  it('returns not_found rather than guessing for an uncorrelated Codex thread', async () => {
    mockGetCodexState.mockReturnValue('not_found');

    await expect(
      interruptNativeSubagent(
        request({
          subagentKind: 'codex-native',
          subagentId: 'foreign-or-stale-thread',
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'not_found' });
    expect(mockStopClaudeSubagent).not.toHaveBeenCalled();
  });

  it('returns not_running for a correlated but inactive Codex receiver', async () => {
    mockGetCodexState.mockReturnValue('not_running');

    await expect(
      interruptNativeSubagent(
        request({
          subagentKind: 'codex-native',
          subagentId: 'child-thread-42',
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'not_running' });
    expect(mockStopClaudeSubagent).not.toHaveBeenCalled();
  });
});

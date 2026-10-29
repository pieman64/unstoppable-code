import {
  createInMemoryAgentActionReceipts,
  type AgentActionCall,
} from '@canopy/agent-actions';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import {
  createDesktopSplitPort,
  type DesktopSplitPortDeps,
} from '../desktop-split-port';

const runtime: CanopyInjectedToolRuntime = {
  requestUserAnswers: () => Promise.resolve([]),
  loadScriptOutput: () => Promise.resolve({ found: false, lines: [] }),
  worktreeActionRuntime: {
    projectId: 'ws-1',
    worktreeId: 'wt-1',
    chatId: 'chat-parent',
    cwd: '/workspace/wt-1',
    getWindow: () => null,
  },
};

function call(
  overrides: Partial<AgentActionCall<CanopyInjectedToolRuntime>> = {},
): AgentActionCall<CanopyInjectedToolRuntime> {
  return {
    host: runtime,
    scope: { workspaceId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-parent' },
    turnKey: 'chat-parent:u1',
    toolUseId: 'tool-1',
    ...overrides,
  };
}

function harness(): {
  split: ReturnType<typeof createDesktopSplitPort>;
  startSplitAgent: jest.Mock<
    ReturnType<DesktopSplitPortDeps['startSplitAgent']>,
    Parameters<DesktopSplitPortDeps['startSplitAgent']>
  >;
} {
  let started = 0;
  const startSplitAgent = jest.fn<
    ReturnType<DesktopSplitPortDeps['startSplitAgent']>,
    Parameters<DesktopSplitPortDeps['startSplitAgent']>
  >((kind) => {
    started += 1;
    return Promise.resolve({
      ok: true,
      chatId: `${kind}-${started}`,
      worktreeId: kind === 'start_branched_agent' ? `wt-${started}` : 'wt-1',
      delivery: 'submitted',
      independent: true,
    });
  });
  return {
    split: createDesktopSplitPort({
      startSplitAgent,
      receipts: createInMemoryAgentActionReceipts(),
    }),
    startSplitAgent,
  };
}

describe('desktop split port', () => {
  it('returns the original result when a fork or branch is retried', async () => {
    const { split, startSplitAgent } = harness();
    for (const kind of ['forked', 'branched'] as const) {
      const input = { followUpInstruction: `Continue as ${kind}.` };
      const first = await split.start(kind, input, call());
      expect(JSON.parse(first.text)).toMatchObject({ ok: true });
      await expect(split.start(kind, input, call())).resolves.toEqual(first);
      const other = await split.start(
        kind,
        input,
        call({ toolUseId: 'tool-2' }),
      );
      expect(other).not.toEqual(first);
    }
    expect(startSplitAgent).toHaveBeenCalledTimes(4);
  });

  it('runs a retry again when the first attempt failed', async () => {
    const { split, startSplitAgent } = harness();
    startSplitAgent.mockRejectedValueOnce(new Error('Source chat is busy.'));
    const input = { followUpInstruction: 'Go' };
    await expect(split.start('forked', input, call())).resolves.toEqual({
      text: 'Source chat is busy.',
      isError: true,
    });
    const retry = await split.start('forked', input, call());
    expect(JSON.parse(retry.text)).toMatchObject({ ok: true });
    expect(startSplitAgent).toHaveBeenCalledTimes(2);
  });

  it('refuses a fork that reuses a tool call for a different instruction', async () => {
    const { split, startSplitAgent } = harness();
    await split.start('forked', { followUpInstruction: 'First.' }, call());
    const reused = await split.start(
      'forked',
      { followUpInstruction: 'Something else.' },
      call(),
    );
    expect(reused.isError).toBe(true);
    expect(JSON.parse(reused.text)).toMatchObject({
      ok: false,
      error: { code: 'idempotency_conflict' },
    });
    expect(startSplitAgent).toHaveBeenCalledTimes(1);
  });

  it('passes turn cancellation into the native fork without changing the captured scope', async () => {
    const { split, startSplitAgent } = harness();
    const controller = new AbortController();
    await split.start(
      'forked',
      { followUpInstruction: 'Continue.' },
      call({ signal: controller.signal }),
    );
    const source = startSplitAgent.mock.calls[0]?.[2];
    expect(source?.signal).toBe(controller.signal);
    controller.abort();
    expect(source?.signal?.aborted).toBe(true);
    expect(runtime.worktreeActionRuntime?.signal).toBeUndefined();
  });

  it('refuses a cancelled split before creating a native fork and permits a fresh retry', async () => {
    const { split, startSplitAgent } = harness();
    const controller = new AbortController();
    controller.abort(new Error('The source turn was cancelled.'));
    const input = { followUpInstruction: 'Continue.' };
    await expect(
      split.start('forked', input, call({ signal: controller.signal })),
    ).resolves.toEqual({
      text: 'The source turn was cancelled.',
      isError: true,
    });
    expect(startSplitAgent).not.toHaveBeenCalled();
    const result = await split.start('forked', input, call());
    expect(JSON.parse(result.text)).toMatchObject({ ok: true });
    expect(startSplitAgent).toHaveBeenCalledTimes(1);
  });

  it('replays a completed split after its original turn is cancelled', async () => {
    const { split, startSplitAgent } = harness();
    const controller = new AbortController();
    const input = { followUpInstruction: 'Continue.' };
    const invocation = call({ signal: controller.signal });
    const result = await split.start('forked', input, invocation);
    controller.abort();
    await expect(split.start('forked', input, invocation)).resolves.toEqual(
      result,
    );
    expect(startSplitAgent).toHaveBeenCalledTimes(1);
  });

  it.each(['turn', 'host'])(
    'preserves both cancellation sources when the %s aborts',
    async (origin) => {
      const { split, startSplitAgent } = harness();
      const turn = new AbortController();
      const host = new AbortController();
      const scope = runtime.worktreeActionRuntime;
      if (!scope) throw new Error('Missing test scope');
      await split.start(
        'forked',
        { followUpInstruction: 'Continue.' },
        call({
          signal: turn.signal,
          host: {
            ...runtime,
            worktreeActionRuntime: { ...scope, signal: host.signal },
          },
        }),
      );
      const source = startSplitAgent.mock.calls[0]?.[2];
      expect(source?.signal?.aborted).toBe(false);
      (origin === 'turn' ? turn : host).abort();
      expect(source?.signal?.aborted).toBe(true);
    },
  );
});

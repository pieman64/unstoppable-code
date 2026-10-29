import type { AgentDelegationEvent } from '@canopy/protocol/delegation';
import type { AgentRunRequest } from '../types';
import { LocalDelegationRunner } from '../local-runner';
import { routeFixture } from './fixtures';

function request(controller: AbortController): AgentRunRequest {
  return {
    delegationId: 'child',
    runGeneration: 1,
    launchKey: 'launch',
    parent: {
      harnessId: 'claude',
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      sessionKey: 'p/w/c',
      turnId: 't',
      toolCallId: 'call',
      runtimeGeneration: 1,
      depth: 0,
    },
    task: {
      modelId: 'logical-review-model',
      description: 'Review',
      prompt: 'Review this code',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
      executionMode: 'background',
    },
    route: routeFixture(),
    cwd: '/test/worktree',
    effectivePermission: 'read-only',
    signal: controller.signal,
  };
}

describe('local delegated runner lifecycle', () => {
  it('publishes terminal completion without waiting for descendant results', async () => {
    const events: AgentDelegationEvent[] = [];
    const prompts: string[] = [];
    const released: number[] = [];
    let turn = 0;
    const runner = new LocalDelegationRunner(
      'claude',
      'sdk',
      () => Promise.resolve({ available: true }),
      async (context) => {
        const current = ++turn;
        prompts.push(context.request.task.prompt);
        if (current === 2) {
          expect(context.request.resumeSessionId).toBe('native-child');
          expect(released).toEqual([1]);
        }
        context.retain(() => {
          released.push(current);
          return Promise.resolve();
        });
        await context.emit({
          type: 'started',
          nativeSessionId: 'native-child',
        });
        await context.emit({
          type: 'transcript',
          items: [
            {
              id: 'text',
              sequence: 1,
              occurredAt: current,
              type: 'text',
              text: `turn ${current}`,
            },
          ],
        });
        return { status: 'completed', finalText: `answer ${current}` };
      },
      jest.fn(),
    );
    const handle = await runner.start(
      request(new AbortController()),
      (event) => {
        events.push(event);
        return Promise.resolve();
      },
    );
    await runner.close(handle);
    expect(prompts).toEqual(['Review this code']);
    expect(
      events.filter((event) => event.event.type === 'terminal'),
    ).toHaveLength(1);
    expect(events[events.length - 1]?.event).toMatchObject({
      type: 'terminal',
      finalText: 'answer 1',
    });
    const transcript = events
      .slice()
      .reverse()
      .find((event) => event.event.type === 'transcript')?.event;
    expect(transcript).toMatchObject({
      items: [expect.objectContaining({ text: 'turn 1' })],
    });
    expect(released).toEqual([1]);
  });

  it('keeps transcript identities unique and within the wire limit', async () => {
    const events: AgentDelegationEvent[] = [];
    let turn = 0;
    const runner = new LocalDelegationRunner(
      'claude',
      'sdk',
      () => Promise.resolve({ available: true }),
      async (context) => {
        turn++;
        await context.emit({
          type: 'transcript',
          items: [
            {
              id: turn === 1 ? 'turn1:text' : 'text',
              sequence: 1,
              occurredAt: turn,
              type: 'text',
              text: 'content',
            },
            {
              id: 'x'.repeat(512),
              sequence: 2,
              occurredAt: turn,
              type: 'text',
              text: 'long id',
            },
          ],
        });
        return { status: 'completed' };
      },
      jest.fn(),
    );
    const handle = await runner.start(
      request(new AbortController()),
      (event) => {
        events.push(event);
        return Promise.resolve();
      },
    );
    await runner.close(handle);
    const event = events
      .slice()
      .reverse()
      .find((item) => item.event.type === 'transcript')?.event;
    if (event?.type !== 'transcript') throw new Error('Missing transcript');
    expect(new Set(event.items.map((item) => item.id)).size).toBe(2);
    expect(event.items.every((item) => item.id.length <= 512)).toBe(true);
  });

  it('does not reserialize an unchanged cumulative transcript prefix', async () => {
    const serializePrefix = jest.fn(() => ({
      id: 'prefix',
      sequence: 1,
      occurredAt: 1,
      type: 'text',
      text: 'stable prefix',
    }));
    const prefix = {
      id: 'prefix',
      sequence: 1,
      occurredAt: 1,
      type: 'text' as const,
      text: 'stable prefix',
      toJSON: serializePrefix,
    };
    const runner = new LocalDelegationRunner(
      'claude',
      'sdk',
      () => Promise.resolve({ available: true }),
      async (context) => {
        await context.emit({
          type: 'transcript',
          items: [
            prefix,
            {
              id: 'tail',
              sequence: 2,
              occurredAt: 1,
              type: 'text',
              text: 'partial',
            },
          ],
        });
        await context.emit({
          type: 'transcript',
          items: [
            prefix,
            {
              id: 'tail',
              sequence: 2,
              occurredAt: 2,
              type: 'text',
              text: 'complete',
            },
          ],
        });
        return { status: 'completed' };
      },
      jest.fn(),
    );
    const handle = await runner.start(request(new AbortController()), () =>
      Promise.resolve(),
    );
    await runner.close(handle);
    expect(serializePrefix).toHaveBeenCalledTimes(1);
  });

  it('publishes usage for the completed broker generation only', async () => {
    const events: AgentDelegationEvent[] = [];
    let turn = 0;
    const runner = new LocalDelegationRunner(
      'codex',
      'app-server',
      () => Promise.resolve({ available: true }),
      () =>
        Promise.resolve({
          status: 'completed',
          usage: { inputTokens: ++turn === 1 ? 100 : 150 },
        }),
      jest.fn(),
    );
    const handle = await runner.start(
      request(new AbortController()),
      (event) => {
        events.push(event);
        return Promise.resolve();
      },
    );
    await runner.close(handle);
    expect(events[events.length - 1]?.event).toMatchObject({
      type: 'terminal',
      usage: { inputTokens: 100 },
    });
  });

  it('serializes events and releases resources before reporting completion', async () => {
    const events: AgentDelegationEvent[] = [];
    const close = jest.fn(() => Promise.resolve());
    const runner = new LocalDelegationRunner(
      'claude',
      'sdk',
      () => Promise.resolve({ available: true }),
      async (context) => {
        context.retain(close);
        await context.emit({ type: 'started', nativeSessionId: 'native' });
        await context.emit({ type: 'progress', text: 'Partial result' });
        return { status: 'completed', finalText: 'Final result' };
      },
      jest.fn(),
    );
    const handle = await runner.start(
      request(new AbortController()),
      (event) => {
        if (event.event.type === 'terminal')
          expect(close).toHaveBeenCalledTimes(1);
        events.push(event);
        return Promise.resolve();
      },
    );
    await runner.close(handle);
    await runner.close(handle);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('delivers steering to the exact active native run without starting another generation', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const steered = jest.fn(() =>
      Promise.resolve({
        kind: 'accepted' as const,
        attemptId: 'steer-1',
        providerTurnId: 'native-turn',
      }),
    );
    const runner = new LocalDelegationRunner(
      'codex',
      'app-server',
      () => Promise.resolve({ available: true }),
      async (context) => {
        context.setSteer(steered);
        await pending;
        return { status: 'completed' };
      },
      jest.fn(),
    );
    const handle = await runner.start(request(new AbortController()), () =>
      Promise.resolve(),
    );
    await Promise.resolve();
    await expect(
      runner.steer(handle, {
        delegationId: 'child',
        runGeneration: 1,
        attemptId: 'steer-1',
        message: 'Refocus on the error path.',
      }),
    ).resolves.toEqual({
      kind: 'accepted',
      attemptId: 'steer-1',
      providerTurnId: 'native-turn',
    });
    expect(steered).toHaveBeenCalledTimes(1);
    finish();
    await runner.close(handle);
  });

  it('interrupts only its native owner and awaits cleanup on cancellation', async () => {
    const controller = new AbortController();
    const close = jest.fn(() => Promise.resolve());
    const interrupt = jest.fn(() => Promise.resolve());
    const events: AgentDelegationEvent[] = [];
    const runner = new LocalDelegationRunner(
      'codex',
      'app-server',
      () => Promise.resolve({ available: true }),
      async (context) => {
        context.retain(close);
        context.setInterrupt(interrupt);
        await new Promise<void>((resolve) =>
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        return { status: 'cancelled' };
      },
      jest.fn(),
    );
    const handle = await runner.start(request(controller), (event) => {
      events.push(event);
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(await runner.stop(handle, 'deadline_exceeded')).toEqual({
      stopped: true,
    });
    await runner.close(handle);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(events[0]?.event).toMatchObject({
      type: 'terminal',
      status: 'deadline_exceeded',
    });
  });

  it('retains failed cleanup for an explicit retry and never reports success for it', async () => {
    const events: AgentDelegationEvent[] = [];
    const close = jest
      .fn()
      .mockRejectedValueOnce(new Error('Native handle still open'))
      .mockResolvedValue(undefined);
    const runner = new LocalDelegationRunner(
      'claude',
      'sdk',
      () => Promise.resolve({ available: true }),
      (context) => {
        context.retain(close);
        return Promise.resolve({
          status: 'completed',
          finalText: 'Finding',
          usage: { inputTokens: 7 },
        });
      },
      jest.fn(),
    );
    const handle = await runner.start(
      request(new AbortController()),
      (event) => {
        events.push(event);
        return Promise.resolve();
      },
    );
    await runner.close(handle);
    expect(events[0]?.event).toMatchObject({
      type: 'terminal',
      status: 'failed',
      finalText: 'Finding',
      usage: { inputTokens: 7 },
      error: { code: 'launch_uncertain' },
    });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('reports a timeout outside a cleanup attempt without repeating its failures', async () => {
    const report = jest.fn<void, [unknown]>();
    const runner = new LocalDelegationRunner(
      'claude',
      'claude-sdk',
      () => Promise.resolve({ available: true }),
      (context) => {
        const close = jest.fn<Promise<void>, []>();
        context.retain(close.mockRejectedValue(new Error('Still open')), {
          label: 'native-process',
          phase: 'native',
        });
        return Promise.resolve({ status: 'completed', finalText: 'Finding' });
      },
      report,
    );
    // The terminal receipt never lands, so the task outlives its cleanup.
    const handle = await runner.start(
      request(new AbortController()),
      () => new Promise<void>(() => undefined),
    );
    while (report.mock.calls.length === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    try {
      const closing = runner.close(handle);
      void closing.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(15_000);
      await expect(closing).rejects.toThrow('Delegation cleanup timed out');
    } finally {
      jest.useRealTimers();
    }
    const diagnostic = { attempt: 1, retained: 1 };
    expect(report.mock.calls).toMatchObject([
      [{ diagnostic: { ...diagnostic, outcome: 'rejected' } }],
      [{ diagnostic: { ...diagnostic, outcome: 'timeout', failures: [] } }],
    ]);
    expect(report.mock.calls[0]).toHaveProperty('0.diagnostic.failures', [
      expect.objectContaining({
        label: 'native-process',
        settlement: 'rejected',
      }),
    ]);
  });

  it('continues delivering later events after one sink call rejects', async () => {
    const events: AgentDelegationEvent[] = [];
    const rejected = new Error('approval state was not retained');
    const runner = new LocalDelegationRunner(
      'claude',
      'sdk',
      () => Promise.resolve({ available: true }),
      async (context) => {
        await expect(
          context.emit({ type: 'approval', pending: true }),
        ).rejects.toBe(rejected);
        return { status: 'completed', finalText: 'Retained result' };
      },
      jest.fn(),
    );
    const handle = await runner.start(
      request(new AbortController()),
      (event) => {
        if (event.event.type === 'approval') return Promise.reject(rejected);
        events.push(event);
        return Promise.resolve();
      },
    );

    await runner.close(handle);

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({
      type: 'terminal',
      status: 'completed',
      finalText: 'Retained result',
    });
    expect(events[0]?.sequence).toBe(2);
  });
});

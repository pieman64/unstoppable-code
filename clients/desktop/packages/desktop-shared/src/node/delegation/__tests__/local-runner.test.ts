import type {
  AgentDelegationEvent,
  AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import type {
  DelegationTranscriptChange,
  DelegationTranscriptPort,
  DelegationTranscriptPortError,
  DelegationTranscriptTarget,
} from '../transcript-port';
import type { AgentRunRequest } from '../types';
import { captureSettlementAnswer } from '../broker-settlement-contract';
import { createDelegationRunState, reduceDelegationEvent } from '../lifecycle';
import {
  LocalDelegationRunner,
  type LocalDelegationContext,
  type LocalDelegationOutcome,
} from '../local-runner';
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

function transcriptTarget(
  runRequest: AgentRunRequest = request(new AbortController()),
): DelegationTranscriptTarget {
  return {
    kind: 'delegation',
    chatId: runRequest.parent.chatId,
    delegationId: runRequest.delegationId,
    runGeneration: runRequest.runGeneration,
  };
}

function transcriptChange(
  id: string,
  itemRevision: number,
): DelegationTranscriptChange {
  return {
    row: {
      id,
      role: 'assistant',
      timestamp: 1,
      parentBlockId: 'agent-call',
      delegationSequence: 0,
      blocks: [],
      itemRevision,
      final: false,
    },
  };
}

function createTranscriptPort(
  options: {
    readonly open?: DelegationTranscriptPort['open'];
    readonly appendChanges?: DelegationTranscriptPort['appendChanges'];
  } = {},
): DelegationTranscriptPort {
  let streamRevision = 0;
  const missing: DelegationTranscriptPortError = {
    code: 'not_found',
    message: 'Missing transcript item.',
    retryable: false,
  };
  const unsupported: DelegationTranscriptPortError = {
    code: 'unsupported_format',
    message: 'Transcript results are not available.',
    retryable: false,
  };
  return {
    open:
      options.open ??
      (({ target }): ReturnType<DelegationTranscriptPort['open']> =>
        Promise.resolve<Awaited<ReturnType<DelegationTranscriptPort['open']>>>({
          ok: true,
          value: {
            target,
            status: 'open',
            streamRevision: 0,
            openedAt: null,
            latestRowTimestamp: null,
          },
        })),
    appendChanges:
      options.appendChanges ??
      (({
        target,
        mutationKey,
        changes,
      }): ReturnType<DelegationTranscriptPort['appendChanges']> => {
        streamRevision += 1;
        return Promise.resolve<
          Awaited<ReturnType<DelegationTranscriptPort['appendChanges']>>
        >({
          ok: true,
          value: {
            target,
            mutationKey,
            streamRevision,
            items: changes.map(({ row }) => ({
              id: row.id,
              itemRevision: row.itemRevision,
              final: row.final,
            })),
            replayed: false,
          },
        });
      }),
    flush: ({
      target,
      streamRevision: expectedRevision,
    }): ReturnType<DelegationTranscriptPort['flush']> =>
      Promise.resolve<Awaited<ReturnType<DelegationTranscriptPort['flush']>>>({
        ok: true,
        value: {
          target,
          status: 'open',
          streamRevision: expectedRevision,
          openedAt: null,
          latestRowTimestamp: null,
        },
      }),
    registerGeneration: (): ReturnType<
      DelegationTranscriptPort['registerGeneration']
    > => Promise.resolve({ ok: false, error: unsupported }),
    appendReceipt: (): ReturnType<DelegationTranscriptPort['appendReceipt']> =>
      Promise.resolve({ ok: false, error: unsupported }),
    receipt: (): ReturnType<DelegationTranscriptPort['receipt']> =>
      Promise.resolve({ ok: false, error: unsupported }),
    result: (): ReturnType<DelegationTranscriptPort['result']> =>
      Promise.resolve({ ok: false, error: unsupported }),
    resultBySettlementKey: (): ReturnType<
      DelegationTranscriptPort['resultBySettlementKey']
    > => Promise.resolve({ ok: false, error: unsupported }),
    resultByGeneration: (): ReturnType<
      DelegationTranscriptPort['resultByGeneration']
    > => Promise.resolve({ ok: false, error: unsupported }),
    generation: (): ReturnType<DelegationTranscriptPort['generation']> =>
      Promise.resolve({ ok: false, error: unsupported }),
    generationsPage: (): ReturnType<
      DelegationTranscriptPort['generationsPage']
    > => Promise.resolve({ ok: false, error: unsupported }),
    resultAnswerRange: (): ReturnType<
      DelegationTranscriptPort['resultAnswerRange']
    > => Promise.resolve({ ok: false, error: unsupported }),
    updateCardState: (): ReturnType<
      DelegationTranscriptPort['updateCardState']
    > => Promise.resolve({ ok: false, error: unsupported }),
    settle: (): ReturnType<DelegationTranscriptPort['settle']> =>
      Promise.resolve<Awaited<ReturnType<DelegationTranscriptPort['settle']>>>({
        ok: false,
        error: unsupported,
      }),
    page: ({
      streamRevision: expectedRevision,
    }): ReturnType<DelegationTranscriptPort['page']> =>
      Promise.resolve<Awaited<ReturnType<DelegationTranscriptPort['page']>>>({
        ok: true,
        value: { rows: [], streamRevision: expectedRevision },
      }),
    message: (): ReturnType<DelegationTranscriptPort['message']> =>
      Promise.resolve<Awaited<ReturnType<DelegationTranscriptPort['message']>>>(
        { ok: false, error: missing },
      ),
    contentRange: (): ReturnType<DelegationTranscriptPort['contentRange']> =>
      Promise.resolve<
        Awaited<ReturnType<DelegationTranscriptPort['contentRange']>>
      >({ ok: false, error: missing }),
    resultsPage: (): ReturnType<DelegationTranscriptPort['resultsPage']> =>
      Promise.resolve<
        Awaited<ReturnType<DelegationTranscriptPort['resultsPage']>>
      >({ ok: false, error: unsupported }),
  };
}

function createRunner(
  execute: (context: LocalDelegationContext) => Promise<LocalDelegationOutcome>,
  options: { readonly transcriptPort?: DelegationTranscriptPort } = {},
): LocalDelegationRunner {
  return new LocalDelegationRunner(
    'claude',
    'sdk',
    () => Promise.resolve({ available: true }),
    execute,
    jest.fn(),
    options,
  );
}

function streamingRequest(
  controller: AbortController,
  target: DelegationTranscriptTarget = transcriptTarget(request(controller)),
): AgentRunRequest {
  return { ...request(controller), transcriptStream: { target } };
}

async function collectEvents(
  runner: LocalDelegationRunner,
  runRequest: AgentRunRequest,
): Promise<AgentDelegationEvent[]> {
  const events: AgentDelegationEvent[] = [];
  const handle = await runner.start(runRequest, (event) => {
    events.push(event);
    return Promise.resolve();
  });
  await runner.close(handle);
  return events;
}

describe('local delegated runner lifecycle', () => {
  it.each([
    { label: 'none', finalText: undefined },
    { label: 'empty', finalText: '' },
    { label: 'ASCII whitespace and NUL', finalText: ' \tAnswer\r\n\0 ' },
    { label: 'astral and decomposed text', finalText: ' 🌿e\u0301\r\n' },
    { label: 'lone high surrogate', finalText: '\uD800' },
    { label: 'lone low surrogate', finalText: '\uDC00' },
    {
      // storage.ts's legacy text cap is 16 Mi UTF-16 code units. The
      // transient stream handoff must exceed both that cap and 64 KiB.
      label: 'larger than the legacy storage cap and 64 KiB',
      finalText: ` ${'x'.repeat(16 * 1024 * 1024)}🌿\uD800\r\n `,
    },
  ])(
    'hands off exact $label finalText for stream and legacy runs',
    async ({ finalText }) => {
      const progressText = `${'é'.repeat(32_768)}x`;
      for (const stream of [true, false]) {
        const controller = new AbortController();
        const runRequest = stream
          ? streamingRequest(controller)
          : request(controller);
        let state = createDelegationRunState(
          runRequest.delegationId,
          runRequest.runGeneration,
        );
        const events: AgentDelegationEvent[] = [];
        const runner = createRunner(
          async (context) => {
            await context.emit({ type: 'started' });
            await context.emit({
              type: 'progress',
              text: progressText,
              truncated: true,
            });
            return {
              status: 'completed',
              ...(finalText === undefined ? {} : { finalText }),
            };
          },
          { transcriptPort: createTranscriptPort() },
        );
        const handle = await runner.start(runRequest, (envelope) => {
          // Even a reduction before capture must leave the exact event intact.
          Object.freeze(envelope.event);
          state = reduceDelegationEvent(state, envelope);
          events.push(envelope);
          return Promise.resolve();
        });
        await runner.close(handle);

        const terminal = events[events.length - 1]?.event;
        if (terminal?.type !== 'terminal')
          throw new Error('Missing terminal event');
        expect(terminal.status).toBe('completed');
        expect(terminal.finalText).toBe(finalText);
        expect(state.finalText).toBe(finalText);
        expect(state.partialText).toBe(
          stream ? `${'é'.repeat(32_767)}x` : progressText,
        );
        expect(state.outputTruncated).toBe(!stream);
        expect(
          captureSettlementAnswer(terminal.finalText).settleAnswer,
        ).toEqual(
          finalText === undefined ? null : { role: 'final', text: finalText },
        );
        if (finalText === undefined) {
          expect(terminal).not.toHaveProperty('finalText');
          expect(state).not.toHaveProperty('finalText');
        }
      }
    },
  );

  it('fails with transcript storage attribution when storage failure overlaps stop', async () => {
    const controller = new AbortController();
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseExecution: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const events: AgentDelegationEvent[] = [];
    const runner = createRunner(
      async (context) => {
        markStarted();
        await release;
        context.failTranscript?.(new Error('spool append failed'));
        return { status: 'cancelled' };
      },
      { transcriptPort: createTranscriptPort() },
    );
    const handle = await runner.start(streamingRequest(controller), (event) => {
      events.push(event);
      return Promise.resolve();
    });

    await started;
    const stopping = runner.stop(handle, 'user_cancelled');
    releaseExecution();
    await stopping;
    await runner.close(handle);

    expect(events.at(-1)?.event).toMatchObject({
      type: 'terminal',
      status: 'failed',
      error: {
        code: 'runtime_error',
        message:
          'The delegated transcript could not be saved. Retained partial output is available.',
      },
    });
  });

  it('keeps an ordinary stop cancelled when stream storage is healthy', async () => {
    const controller = new AbortController();
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const events: AgentDelegationEvent[] = [];
    const runner = createRunner(
      async (context) => {
        markStarted();
        await new Promise<void>((resolve) =>
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        return { status: 'cancelled' };
      },
      { transcriptPort: createTranscriptPort() },
    );
    const handle = await runner.start(streamingRequest(controller), (event) => {
      events.push(event);
      return Promise.resolve();
    });

    await started;
    await runner.stop(handle, 'user_cancelled');
    await runner.close(handle);

    expect(events.at(-1)?.event).toMatchObject({
      type: 'terminal',
      status: 'cancelled',
    });
  });

  it('awaits the trusted target open before launching native execution', async () => {
    const baseRequest = request(new AbortController());
    const trustedRequest: AgentRunRequest = {
      ...baseRequest,
      delegationId: 'trusted-child',
      runGeneration: 7,
      parent: { ...baseRequest.parent, chatId: 'trusted-chat' },
    };
    const target = transcriptTarget(trustedRequest);
    let enterOpen: (() => void) | undefined;
    const openEntered = new Promise<void>((resolve) => {
      enterOpen = resolve;
    });
    let releaseOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const execute = jest.fn(
      (): Promise<LocalDelegationOutcome> =>
        Promise.resolve({ status: 'completed' }),
    );
    const port = createTranscriptPort({
      open: async ({ target: openedTarget }, signal) => {
        expect(openedTarget).toEqual(target);
        expect(signal).toBe(trustedRequest.signal);
        enterOpen?.();
        await openGate;
        return {
          ok: true,
          value: {
            target: openedTarget,
            status: 'open',
            streamRevision: 0,
            openedAt: null,
            latestRowTimestamp: null,
          },
        };
      },
    });
    const runner = createRunner(execute, { transcriptPort: port });
    const starting = runner.start(
      { ...trustedRequest, transcriptStream: { target } },
      () => Promise.resolve(),
    );
    await openEntered;
    expect(execute).not.toHaveBeenCalled();
    releaseOpen?.();
    const handle = await starting;
    await runner.close(handle);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    { marker: false, injectPort: false, shouldStart: true, shouldOpen: false },
    { marker: false, injectPort: true, shouldStart: true, shouldOpen: false },
    { marker: true, injectPort: false, shouldStart: false, shouldOpen: false },
    { marker: true, injectPort: true, shouldStart: true, shouldOpen: true },
  ])(
    'handles stream marker=$marker port=$injectPort without changing legacy launches',
    async ({ marker, injectPort, shouldStart, shouldOpen }) => {
      const target = transcriptTarget();
      let openCalls = 0;
      let executeCalls = 0;
      const executionOrder: string[] = [];
      const port = createTranscriptPort({
        open: ({ target: openedTarget }) => {
          openCalls += 1;
          executionOrder.push('open');
          expect(openedTarget).toEqual(target);
          return Promise.resolve({
            ok: true,
            value: {
              target: openedTarget,
              status: 'open',
              streamRevision: 0,
              openedAt: null,
              latestRowTimestamp: null,
            },
          });
        },
      });
      const runner = createRunner(
        (): Promise<LocalDelegationOutcome> => {
          executeCalls += 1;
          executionOrder.push('execute');
          return Promise.resolve({ status: 'completed' });
        },
        injectPort ? { transcriptPort: port } : {},
      );
      const controller = new AbortController();
      const runRequest = marker
        ? streamingRequest(controller, target)
        : request(controller);

      if (shouldStart) {
        const handle = await runner.start(runRequest, () => Promise.resolve());
        await runner.close(handle);
      } else {
        await expect(
          runner.start(runRequest, () => Promise.resolve()),
        ).rejects.toThrow(/transcript/i);
      }

      expect(openCalls).toBe(shouldOpen ? 1 : 0);
      expect(executeCalls).toBe(shouldStart ? 1 : 0);
      expect(executionOrder).toEqual(
        shouldOpen ? ['open', 'execute'] : shouldStart ? ['execute'] : [],
      );
    },
  );

  it.each([
    {
      label: 'chatId',
      target: {
        kind: 'delegation',
        chatId: 'another-chat',
        delegationId: 'child',
        runGeneration: 1,
      },
    },
    {
      label: 'delegationId',
      target: {
        kind: 'delegation',
        chatId: 'c',
        delegationId: 'another-child',
        runGeneration: 1,
      },
    },
    {
      label: 'runGeneration',
      target: {
        kind: 'delegation',
        chatId: 'c',
        delegationId: 'child',
        runGeneration: 2,
      },
    },
  ])(
    'rejects a stream target with a mismatched $label before opening or execution',
    async ({ target }) => {
      const expectedTarget: DelegationTranscriptTarget = {
        kind: 'delegation',
        chatId: target.chatId,
        delegationId: target.delegationId,
        runGeneration: target.runGeneration,
      };
      let openCalls = 0;
      let executeCalls = 0;
      const port = createTranscriptPort({
        open: ({ target: openedTarget }) => {
          openCalls += 1;
          return Promise.resolve({
            ok: true,
            value: {
              target: openedTarget,
              status: 'open',
              streamRevision: 0,
              openedAt: null,
              latestRowTimestamp: null,
            },
          });
        },
      });
      const runner = createRunner(
        (): Promise<LocalDelegationOutcome> => {
          executeCalls += 1;
          return Promise.resolve({ status: 'completed' });
        },
        { transcriptPort: port },
      );

      await expect(
        runner.start(
          streamingRequest(new AbortController(), expectedTarget),
          () => Promise.resolve(),
        ),
      ).rejects.toThrow(/transcript/i);

      expect(openCalls).toBe(0);
      expect(executeCalls).toBe(0);
    },
  );

  it('rejects a failed stream open before starting native execution', async () => {
    let executeCalls = 0;
    const runner = createRunner(
      (): Promise<LocalDelegationOutcome> => {
        executeCalls += 1;
        return Promise.resolve({ status: 'completed' });
      },
      {
        transcriptPort: createTranscriptPort({
          open: (): ReturnType<DelegationTranscriptPort['open']> =>
            Promise.resolve({
              ok: false,
              error: {
                code: 'storage_failure',
                message: 'The stream could not be opened.',
                retryable: false,
              },
            }),
        }),
      },
    );

    await expect(
      runner.start(streamingRequest(new AbortController()), () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow(/transcript/i);
    expect(executeCalls).toBe(0);
  });

  it('reserves a pending stream start and rechecks cancellation after open', async () => {
    let releaseOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const port = createTranscriptPort({
      open: async ({
        target,
      }): Promise<Awaited<ReturnType<DelegationTranscriptPort['open']>>> => {
        await openGate;
        return {
          ok: true,
          value: {
            target,
            status: 'open',
            streamRevision: 0,
            openedAt: null,
            latestRowTimestamp: null,
          },
        };
      },
    });
    const controller = new AbortController();
    let executeCalls = 0;
    const runner = createRunner(
      (): Promise<LocalDelegationOutcome> => {
        executeCalls += 1;
        return Promise.resolve({ status: 'completed' });
      },
      { transcriptPort: port },
    );
    const pending = runner.start(streamingRequest(controller), () =>
      Promise.resolve(),
    );

    await expect(
      runner.start(streamingRequest(new AbortController()), () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow(/invalid local delegation launch/i);
    controller.abort();
    releaseOpen?.();

    await expect(pending).rejects.toThrow(/abort|launch/i);
    expect(executeCalls).toBe(0);
  });

  it('keeps legacy emitted events unchanged when a port is injected without a marker', async () => {
    let openCalls = 0;
    let appendCalls = 0;
    const port = createTranscriptPort({
      open: ({ target: openedTarget }) => {
        openCalls += 1;
        return Promise.resolve({
          ok: true,
          value: {
            target: openedTarget,
            status: 'open',
            streamRevision: 0,
            openedAt: null,
            latestRowTimestamp: null,
          },
        });
      },
      appendChanges: (): ReturnType<
        DelegationTranscriptPort['appendChanges']
      > => {
        appendCalls += 1;
        return Promise.resolve({
          ok: false,
          error: {
            code: 'storage_failure',
            message: 'The stream could not be appended.',
            retryable: false,
          },
        });
      },
    });
    const execute = async (
      context: LocalDelegationContext,
    ): Promise<LocalDelegationOutcome> => {
      expect(typeof context.appendChildChanges).toBe('undefined');
      await context.emit({ type: 'started', nativeSessionId: 'native' });
      await context.emit({
        type: 'transcript',
        items: [
          {
            id: 'text',
            sequence: 1,
            occurredAt: 1,
            type: 'text',
            text: 'Legacy output',
          },
        ],
      });
      return { status: 'completed', finalText: 'Legacy answer' };
    };
    const baseline = await collectEvents(
      createRunner(execute),
      request(new AbortController()),
    );
    const withPort = await collectEvents(
      createRunner(execute, { transcriptPort: port }),
      request(new AbortController()),
    );

    expect(
      withPort.map(({ sequence, event }) => ({ sequence, event })),
    ).toEqual(baseline.map(({ sequence, event }) => ({ sequence, event })));
    expect(openCalls).toBe(0);
    expect(appendCalls).toBe(0);
  });

  it('queues admissions in order, snapshots their rows, and drains before terminal', async () => {
    const target = transcriptTarget();
    const appendInputs: Array<
      Parameters<DelegationTranscriptPort['appendChanges']>[0]
    > = [];
    let releaseFirst: (() => void) | undefined;
    const firstAdmission = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let enterReceipt: (() => void) | undefined;
    const receiptEntered = new Promise<void>((resolve) => {
      enterReceipt = resolve;
    });
    let releaseReceipt: (() => void) | undefined;
    const receiptGate = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    const port = createTranscriptPort({
      appendChanges: async (input) => {
        appendInputs.push(input);
        if (input.changes[0]?.row.id === 'first') await firstAdmission;
        return {
          ok: true,
          value: {
            target: input.target,
            mutationKey: input.mutationKey,
            streamRevision: appendInputs.length,
            items: input.changes.map(({ row }) => ({
              id: row.id,
              itemRevision: row.itemRevision,
              final: row.final,
            })),
            replayed: false,
          },
        };
      },
    });
    const settle = jest.spyOn(port, 'settle');
    const flush = jest.spyOn(port, 'flush');
    const events: AgentDelegationEvent[] = [];
    const runner = createRunner(
      (context): Promise<LocalDelegationOutcome> => {
        if (!context.appendChildChanges)
          throw new Error('Stream append callback is missing');
        const mutableChange = transcriptChange('first', 0);
        void context.appendChildChanges([mutableChange]);
        mutableChange.row.id = 'mutated-after-queue';
        void context.appendChildChanges([transcriptChange('second', 1)]);
        void context.appendChildChanges([transcriptChange('first', 0)]);
        return Promise.resolve({ status: 'completed', finalText: 'Done' });
      },
      { transcriptPort: port },
    );
    const handle = await runner.start(
      streamingRequest(new AbortController(), target),
      async (event) => {
        events.push(event);
        if (event.event.type === 'transcript_receipt' && events.length === 1) {
          enterReceipt?.();
          await receiptGate;
        }
      },
    );

    await Promise.resolve();
    expect(appendInputs.map((input) => input.changes[0]?.row.id)).toEqual([
      'first',
    ]);
    expect(events.some(({ event }) => event.type === 'terminal')).toBe(false);
    expect(appendInputs[0]?.mutationKey).toBe(
      '8e3b9308053fe6dc20b7279820e27ec9225316400c199a6f23382c8ec7941865',
    );

    releaseFirst?.();
    await receiptEntered;
    expect(events.some(({ event }) => event.type === 'terminal')).toBe(false);
    releaseReceipt?.();
    await runner.close(handle);

    expect(appendInputs.map((input) => input.changes[0]?.row.id)).toEqual([
      'first',
      'second',
      'first',
    ]);
    expect(appendInputs[0]?.mutationKey).toBe(appendInputs[2]?.mutationKey);
    expect(events.map(({ event }) => event.type)).toEqual([
      'transcript_receipt',
      'transcript_receipt',
      'transcript_receipt',
      'terminal',
    ]);
    // D4: completion drains appends but leaves open rows for broker settle.
    expect(
      appendInputs.flatMap(({ changes }) =>
        changes.map(({ row }) => row.final),
      ),
    ).toEqual([false, false, false]);
    expect(settle).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    expect(events[events.length - 1]?.event).toMatchObject({
      type: 'terminal',
      status: 'completed',
      finalText: 'Done',
    });
  });

  it('fails the run with a storage error when an unawaited admission is rejected', async () => {
    const port = createTranscriptPort({
      appendChanges: (): ReturnType<
        DelegationTranscriptPort['appendChanges']
      > =>
        Promise.resolve({
          ok: false,
          error: {
            code: 'storage_failure',
            message: 'Disk write failed.',
            retryable: true,
          },
        }),
    });
    const events: AgentDelegationEvent[] = [];
    const runner = createRunner(
      (context): Promise<LocalDelegationOutcome> => {
        if (!context.appendChildChanges)
          throw new Error('Stream append callback is missing');
        void context.appendChildChanges([transcriptChange('unpersisted', 0)]);
        return Promise.resolve({
          status: 'completed',
          finalText: 'Not durable',
        });
      },
      { transcriptPort: port },
    );
    const handle = await runner.start(
      streamingRequest(new AbortController()),
      (event) => {
        events.push(event);
        return Promise.resolve();
      },
    );

    await runner.close(handle);

    const terminal = events[events.length - 1]?.event;
    if (terminal?.type !== 'terminal')
      throw new Error('Missing terminal failure event');
    expect(terminal.status).toBe('failed');
    expect(terminal.error?.code).toBe('runtime_error');
    expect(terminal.error?.message).toMatch(/transcript|storage/i);
    expect(
      events.some(({ event }) => event.type === 'transcript_receipt'),
    ).toBe(false);
  });

  it('forwards each successful admission receipt in order before terminal, including replays', async () => {
    const admissions: string[] = [];
    const port = createTranscriptPort({
      appendChanges: async (input) => {
        await Promise.resolve();
        const admission = admissions.length + 1;
        admissions.push(input.changes[0]?.row.id ?? 'empty');
        return {
          ok: true,
          value: {
            target: input.target,
            mutationKey: input.mutationKey,
            streamRevision: admission === 3 ? 2 : admission,
            items: input.changes.map(({ row }) => ({
              id: row.id,
              itemRevision: row.itemRevision,
              final: row.final,
            })),
            replayed: admission === 3,
          },
        };
      },
    });
    const events: AgentDelegationEvent[] = [];
    const runner = createRunner(
      (context): Promise<LocalDelegationOutcome> => {
        if (!context.appendChildChanges)
          throw new Error('Stream append callback is missing');
        void context.appendChildChanges([transcriptChange('first', 0)]);
        void context.appendChildChanges([transcriptChange('second', 1)]);
        void context.appendChildChanges([transcriptChange('first', 0)]);
        return Promise.resolve({ status: 'completed', finalText: 'Done' });
      },
      { transcriptPort: port },
    );
    const handle = await runner.start(
      streamingRequest(new AbortController()),
      (event) => {
        events.push(event);
        return Promise.resolve();
      },
    );

    await runner.close(handle);

    const receipts = events.filter(
      (event) => event.event.type === 'transcript_receipt',
    );
    expect(admissions).toEqual(['first', 'second', 'first']);
    expect(receipts).toHaveLength(3);
    const receiptEvents = receipts.map(({ event }) => event);
    expect(
      receiptEvents.map((event) =>
        event.type === 'transcript_receipt' ? event.streamRevision : 0,
      ),
    ).toEqual([1, 2, 2]);
    expect(
      receiptEvents.map((event) =>
        event.type === 'transcript_receipt' ? event.replayed : false,
      ),
    ).toEqual([false, false, true]);
    expect(
      receiptEvents.map((event) =>
        event.type === 'transcript_receipt'
          ? event.items[0]
          : { id: '', itemRevision: -1, final: false },
      ),
    ).toEqual([
      { id: 'first', itemRevision: 0, final: false },
      { id: 'second', itemRevision: 1, final: false },
      { id: 'first', itemRevision: 0, final: false },
    ]);
    expect(events.map(({ event }) => event.type)).toEqual([
      'transcript_receipt',
      'transcript_receipt',
      'transcript_receipt',
      'terminal',
    ]);
    const firstReceipt = receiptEvents[0];
    const replayReceipt = receiptEvents[2];
    expect(
      firstReceipt?.type === 'transcript_receipt' &&
        replayReceipt?.type === 'transcript_receipt' &&
        firstReceipt.mutationKey === replayReceipt.mutationKey,
    ).toBe(true);
  });

  it('drops an over-cap stream preview without throwing or corrupting the next accepted preview', async () => {
    const oversizedItems: AgentDelegationTranscriptItem[] = [];
    for (let index = 0; index < 65_537; index += 1)
      oversizedItems.push({
        id: `item-${index}`,
        sequence: index + 1,
        occurredAt: index,
        type: 'text',
        text: 'x',
      });
    const acceptedItem: AgentDelegationTranscriptItem = {
      id: 'accepted',
      sequence: 1,
      occurredAt: 1,
      type: 'text',
      text: 'Accepted preview',
    };
    const laterItem: AgentDelegationTranscriptItem = {
      id: 'later',
      sequence: 2,
      occurredAt: 2,
      type: 'text',
      text: 'Later preview',
    };
    const events: AgentDelegationEvent[] = [];
    const runner = createRunner(
      async (context): Promise<LocalDelegationOutcome> => {
        const streamItems = oversizedItems;
        if (!context.appendChildChanges)
          throw new Error('Stream append callback is missing');
        await context.emit({
          type: 'transcript',
          items: [acceptedItem],
        });
        await expect(
          context.emit({ type: 'transcript', items: streamItems }),
        ).resolves.toBeUndefined();
        await context.emit({
          type: 'transcript',
          items: [acceptedItem, laterItem],
        });
        return { status: 'completed' };
      },
      { transcriptPort: createTranscriptPort() },
    );
    const handle = await runner.start(
      streamingRequest(new AbortController()),
      (event) => {
        events.push(event);
        return Promise.resolve();
      },
    );

    await runner.close(handle);

    const transcripts = events
      .map(({ event }) => event)
      .filter((event) => event.type === 'transcript');
    expect(transcripts).toHaveLength(2);
    const acceptedId = transcripts[0]?.items[0]?.id;
    expect(acceptedId).toMatch(/^turn0:/);
    expect(transcripts[1]?.items[0]?.id).toBe(acceptedId);
    const laterPreview = transcripts[1]?.items[1];
    if (laterPreview?.type !== 'text') {
      throw new Error('Expected the bounded transcript preview as text');
    }
    expect(laterPreview.text).toBe('Later preview');
    expect(events[events.length - 1]?.event).toMatchObject({
      type: 'terminal',
      status: 'completed',
    });
  });

  it('keeps throwing for an over-cap legacy transcript', async () => {
    const oversizedItems: AgentDelegationTranscriptItem[] = [];
    for (let index = 0; index < 65_537; index += 1)
      oversizedItems.push({
        id: `item-${index}`,
        sequence: index + 1,
        occurredAt: index,
        type: 'text',
        text: 'x',
      });
    const runner = createRunner(async (context) => {
      let rejected = false;
      try {
        await context.emit({ type: 'transcript', items: oversizedItems });
      } catch (error) {
        rejected = true;
        if (!(error instanceof Error))
          throw new Error('Expected a legacy transcript cap error');
        expect(error.message).toMatch(/retention limits/i);
      }
      expect(rejected).toBe(true);
      return { status: 'completed' };
    });

    const events = await collectEvents(runner, request(new AbortController()));

    expect(events[events.length - 1]?.event).toMatchObject({
      type: 'terminal',
      status: 'completed',
    });
  });

  it('bounds and de-truncates stream previews without changing legacy truncation fields', async () => {
    const progressText = `${'é'.repeat(32_768)}x`;
    const expectedStreamText = `${'é'.repeat(32_767)}x`;
    const events: AgentDelegationEvent[] = [];
    const runner = createRunner(
      async (context): Promise<LocalDelegationOutcome> => {
        await context.emit({
          type: 'progress',
          text: progressText,
          truncated: true,
        });
        await context.emit({
          type: 'transcript',
          items: [
            {
              id: 'preview',
              sequence: 1,
              occurredAt: 1,
              type: 'text',
              text: 'Preview',
            },
          ],
          truncated: true,
        });
        return { status: 'completed' };
      },
      { transcriptPort: createTranscriptPort() },
    );
    const handle = await runner.start(
      streamingRequest(new AbortController()),
      (event) => {
        events.push(event);
        return Promise.resolve();
      },
    );

    await runner.close(handle);

    const progress = events.find(({ event }) => event.type === 'progress');
    const transcript = events.find(({ event }) => event.type === 'transcript');
    expect(
      progress?.event.type === 'progress' &&
        progress.event.text === expectedStreamText,
    ).toBe(true);
    expect(
      progress?.event.type === 'progress'
        ? Buffer.byteLength(progress.event.text, 'utf8')
        : Number.POSITIVE_INFINITY,
    ).toBeLessThanOrEqual(65_536);
    expect(progress?.event).toHaveProperty('truncated', false);
    expect(transcript?.event).toHaveProperty('truncated', false);

    const legacyEvents = await collectEvents(
      createRunner(async (context) => {
        await context.emit({
          type: 'progress',
          text: progressText,
          truncated: true,
        });
        await context.emit({
          type: 'transcript',
          items: [
            {
              id: 'legacy-preview',
              sequence: 1,
              occurredAt: 1,
              type: 'text',
              text: 'Legacy preview',
            },
          ],
          truncated: true,
        });
        return { status: 'completed' };
      }),
      request(new AbortController()),
    );
    expect(
      legacyEvents.find(({ event }) => event.type === 'progress')?.event,
    ).toEqual({ type: 'progress', text: progressText, truncated: true });
    expect(
      legacyEvents.find(({ event }) => event.type === 'transcript')?.event,
    ).toHaveProperty('truncated', true);
  });

  it('drains transcript admissions scheduled during cleanup before terminal', async () => {
    let releaseAdmission: (() => void) | undefined;
    let markAdmissionStarted: (() => void) | undefined;
    const admissionGate = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const admissionStarted = new Promise<void>((resolve) => {
      markAdmissionStarted = resolve;
    });
    const port = createTranscriptPort({
      appendChanges: async (input) => {
        markAdmissionStarted?.();
        await admissionGate;
        return {
          ok: true,
          value: {
            target: input.target,
            mutationKey: input.mutationKey,
            streamRevision: 1,
            items: input.changes.map(({ row }) => ({
              id: row.id,
              itemRevision: row.itemRevision,
              final: row.final,
            })),
            replayed: false,
          },
        };
      },
    });
    const events: AgentDelegationEvent[] = [];
    const runner = createRunner(
      (context): Promise<LocalDelegationOutcome> => {
        const appendChildChanges = context.appendChildChanges;
        if (!appendChildChanges)
          throw new Error('Stream append callback is missing');
        context.retain(() => {
          void appendChildChanges([transcriptChange('cleanup', 0)]);
          return Promise.resolve();
        });
        return Promise.resolve({ status: 'completed' });
      },
      { transcriptPort: port },
    );
    const handle = await runner.start(
      streamingRequest(new AbortController()),
      (event) => {
        events.push(event);
        return Promise.resolve();
      },
    );

    await admissionStarted;
    expect(events.some(({ event }) => event.type === 'terminal')).toBe(false);
    releaseAdmission?.();
    await runner.close(handle);

    expect(events[events.length - 1]?.event).toMatchObject({
      type: 'terminal',
      status: 'completed',
    });
  });

  it('admits final rows written after a stop and keeps the stop attribution', async () => {
    const admitted: string[] = [];
    const port = createTranscriptPort({
      appendChanges: (input, signal) => {
        if (signal?.aborted)
          return Promise.resolve({
            ok: false,
            error: {
              code: 'storage_failure',
              message: 'Aborted admission.',
              retryable: true,
            },
          });
        admitted.push(...input.changes.map(({ row }) => row.id));
        return Promise.resolve({
          ok: true,
          value: {
            target: input.target,
            mutationKey: input.mutationKey,
            streamRevision: admitted.length,
            items: input.changes.map(({ row }) => ({
              id: row.id,
              itemRevision: row.itemRevision,
              final: row.final,
            })),
            replayed: false,
          },
        });
      },
    });
    const events: AgentDelegationEvent[] = [];
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runner = createRunner(
      async (context): Promise<LocalDelegationOutcome> => {
        if (!context.appendChildChanges)
          throw new Error('Stream append callback is missing');
        markStarted?.();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        await context.appendChildChanges([transcriptChange('final', 0)]);
        return { status: 'completed' };
      },
      { transcriptPort: port },
    );
    const handle = await runner.start(
      streamingRequest(new AbortController()),
      (event) => {
        events.push(event);
        return Promise.resolve();
      },
    );
    await started;
    await runner.stop(handle, 'deadline_exceeded');
    await runner.close(handle);

    expect(admitted).toEqual(['final']);
    expect(events[events.length - 1]?.event).toMatchObject({
      type: 'terminal',
      status: 'deadline_exceeded',
    });
  });

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

  it('lets steering before the run binds its handler fall back to an ordinary follow-up', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runner = new LocalDelegationRunner(
      'claude',
      'sdk',
      () => Promise.resolve({ available: true }),
      async () => {
        // Still starting: no steering handler is bound yet.
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
        attemptId: 'steer-early',
        message: 'A child finished.',
      }),
    ).resolves.toMatchObject({
      kind: 'rejected',
      attemptId: 'steer-early',
      fallback: 'ordinary',
    });
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

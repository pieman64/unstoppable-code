import type { AgentDelegationEvent } from '@canopy/protocol/delegation';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import {
  baseTask,
  createBrokerHarness,
  MemoryDelegationStorage,
  rootParent,
  waitForLaunch,
} from './broker-harness';
import { routeFixture } from './fixtures';

async function setup(): Promise<
  ReturnType<typeof createBrokerHarness> & {
    port: InMemoryDelegationTranscriptPort;
    notices: unknown[];
    id: string;
    emit: (
      event: AgentDelegationEvent['event'],
      generation?: number,
      sequence?: number,
    ) => Promise<void>;
  }
> {
  const port = new InMemoryDelegationTranscriptPort({
    owns: (): boolean => true,
    ownsChat: (): boolean => true,
  });
  const storage = new MemoryDelegationStorage();
  const notices: unknown[] = [];
  const trusted = { testOnlyStreamGeneration: true };
  const harness = createBrokerHarness(
    {
      ...trusted,
      transcriptPort: port,
      resolveRoute: () =>
        Promise.resolve({
          ok: true,
          value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
        }),
      onSettled: (_parent, _id, result) => {
        notices.push(result);
        return Promise.resolve();
      },
    },
    storage,
  );
  await harness.broker.initialize();
  const spawned = await harness.broker.spawn(rootParent, baseTask);
  if (!spawned.ok) throw new Error('Expected admission');
  const id = spawned.value.delegationId;
  await waitForLaunch(harness.runner, id);
  const emit = (
    event: AgentDelegationEvent['event'],
    generation = 1,
    sequence = 1,
  ): Promise<void> => {
    const sink = harness.runner.sinks.get(id);
    if (!sink) throw new Error('Expected sink');
    return sink({
      delegationId: id,
      runGeneration: generation,
      sequence,
      occurredAt: 200,
      event,
    });
  };
  return { ...harness, port, notices, id, emit };
}

describe('registry-backed output and watch bootstrap', () => {
  afterEach(() => jest.restoreAllMocks());

  it('joins validated answer pages and keeps watch generations pinned after rotation', async () => {
    const f = await setup();
    const answer = `${'x'.repeat(40_000)}🌿\uD800${'y'.repeat(40_000)}`;
    await f.emit({ type: 'started', nativeSessionId: 'retained' }, 1, 1);
    await f.emit(
      { type: 'terminal', status: 'completed', finalText: answer },
      1,
      2,
    );
    const body = jest.spyOn(f.port, 'resultAnswerRange');
    expect(
      await f.broker.getOutput(rootParent, { delegationId: f.id }),
    ).toMatchObject({ ok: true, value: { result: { finalText: answer } } });
    expect(body.mock.calls.length).toBeGreaterThan(1);
    body.mockClear();
    expect(
      (
        await f.broker.message(
          { ...rootParent, toolCallId: 'rotate-watch' },
          { delegationId: f.id, operation: 'follow_up', message: 'continue' },
        )
      ).ok,
    ).toBe(true);
    for (
      let attempt = 0;
      attempt < 200 &&
      !f.runner.starts.some((start) => start.runGeneration === 2);
      attempt++
    )
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      await f.broker.watchTargetStates([
        { delegationId: f.id, runGeneration: 1 },
      ]),
    ).toMatchObject([
      { runGeneration: 1, status: 'completed', resultIndex: 1 },
    ]);
    expect(
      await f.broker.watchTargetStates([
        { delegationId: f.id, runGeneration: 2 },
      ]),
    ).toMatchObject([{ runGeneration: 2, status: 'pending' }]);
    expect(body).not.toHaveBeenCalled();
    await f.broker.close();
  });

  it.each(['not_found', 'storage_failure', 'corruption'] as const)(
    'maps an answer read %s through the canonical mapper',
    async (code) => {
      const f = await setup();
      await f.emit({
        type: 'terminal',
        status: 'completed',
        finalText: 'answer',
      });
      jest.spyOn(f.port, 'resultAnswerRange').mockResolvedValue({
        ok: false,
        error: { code, message: 'unavailable body', retryable: false },
      });
      expect(
        await f.broker.getOutput(rootParent, { delegationId: f.id }),
      ).toMatchObject({
        ok: true,
        value: {
          result: {
            resultIndex: 1,
            status: 'completed',
            contentError: { code },
          },
        },
      });
      expect(
        await f.broker.getOutput(rootParent, {
          delegationId: f.id,
          offset: 0,
          limit: 8,
        }),
      ).toMatchObject({
        ok: true,
        value: { result: { resultIndex: 1, contentError: { code } } },
      });
      await f.broker.close();
    },
  );

  it('pins output metadata before an awaited read and resolves old indexes from the registry', async () => {
    const f = await setup();
    await f.emit({ type: 'started', nativeSessionId: 'retained' }, 1, 1);
    await f.emit(
      { type: 'terminal', status: 'completed', finalText: '🌿\uD800xyz' },
      1,
      2,
    );
    const read = f.port.result.bind(f.port);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(f.port, 'result').mockImplementationOnce(async (input) => {
      const result = await read(input);
      await gate;
      return result;
    });
    const pending = f.broker.getOutput(rootParent, { delegationId: f.id });
    expect(
      (
        await f.broker.message(
          { ...rootParent, toolCallId: 'continue' },
          { delegationId: f.id, operation: 'follow_up', message: 'continue' },
        )
      ).ok,
    ).toBe(true);
    for (
      let attempt = 0;
      attempt < 200 &&
      !f.runner.starts.some((start) => start.runGeneration === 2);
      attempt++
    )
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.broker.inspect(rootParent, f.id)?.runGeneration).toBe(2);
    release();
    expect(await pending).toMatchObject({
      ok: true,
      value: {
        currentRunGeneration: 1,
        currentStatus: 'completed',
        latestResultIndex: 1,
        result: { finalText: '🌿\uD800xyz' },
      },
    });
    const page = await f.broker.getOutput(rootParent, {
      delegationId: f.id,
      resultIndex: 1,
      offset: 0,
      limit: 4,
    });
    expect(page).toMatchObject({
      ok: true,
      value: {
        currentRunGeneration: 2,
        result: {
          resultIndex: 1,
          answer: { text: '🌿', encoding: 'utf16le', nextOffset: 4 },
        },
      },
    });
    await f.broker.close();
  });

  it('uses a known latest locator on lookup failure and never borrows it for another index', async () => {
    const f = await setup();
    await f.emit({
      type: 'terminal',
      status: 'completed',
      finalText: 'answer',
    });
    jest.spyOn(f.port, 'result').mockResolvedValue({
      ok: false,
      error: { code: 'storage_failure', message: 'offline', retryable: true },
    });
    expect(
      await f.broker.getOutput(rootParent, { delegationId: f.id }),
    ).toMatchObject({
      ok: true,
      value: {
        result: {
          resultIndex: 1,
          status: 'completed',
          contentError: { code: 'storage_failure' },
        },
      },
    });
    expect(
      await f.broker.getOutput(rootParent, {
        delegationId: f.id,
        resultIndex: 2,
      }),
    ).toMatchObject({ ok: false, error: { code: 'runtime_error' } });
    await f.broker.close();
  });

  it.each([undefined, ''])(
    'does no answer-range read for terminal answer %p',
    async (answer) => {
      const f = await setup();
      const body = jest.spyOn(f.port, 'resultAnswerRange');
      await f.emit({
        type: 'terminal',
        status: 'completed',
        ...(answer === undefined ? {} : { finalText: answer }),
      });
      const result = await f.broker.getOutput(rootParent, {
        delegationId: f.id,
      });
      expect(result).toMatchObject({
        ok: true,
        value: { result: { resultIndex: 1, status: 'completed' } },
      });
      if (result.ok) expect(result.value.result?.finalText).toBe(answer);
      expect(body).not.toHaveBeenCalled();
      await f.broker.close();
    },
  );

  it('bootstraps a registry-only result without reading any bodies', async () => {
    const f = await setup();
    const body = jest.spyOn(f.port, 'resultAnswerRange');
    const message = jest.spyOn(f.port, 'message');
    const final = f.port.settle.bind(f.port);
    jest.spyOn(f.port, 'settle').mockImplementationOnce(async (input) => {
      await final(input);
      throw new Error('late locator');
    });
    await expect(
      f.emit({ type: 'terminal', status: 'completed', finalText: 'answer' }),
    ).rejects.toThrow('Settlement pending');
    expect(
      await f.broker.watchTargetStates([
        { delegationId: f.id, runGeneration: 1 },
      ]),
    ).toMatchObject([
      { runGeneration: 1, status: 'completed', resultIndex: 1 },
    ]);
    expect(body).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
    await f.broker.close();
  });

  it('never bootstraps a false completion while canonical settlement is unavailable', async () => {
    const f = await setup();
    const settle = jest.spyOn(f.port, 'settle').mockResolvedValue({
      ok: false,
      error: { code: 'storage_failure', message: 'offline', retryable: true },
    });
    await expect(
      f.emit({ type: 'terminal', status: 'completed', finalText: 'answer' }),
    ).rejects.toThrow('Settlement pending');
    await expect(
      f.broker.watchTargetStates([{ delegationId: f.id, runGeneration: 1 }]),
    ).rejects.toThrow();
    settle.mockRestore();
    await f.broker.close();
  });
});

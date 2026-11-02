import type {
  AgentDelegationEvent,
  AgentDelegationSpawnRequest,
  GetDelegateOutputValue,
  AgentDelegationResult,
} from '@canopy/protocol/delegation';
import { AgentDelegationBroker, type StoredDelegation } from '../broker';
import { DevelopmentDelegationBroker } from '../development-broker';
import { AgentRunnerRegistry } from '../runner-registry';
import { createDelegationProjection } from '../projections';
import { FakeRunner, routeFixture } from './fixtures';
import type { DelegationParentContext } from '../types';

const parent: DelegationParentContext = {
  harnessId: 'claude',
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
  sessionKey: 'session',
  turnId: 'turn',
  toolCallId: 'tool',
  runtimeGeneration: 1,
  depth: 0,
};
const task: AgentDelegationSpawnRequest = {
  modelId: 'logical-review-model',
  description: 'Read',
  prompt: 'Read the fixed answer.',
  executionMode: 'background',
  contextPolicy: 'task_only',
  isolation: 'shared_worktree',
};
function value(
  result: AgentDelegationResult<GetDelegateOutputValue>,
): GetDelegateOutputValue {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function fixture(capacity = 2): Promise<{
  broker: AgentDelegationBroker;
  runner: FakeRunner;
  records: Map<string, StoredDelegation>;
  id: string;
  emit: (
    event: AgentDelegationEvent['event'],
    runGeneration?: number,
  ) => Promise<void>;
}> {
  const records = new Map<string, StoredDelegation>();
  const runner = new FakeRunner('local-sdk');
  const registry = new AgentRunnerRegistry();
  registry.register({
    apiVersion: 1,
    registrationId: 'third-local',
    adapter: runner,
  });
  const broker = new AgentDelegationBroker({
    registry,
    capacity,
    cwd: '/test/worktree',
    storage: {
      load: (): Promise<readonly StoredDelegation[]> => Promise.resolve([]),
      commit: (record): Promise<void> => {
        records.set(record.state.delegationId, structuredClone(record));
        return Promise.resolve();
      },
    },
    resolveRoute: (): Promise<
      AgentDelegationResult<ReturnType<typeof routeFixture>>
    > =>
      Promise.resolve({
        ok: true,
        value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
      }),
    authorize: (): Promise<AgentDelegationResult<undefined>> =>
      Promise.resolve({ ok: true, value: undefined }),
  });
  await broker.initialize();
  const spawned = await broker.spawn(parent, task);
  if (!spawned.ok) throw new Error(spawned.error.message);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const id = spawned.value.delegationId;
  const sink = runner.sinks.get(id);
  if (!sink) throw new Error('Missing sink');
  let sequence = 0;
  const emit = (
    event: AgentDelegationEvent['event'],
    runGeneration = 1,
  ): Promise<void> =>
    sink({
      delegationId: id,
      runGeneration,
      sequence: ++sequence,
      occurredAt: sequence * 10,
      event,
    });
  return { broker, runner, records, id, emit };
}

it('returns a character-boundary byte range through the real broker', async () => {
  const f = await fixture();
  try {
    await f.emit({ type: 'terminal', status: 'completed', finalText: 'a😀bc' });
    expect(
      value(
        await f.broker.getOutput(parent, {
          delegationId: f.id,
          offset: 0,
          limit: 5,
        }),
      ).result,
    ).toEqual({
      resultIndex: 1,
      runGeneration: 1,
      status: 'completed',
      outputTruncated: false,
      answer: {
        role: 'final',
        text: 'a😀',
        encoding: 'utf8',
        byteLength: 7,
        offset: 0,
        nextOffset: 5,
        notice:
          'The answer continues. Call Get Delegate Output again with this resultIndex and offset set to nextOffset.',
      },
    });
  } finally {
    await f.broker.close();
  }
});

it('accepts a ranged request through the real broker projection', async () => {
  const f = await fixture();
  try {
    await f.emit({
      type: 'terminal',
      status: 'completed',
      finalText: 'abcdef',
    });
    const projection = createDelegationProjection('claude', 'test', f.broker);
    expect(
      await projection.invoke(parent, 'test_get_delegate_output', {
        delegationId: f.id,
        offset: 0,
        limit: 4,
      }),
    ).toMatchObject({
      ok: true,
      value: { result: { answer: { text: 'abcd' } } },
    });
  } finally {
    await f.broker.close();
  }
});

it('keeps non-Codex whole text byte-equal and does no page work', async () => {
  const f = await fixture();
  try {
    const text = 'x'.repeat(1024 * 1024);
    await f.emit({ type: 'terminal', status: 'completed', finalText: text });
    const pageModule = await import('../output-page');
    // The shared page helper is reached only by ranged broker reads.
    const page = jest.spyOn(pageModule, 'projectLegacyDelegateOutput');
    const projection = createDelegationProjection('claude', 'test', f.broker);
    const reply = await projection.invoke(parent, 'test_get_delegate_output', {
      delegationId: f.id,
    });
    expect(reply).toEqual(
      await f.broker.getOutput(parent, { delegationId: f.id }),
    );
    expect(JSON.stringify(reply)).toContain(text);
    const storedRecord = f.records.get(f.id);
    if (storedRecord?.version === 3) throw new Error();
    const storedText = storedRecord?.results?.[0]?.finalText;
    expect(storedText).toBe(text);
    expect(
      Buffer.from(
        value(await f.broker.getOutput(parent, { delegationId: f.id })).result
          ?.finalText ?? '',
        'utf8',
      ),
    ).toEqual(Buffer.from(storedText ?? '', 'utf8'));
    expect(page).not.toHaveBeenCalled();
  } finally {
    jest.restoreAllMocks();
    await f.broker.close();
  }
});
it('detaches nested error and usage on whole and range reads', async () => {
  const f = await fixture();
  try {
    await f.emit({
      type: 'terminal',
      status: 'failed',
      finalText: 'failure body',
      error: {
        code: 'runtime_error',
        message: 'Safe execution failure.',
        retryable: false,
      },
      usage: { inputTokens: 17, outputTokens: 5 },
    });
    for (const fields of [{}, { offset: 0, limit: 4 }]) {
      const first = value(
        await f.broker.getOutput(parent, { delegationId: f.id, ...fields }),
      );
      if (!first.result?.error || !first.result.usage)
        throw new Error('Missing nested metadata');
      Object.defineProperty(first.result.error, 'message', {
        value: 'caller mutation',
      });
      Object.defineProperty(first.result.usage, 'inputTokens', { value: 999 });
      const next = value(
        await f.broker.getOutput(parent, { delegationId: f.id, ...fields }),
      );
      expect(next.result).toMatchObject({
        error: {
          code: 'runtime_error',
          message: 'Safe execution failure.',
          retryable: false,
        },
        usage: { inputTokens: 17, outputTokens: 5 },
      });
    }
  } finally {
    await f.broker.close();
  }
});
it('keeps a continuation pinned when a newer result settles', async () => {
  const f = await fixture();
  try {
    await f.emit({ type: 'started', nativeSessionId: 'session-1' });
    await f.emit({
      type: 'terminal',
      status: 'completed',
      finalText: 'old-abcdef',
    });
    const first = value(
      await f.broker.getOutput(parent, {
        delegationId: f.id,
        offset: 0,
        limit: 4,
      }),
    );
    expect(first.result?.answer?.text).toBe('old-');
    const followed = await f.broker.message(
      { ...parent, toolCallId: 'follow', turnId: 'turn-2' },
      { delegationId: f.id, operation: 'follow_up', message: 'new result' },
    );
    if (!followed.ok) throw new Error(followed.error.message);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const sink = f.runner.sinks.get(f.id);
    if (!sink) throw new Error('Missing followup sink');
    await sink({
      delegationId: f.id,
      runGeneration: 2,
      sequence: 1,
      occurredAt: 30,
      event: { type: 'terminal', status: 'completed', finalText: 'NEW BODY' },
    });
    expect(
      value(
        await f.broker.getOutput(parent, {
          delegationId: f.id,
          resultIndex: 1,
          offset: 4,
          limit: 65_536,
        }),
      ),
    ).toMatchObject({
      latestResultIndex: 2,
      result: { resultIndex: 1, answer: { text: 'abcdef', offset: 4 } },
    });
    expect(
      await f.broker.getOutput(parent, {
        delegationId: f.id,
        resultIndex: 3,
        offset: 0,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'Result index is not available.',
        retryable: false,
      },
    });
  } finally {
    await f.broker.close();
  }
});
it('serializes queued phase and queue position without changing the legacy shape', async () => {
  const f = await fixture(1);
  try {
    const queued = await f.broker.spawn(
      { ...parent, toolCallId: 'queued' },
      task,
    );
    if (!queued.ok) throw new Error(queued.error.message);
    const projection = createDelegationProjection('claude', 'test', f.broker);
    const reply = await projection.invoke(parent, 'test_get_delegate_output', {
      delegationId: queued.value.delegationId,
    });
    expect(JSON.stringify(reply)).toBe(
      `{"ok":true,"value":{"delegationId":"${queued.value.delegationId}","currentRunGeneration":1,"currentStatus":"pending","latestResultIndex":null,"result":null,"currentPhase":"queued","queue":{"id":"default","name":"Default","running":1,"waiting":1,"limit":1,"position":1,"waitingFor":"queue"}}}`,
    );
  } finally {
    await f.broker.close();
  }
});
it('keeps DevelopmentDelegationBroker no-range output unchanged and supports ranges', async () => {
  const broker = new DevelopmentDelegationBroker({
    mode: 'development-probe',
    resolveRoute: (): Promise<
      AgentDelegationResult<ReturnType<typeof routeFixture>>
    > => Promise.resolve({ ok: true, value: routeFixture() }),
  });
  try {
    const spawned = await broker.spawn(parent, task);
    if (!spawned.ok) throw new Error(spawned.error.message);
    broker.finish(
      spawned.value.delegationId,
      'completed',
      'Development answer',
    );
    const projection = createDelegationProjection('claude', 'test', broker);
    expect(
      JSON.stringify(
        await projection.invoke(parent, 'test_get_delegate_output', {
          delegationId: spawned.value.delegationId,
        }),
      ),
    ).toBe(
      `{"ok":true,"value":{"delegationId":"${spawned.value.delegationId}","currentRunGeneration":1,"currentStatus":"completed","latestResultIndex":1,"result":{"resultIndex":1,"runGeneration":1,"status":"completed","finalText":"Development answer","outputTruncated":false}}}`,
    );
    expect(
      value(
        await broker.getOutput(parent, {
          delegationId: spawned.value.delegationId,
          limit: 4,
        }),
      ).result?.answer?.text,
    ).toBe('Deve');
  } finally {
    broker.close();
  }
});

it.each([false, true])(
  'keeps real-broker Codex fit pinned while a newer generation settles inside invoke (historical=%s)',
  async (historical) => {
    const f = await fixture();
    try {
      await f.emit({ type: 'started', nativeSessionId: 'native-history' });
      await f.emit({
        type: 'terminal',
        status: 'completed',
        finalText: 'o'.repeat(1024 * 1024),
      });
      const settleNext = async (generation: number): Promise<void> => {
        const followed = await f.broker.message(
          {
            ...parent,
            turnId: `turn-${generation}`,
            toolCallId: `follow-${generation}`,
          },
          { delegationId: f.id, operation: 'follow_up', message: 'New result' },
        );
        if (!followed.ok) throw new Error(followed.error.message);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const sink = f.runner.sinks.get(f.id);
        if (!sink) throw new Error('Missing current sink');
        await sink({
          delegationId: f.id,
          runGeneration: generation,
          sequence: 1,
          occurredAt: 100,
          event: { type: 'started', nativeSessionId: 'native-history' },
        });
        await sink({
          delegationId: f.id,
          runGeneration: generation,
          sequence: 2,
          occurredAt: 110,
          event: {
            type: 'terminal',
            status: 'completed',
            finalText: 'NEW RESULT',
          },
        });
      };
      if (historical) await settleNext(2);
      const original = f.broker.getOutput.bind(f.broker);
      let firstRead = true;
      const reads = jest
        .spyOn(f.broker, 'getOutput')
        .mockImplementation(async (context, request) => {
          const reply = await original(context, request);
          if (firstRead) {
            firstRead = false;
            await settleNext(historical ? 3 : 2);
          }
          return reply;
        });
      const projection = createDelegationProjection('codex', 'test', f.broker);
      expect(
        await projection.invoke(parent, 'test_get_delegate_output', {
          delegationId: f.id,
          ...(historical ? { resultIndex: 1 } : {}),
        }),
      ).toMatchObject({
        ok: true,
        value: {
          latestResultIndex: historical ? 3 : 2,
          result: { resultIndex: 1, answer: { byteLength: 1024 * 1024 } },
        },
      });
      expect(reads).toHaveBeenCalledTimes(2);
      expect(reads).toHaveBeenLastCalledWith(parent, {
        delegationId: f.id,
        resultIndex: 1,
        offset: 0,
        limit: 65_536,
      });
    } finally {
      jest.restoreAllMocks();
      await f.broker.close();
    }
  },
);

it('keeps an unsettled delegation result null even for a ranged request', async () => {
  const f = await fixture();
  try {
    const whole = await f.broker.getOutput(parent, { delegationId: f.id });
    expect(
      await createDelegationProjection('claude', 'test', f.broker).invoke(
        parent,
        'test_get_delegate_output',
        { delegationId: f.id, offset: 0, limit: 4 },
      ),
    ).toEqual(whole);
    expect(value(whole).result).toBeNull();
  } finally {
    await f.broker.close();
  }
});

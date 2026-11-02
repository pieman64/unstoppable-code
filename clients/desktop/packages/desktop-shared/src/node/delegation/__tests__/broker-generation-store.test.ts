import { delegationBlockId } from '@canopy/agent-transcript';
import type { AgentDelegationTranscript } from '@canopy/protocol/delegation';
import { routeFixture, type FakeRunner } from './fixtures';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import {
  baseTask,
  createBrokerHarness,
  MemoryDelegationStorage,
  rootParent,
  waitForLaunch,
  flushBroker,
} from './broker-harness';

function streamPort(): InMemoryDelegationTranscriptPort {
  return new InMemoryDelegationTranscriptPort({
    owns: (): boolean => true,
    ownsChat: (): boolean => true,
  });
}

async function settle(
  runner: FakeRunner,
  id: string,
  generation = 1,
): Promise<void> {
  const sink = runner.sinks.get(id);
  if (!sink) throw new Error('Missing runner sink');
  await sink({
    delegationId: id,
    runGeneration: generation,
    sequence: 1,
    occurredAt: 100,
    event: { type: 'started', nativeSessionId: 'native-retained' },
  });
  await sink({
    delegationId: id,
    runGeneration: generation,
    sequence: 2,
    occurredAt: 200,
    event: {
      type: 'terminal',
      status: 'completed',
      finalText: `answer ${generation}`,
    },
  });
  await flushBroker();
}

describe('generation store decision', () => {
  it.each([
    { asyncAdmission: false, executionMode: 'background' },
    { asyncAdmission: true, executionMode: 'background' },
    { asyncAdmission: false, executionMode: 'foreground' },
    { asyncAdmission: true, executionMode: 'foreground' },
  ] as const)(
    'selects stream before native launch ($executionMode, async $asyncAdmission)',
    async ({ asyncAdmission, executionMode }) => {
      const storage = new MemoryDelegationStorage();
      const cards: AgentDelegationTranscript[] = [];
      const generationStore = jest.fn(() => Promise.resolve('stream' as const));
      const { broker, runner } = createBrokerHarness(
        {
          ...{ generationStore },
          asyncAdmission,
          transcriptPort: streamPort(),
          onTranscript: (_parent, transcript) => {
            cards.push(transcript);
          },
        },
        storage,
      );
      await broker.initialize();
      try {
        const result = await broker.spawn(rootParent, {
          ...baseTask,
          executionMode,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const request = await waitForLaunch(runner, result.value.delegationId);
        expect(broker.recordStore(rootParent, result.value.delegationId)).toBe(
          'stream',
        );
        expect(generationStore).toHaveBeenCalledTimes(1);
        expect(request.transcriptStream?.target.runGeneration).toBe(1);
        expect(cards[0]).toMatchObject({
          transcriptStore: 'chat-stream-v2',
          runGeneration: 1,
        });
        const record = storage.records.get(result.value.delegationId);
        expect(record).toMatchObject({
          version: 3,
          registration: {
            store: 'stream',
            origin: {
              anchorMessageId: `delegated-agent-${result.value.delegationId}`,
            },
          },
        });
        expect(delegationBlockId(result.value.delegationId, 1)).toBe(
          `delegated-agent-${result.value.delegationId}`,
        );
      } finally {
        await broker.close();
      }
    },
  );

  it.each([false, true])(
    'refuses storage before start and releases identity/slot (async %s)',
    async (asyncAdmission) => {
      let ready = false;
      const generationStore = jest.fn(() =>
        Promise.resolve(
          ready
            ? ('stream' as const)
            : {
                kind: 'refused' as const,
                message: 'Delegation storage is not ready. Try again.',
              },
        ),
      );
      const { broker, runner } = createBrokerHarness({
        ...{ generationStore },
        asyncAdmission,
        capacity: 1,
        lifetimePolicy: () => ({
          kind: 'available',
          limit: 1,
          extension: 'none',
        }),
        transcriptPort: streamPort(),
      });
      await broker.initialize();
      try {
        const result = await broker.spawn(rootParent, baseTask);
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'runtime_error', retryable: true },
        });
        expect(runner.starts).toHaveLength(0);
        ready = true;
        const retried = await broker.spawn(
          { ...rootParent, toolCallId: 'retry-storage' },
          baseTask,
        );
        expect(retried.ok).toBe(true);
        if (retried.ok) await waitForLaunch(runner, retried.value.delegationId);
        expect(runner.starts).toHaveLength(1);
      } finally {
        await broker.close();
      }
    },
  );

  it('keeps option-off admissions and ordinary writes legacy', async () => {
    const storage = new MemoryDelegationStorage();
    let selected: 'legacy' | 'stream' = 'legacy';
    const generationStore = jest.fn(() => Promise.resolve(selected));
    const { broker, runner } = createBrokerHarness(
      { ...{ generationStore } },
      storage,
    );
    await broker.initialize();
    try {
      const result = await broker.spawn(rootParent, baseTask);
      if (!result.ok) throw new Error('Expected admission');
      const request = await waitForLaunch(runner, result.value.delegationId);
      expect(request.transcriptStream).toBeUndefined();
      selected = 'stream';
      await runner.sink?.({
        delegationId: result.value.delegationId,
        runGeneration: 1,
        sequence: 1,
        occurredAt: 100,
        event: { type: 'terminal', status: 'completed', finalText: 'done' },
      });
      expect(storage.records.get(result.value.delegationId)?.version).toBe(2);
      expect(generationStore).toHaveBeenCalledTimes(1);
    } finally {
      await broker.close();
    }
  });

  it.each([1, 2] as const)(
    'converts a v%s record only at its next stream generation',
    async (version) => {
      const storage = new MemoryDelegationStorage();
      const first = createBrokerHarness(
        {
          resolveRoute: () =>
            Promise.resolve({
              ok: true,
              value: routeFixture({ capabilities: ['read', 'resume'] }),
            }),
        },
        storage,
      );
      await first.broker.initialize();
      const initial = await first.broker.spawn(rootParent, baseTask);
      if (!initial.ok) throw new Error('Expected admission');
      const id = initial.value.delegationId;
      await waitForLaunch(first.runner, id);
      await settle(first.runner, id);
      await first.broker.close();
      const old = storage.records.get(id);
      if (!old || old.version === 3) throw new Error('Expected legacy record');
      storage.records.set(id, { ...old, version });
      const generationStore = jest.fn(() => Promise.resolve('stream' as const));
      const next = createBrokerHarness(
        {
          ...{ generationStore },
          transcriptPort: streamPort(),
          resolveRoute: () =>
            Promise.resolve({
              ok: true,
              value: routeFixture({ capabilities: ['read', 'resume'] }),
            }),
        },
        storage,
      );
      await next.broker.initialize();
      try {
        expect(next.runner.starts).toHaveLength(0);
        // An ordinary recovery write may normalize v1 to v2, never v3.
        expect(storage.records.get(id)?.version).toBe(2);
        const response = await next.broker.manage(
          { ...rootParent, toolCallId: 'generation-two' },
          {
            delegationId: id,
            operation: 'follow_up',
            message: 'Second generation prompt',
          },
        );
        expect(response.ok).toBe(true);
        await waitForLaunch(next.runner, id);
        // The follow-up text becomes the new generation's task, and its
        // identity is recorded as on an existing stream follow-up.
        expect(storage.records.get(id)).toMatchObject({
          version: 3,
          task: { prompt: 'Second generation prompt' },
          registration: {
            runGeneration: 2,
            origin: {
              kind: 'follow_up',
              anchorMessageId: `delegated-agent-${id}-run-2`,
            },
          },
          legacyPrefix: { results: [{ resultIndex: 1, runGeneration: 1 }] },
        });
        const converted = storage.records.get(id);
        expect(
          converted?.version === 3
            ? typeof converted.registration.origin.authoredItemId
            : undefined,
        ).toBe('string');
        expect(next.runner.starts).toHaveLength(1);
        expect(generationStore).toHaveBeenCalledTimes(1);
        expect(delegationBlockId(id, 2)).toBe(`delegated-agent-${id}-run-2`);
        await settle(next.runner, id, 2);
        expect(
          await next.broker.getOutput(rootParent, { delegationId: id }),
        ).toMatchObject({
          ok: true,
          value: { result: { resultIndex: 2, runGeneration: 2 } },
        });
      } finally {
        await next.broker.close();
      }
    },
  );

  it('freezes queued legacy selection across a later promotion', async () => {
    let promoted = false;
    const generationStore = jest.fn(() =>
      Promise.resolve(promoted ? ('stream' as const) : ('legacy' as const)),
    );
    const storage = new MemoryDelegationStorage();
    const { broker, runner } = createBrokerHarness(
      { ...{ generationStore }, capacity: 1, transcriptPort: streamPort() },
      storage,
    );
    await broker.initialize();
    try {
      const first = await broker.spawn(rootParent, baseTask);
      if (!first.ok) throw new Error('Expected first admission');
      await waitForLaunch(runner, first.value.delegationId);
      const queued = await broker.spawn(
        { ...rootParent, toolCallId: 'queued' },
        baseTask,
      );
      if (!queued.ok) throw new Error('Expected queued admission');
      expect(queued.value.phase).toBe('queued');
      promoted = true;
      await settle(runner, first.value.delegationId);
      const request = await waitForLaunch(runner, queued.value.delegationId);
      expect(request.transcriptStream).toBeUndefined();
      expect(storage.records.get(queued.value.delegationId)?.version).toBe(2);
      expect(generationStore).toHaveBeenCalledTimes(2);
    } finally {
      await broker.close();
    }
  });

  it('freezes a queued stream decision across later option disablement', async () => {
    let enabled = true;
    const generationStore = jest.fn(() =>
      Promise.resolve(enabled ? ('stream' as const) : ('legacy' as const)),
    );
    const storage = new MemoryDelegationStorage();
    const { broker, runner } = createBrokerHarness(
      { ...{ generationStore }, capacity: 1, transcriptPort: streamPort() },
      storage,
    );
    await broker.initialize();
    try {
      const first = await broker.spawn(rootParent, baseTask);
      if (!first.ok) throw new Error('Expected initial admission');
      await waitForLaunch(runner, first.value.delegationId);
      const queued = await broker.spawn(
        { ...rootParent, toolCallId: 'queued-stream' },
        baseTask,
      );
      if (!queued.ok) throw new Error('Expected queued stream admission');
      expect(queued.value.phase).toBe('queued');
      enabled = false;
      await settle(runner, first.value.delegationId);
      const request = await waitForLaunch(runner, queued.value.delegationId);
      expect(request.transcriptStream?.target.runGeneration).toBe(1);
      expect(storage.records.get(queued.value.delegationId)).toMatchObject({
        version: 3,
        registration: { store: 'stream' },
      });
      expect(generationStore).toHaveBeenCalledTimes(2);
    } finally {
      await broker.close();
    }
  });

  it.each([false, true])(
    'ordinary interrupt/stop writes stay v2 after option changes to %s',
    async (optionOn) => {
      let enabled = false;
      const generationStore = jest.fn(() =>
        Promise.resolve(enabled ? ('stream' as const) : ('legacy' as const)),
      );
      const storage = new MemoryDelegationStorage();
      const { broker, runner } = createBrokerHarness(
        { ...{ generationStore }, transcriptPort: streamPort() },
        storage,
      );
      await broker.initialize();
      try {
        const first = await broker.spawn(rootParent, baseTask);
        if (!first.ok) throw new Error('Expected initial admission');
        const id = first.value.delegationId;
        await waitForLaunch(runner, id);
        await runner.sinks.get(id)?.({
          delegationId: id,
          runGeneration: 1,
          sequence: 1,
          occurredAt: 100,
          event: { type: 'started', nativeSessionId: 'legacy-native' },
        });
        enabled = optionOn;
        await broker.manage(
          { ...rootParent, toolCallId: 'interrupt-current' },
          { delegationId: id, operation: 'interrupt' },
        );
        for (
          let i = 0;
          i < 30 && storage.records.get(id)?.control?.status === 'accepted';
          i++
        )
          await flushBroker();
        await broker.stop(rootParent, id);
        expect(storage.records.get(id)).toMatchObject({
          version: 2,
          state: { runGeneration: 1 },
          control: { status: 'completed' },
        });
        expect(generationStore).toHaveBeenCalledTimes(1);
      } finally {
        await broker.close();
      }
    },
  );

  it.each([false, true])(
    'cancellation during selection releases the slot and identity (async %s)',
    async (asyncAdmission) => {
      let release: (decision: 'stream') => void = () => undefined;
      const selected = new Promise<'stream'>((resolve) => {
        release = resolve;
      });
      const generationStore = jest.fn(() => selected);
      const storage = new MemoryDelegationStorage();
      const { broker, runner } = createBrokerHarness(
        {
          ...{ generationStore },
          asyncAdmission,
          capacity: 1,
          lifetimePolicy: () => ({
            kind: 'available',
            limit: 1,
            extension: 'none',
          }),
          transcriptPort: streamPort(),
        },
        storage,
      );
      await broker.initialize();
      try {
        const spawn = broker.spawn(rootParent, baseTask);
        for (let i = 0; i < 30 && generationStore.mock.calls.length === 0; i++)
          await flushBroker();
        expect(generationStore).toHaveBeenCalledTimes(1);
        const cancelled = broker.closeOwner(rootParent, 'parent_cancelled');
        release('stream');
        await cancelled;
        expect((await spawn).ok).toBe(false);
        expect(storage.records.size).toBe(0);
        expect(runner.starts).toHaveLength(0);
        const retry = await broker.spawn(
          { ...rootParent, chatId: 'other-chat', toolCallId: 'after-cancel' },
          baseTask,
        );
        expect(retry.ok).toBe(true);
        if (retry.ok) await waitForLaunch(runner, retry.value.delegationId);
        expect(runner.starts).toHaveLength(1);
      } finally {
        release('stream');
        await broker.close();
      }
    },
  );

  it.each(['follow_up', 'resume'] as const)(
    'existing v3 %s stays stream with the option off',
    async (operation) => {
      let optionOn = true;
      const generationStore = jest.fn(() =>
        Promise.resolve(optionOn ? ('stream' as const) : ('legacy' as const)),
      );
      const storage = new MemoryDelegationStorage();
      const { broker, runner } = createBrokerHarness(
        {
          ...{ generationStore },
          transcriptPort: streamPort(),
          resolveRoute: () =>
            Promise.resolve({
              ok: true,
              value: routeFixture({ capabilities: ['read', 'resume'] }),
            }),
        },
        storage,
      );
      await broker.initialize();
      try {
        const first = await broker.spawn(rootParent, baseTask);
        if (!first.ok) throw new Error('Expected stream admission');
        const id = first.value.delegationId;
        await waitForLaunch(runner, id);
        await settle(runner, id);
        optionOn = false;
        expect(
          await broker.manage(
            { ...rootParent, toolCallId: 'option-off-next' },
            {
              delegationId: id,
              operation,
              message: 'Another exact prompt',
            },
          ),
        ).toMatchObject({ ok: true });
        for (let i = 0; i < 30 && runner.starts.length < 2; i++)
          await flushBroker();
        expect(runner.starts).toHaveLength(2);
        expect(runner.starts[1]).toMatchObject({
          runGeneration: 2,
          transcriptStream: { target: { delegationId: id, runGeneration: 2 } },
        });
        expect(storage.records.get(id)).toMatchObject({
          version: 3,
          registration: {
            origin: {
              kind: operation,
              anchorMessageId: `delegated-agent-${id}-run-2`,
            },
          },
        });
        const continued = storage.records.get(id);
        expect(
          continued?.version === 3
            ? typeof continued.registration.origin.authoredItemId
            : undefined,
        ).toBe('string');
        expect(generationStore).toHaveBeenCalledTimes(1);
      } finally {
        await broker.close();
      }
    },
  );

  it.each(['follow_up', 'resume'] as const)(
    'a refused legacy %s settles its accepted receipt without consuming the slot',
    async (operation) => {
      let refuse = false;
      const generationStore = jest.fn(() =>
        Promise.resolve(
          refuse
            ? {
                kind: 'refused' as const,
                message: 'Delegation storage is not ready. Try again.',
              }
            : ('legacy' as const),
        ),
      );
      const storage = new MemoryDelegationStorage();
      const { broker, runner } = createBrokerHarness(
        {
          ...{ generationStore },
          capacity: 1,
          resolveRoute: () =>
            Promise.resolve({
              ok: true,
              value: routeFixture({ capabilities: ['read', 'resume'] }),
            }),
        },
        storage,
      );
      await broker.initialize();
      try {
        const first = await broker.spawn(rootParent, baseTask);
        if (!first.ok) throw new Error('Expected admission');
        const id = first.value.delegationId;
        await waitForLaunch(runner, id);
        await settle(runner, id);
        refuse = true;
        const response = await broker.manage(
          { ...rootParent, toolCallId: 'refused-next' },
          {
            delegationId: id,
            operation,
            message: 'Cannot launch yet',
          },
        );
        expect(response).toMatchObject({
          ok: false,
          error: {
            code: 'runtime_error',
            retryable: true,
            message: 'Delegation storage is not ready. Try again.',
          },
        });
        expect(storage.records.get(id)).toMatchObject({
          version: 2,
          state: { runGeneration: 1 },
          control: { status: 'failed' },
        });
        expect(runner.starts).toHaveLength(1);
        refuse = false;
        const next = await broker.spawn(
          { ...rootParent, toolCallId: 'after-refusal' },
          baseTask,
        );
        if (!next.ok) throw new Error('Expected released slot');
        await waitForLaunch(runner, next.value.delegationId);
        expect(runner.starts).toHaveLength(2);
      } finally {
        await broker.close();
      }
    },
  );

  it('refuses a queued admission before launch and returns its identity reservation', async () => {
    let decision: 'legacy' | 'refused' = 'legacy';
    const generationStore = (): Promise<
      'legacy' | { kind: 'refused'; message: string }
    > =>
      Promise.resolve(
        decision === 'legacy'
          ? 'legacy'
          : {
              kind: 'refused',
              message: 'Delegation storage is not ready. Try again.',
            },
      );
    const { broker, runner } = createBrokerHarness({
      ...{ generationStore },
      capacity: 1,
      lifetimePolicy: () => ({
        kind: 'available',
        limit: 2,
        extension: 'none',
      }),
    });
    await broker.initialize();
    try {
      const first = await broker.spawn(rootParent, baseTask);
      if (!first.ok) throw new Error('Expected initial admission');
      await waitForLaunch(runner, first.value.delegationId);
      decision = 'refused';
      expect(
        await broker.spawn(
          { ...rootParent, toolCallId: 'refused-queue' },
          baseTask,
        ),
      ).toMatchObject({
        ok: false,
        error: { code: 'runtime_error', retryable: true },
      });
      expect(runner.starts).toHaveLength(1);
      decision = 'legacy';
      const queued = await broker.spawn(
        { ...rootParent, toolCallId: 'queue-retry' },
        baseTask,
      );
      if (!queued.ok) throw new Error('Expected reservation released');
      expect(queued.value.phase).toBe('queued');
      await settle(runner, first.value.delegationId);
      await waitForLaunch(runner, queued.value.delegationId);
      expect(runner.starts).toHaveLength(2);
    } finally {
      await broker.close();
    }
  });

  it('owner cancellation during legacy continuation selection settles its accepted control without publishing a generation', async () => {
    let release: (value: 'stream') => void = () => undefined;
    const delayed = new Promise<'stream'>((resolve) => {
      release = resolve;
    });
    let selecting = false;
    const generationStore = jest.fn(() =>
      selecting ? delayed : Promise.resolve('legacy' as const),
    );
    const storage = new MemoryDelegationStorage();
    const { broker, runner } = createBrokerHarness(
      {
        ...{ generationStore },
        capacity: 1,
        transcriptPort: streamPort(),
        resolveRoute: () =>
          Promise.resolve({
            ok: true,
            value: routeFixture({ capabilities: ['read', 'resume'] }),
          }),
      },
      storage,
    );
    await broker.initialize();
    try {
      const first = await broker.spawn(rootParent, baseTask);
      if (!first.ok) throw new Error('Expected initial admission');
      const id = first.value.delegationId;
      await waitForLaunch(runner, id);
      await settle(runner, id);
      selecting = true;
      const continuation = broker.manage(
        { ...rootParent, toolCallId: 'cancelled-next' },
        {
          delegationId: id,
          operation: 'follow_up',
          message: 'Cancelled prompt',
        },
      );
      for (let i = 0; i < 30 && generationStore.mock.calls.length < 2; i++)
        await flushBroker();
      expect(generationStore).toHaveBeenCalledTimes(2);
      const cancelled = broker.closeOwner(rootParent, 'parent_cancelled');
      release('stream');
      expect(await continuation).toMatchObject({ ok: false });
      await cancelled;
      expect(storage.records.get(id)).toMatchObject({
        version: 2,
        state: { runGeneration: 1 },
        control: { status: 'failed' },
      });
      expect(runner.starts).toHaveLength(1);
      selecting = false;
      const retry = await broker.spawn(
        {
          ...rootParent,
          chatId: 'other-chat',
          toolCallId: 'after-control-cancel',
        },
        baseTask,
      );
      if (!retry.ok) throw new Error('Expected slot released');
      await waitForLaunch(runner, retry.value.delegationId);
      expect(runner.starts).toHaveLength(2);
    } finally {
      release('stream');
      await broker.close();
    }
  });
});

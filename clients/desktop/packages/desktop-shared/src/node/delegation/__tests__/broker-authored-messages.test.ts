import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentDelegationTranscript } from '@canopy/protocol/delegation';
import type { DelegationParentContext } from '../types';
import { FileDelegationStorage } from '../storage';
import {
  baseTask,
  createBrokerHarness,
  emit,
  flushBroker,
  MemoryDelegationStorage,
  rootParent,
  waitForLaunch,
} from './broker-harness';
import { routeFixture } from './fixtures';

describe('broker-authored delegation messages', () => {
  it('retains settled user follow-ups in the latest file-backed generation', async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'delegation-authored-follow-up-'),
    );
    const storage = new FileDelegationStorage(
      path.join(temporaryDirectory, 'runs'),
    );
    const { broker, runner } = createBrokerHarness(
      {
        resolveRoute: (): Promise<{
          ok: true;
          value: ReturnType<typeof routeFixture>;
        }> =>
          Promise.resolve({
            ok: true,
            value: routeFixture({
              capabilities: ['read', 'progress', 'resume'],
            }),
          }),
      },
      storage,
    );
    await broker.initialize();
    try {
      const spawned = await broker.spawn(rootParent, baseTask);
      if (!spawned.ok) throw new Error('Expected root delegation admission');
      const id = spawned.value.delegationId;
      await flushBroker();
      await waitForLaunch(runner, id);
      await emit(runner, id, 1, {
        type: 'started',
        nativeSessionId: 'settled-child-session',
      });
      await emit(runner, id, 2, { type: 'terminal', status: 'completed' });
      await flushBroker();

      const userContext: DelegationParentContext = {
        ...rootParent,
        controlAuthor: 'user',
        turnId: 'settled-user-follow-up',
        toolCallId: 'settled-user-follow-up-call',
      };
      const operationId = randomUUID();
      const result = await broker.message(
        userContext,
        {
          delegationId: id,
          operation: 'follow_up',
          message: 'Please continue from the settled result.',
        },
        operationId,
      );
      expect(result).toMatchObject({ ok: true });

      for (let attempt = 0; attempt < 200; attempt++) {
        if (
          runner.starts.some(
            (request) =>
              request.delegationId === id && request.runGeneration === 2,
          )
        )
          break;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(
        runner.starts.some(
          (request) =>
            request.delegationId === id && request.runGeneration === 2,
        ),
      ).toBe(true);

      const current = await storage.loadOne(id);
      expect(current).toBeDefined();
      if (current?.version === 3) throw new Error();
      expect(current?.parent).not.toHaveProperty('controlAuthor');
      expect(current?.control).toMatchObject({
        operationId,
        sender: { kind: 'user' },
      });
      expect(current?.state).toMatchObject({ runGeneration: 2 });
      expect(current?.state.transcript).toContainEqual(
        expect.objectContaining({
          type: 'text',
          id: operationId,
          text: 'Please continue from the settled result.',
          author: { kind: 'user' },
          delivery: 'follow_up',
        }),
      );
      expect(
        current?.history?.flatMap((entry) => entry.transcript),
      ).not.toContainEqual(expect.objectContaining({ id: operationId }));

      const secondGenerationSink = runner.sinks.get(id);
      if (!secondGenerationSink)
        throw new Error('Expected a runner sink for generation two');
      await secondGenerationSink({
        delegationId: id,
        runGeneration: 2,
        sequence: 1,
        occurredAt: Date.now(),
        event: { type: 'started', nativeSessionId: 'continued-session' },
      });
      await secondGenerationSink({
        delegationId: id,
        runGeneration: 2,
        sequence: 2,
        occurredAt: Date.now(),
        event: {
          type: 'transcript',
          items: [
            {
              type: 'text',
              id: 'provider-cumulative-text',
              sequence: 1,
              occurredAt: Date.now(),
              text: 'Latest provider output.',
            },
          ],
        },
      });
      await flushBroker();
      const reloaded = await new FileDelegationStorage(
        path.join(temporaryDirectory, 'runs'),
      ).loadOne(id);
      if (!reloaded || reloaded.version === 3) {
        throw new Error('Expected a legacy delegation record');
      }
      expect(reloaded?.control?.sender).toEqual({ kind: 'user' });
      expect(reloaded?.parent).not.toHaveProperty('controlAuthor');
      expect(reloaded.state.transcript).toContainEqual(
        expect.objectContaining({
          id: operationId,
          author: { kind: 'user' },
          delivery: 'follow_up',
        }),
      );
      expect(reloaded.state.transcript).toContainEqual(
        expect.objectContaining({ id: 'provider-cumulative-text' }),
      );
    } finally {
      await broker.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('republishes the earlier generation without a follow-up moved to the next one', async () => {
    const published: AgentDelegationTranscript[] = [];
    const { broker, runner } = createBrokerHarness({
      resolveRoute: (): Promise<{
        ok: true;
        value: ReturnType<typeof routeFixture>;
      }> =>
        Promise.resolve({
          ok: true,
          value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
        }),
      onTranscript: (_parent, transcript): void => {
        published.push(transcript);
      },
    });
    await broker.initialize();
    try {
      const spawned = await broker.spawn(rootParent, baseTask);
      if (!spawned.ok) throw new Error('Expected root delegation admission');
      const id = spawned.value.delegationId;
      await flushBroker();
      await waitForLaunch(runner, id);
      await emit(runner, id, 1, {
        type: 'started',
        nativeSessionId: 'moved-follow-up-session',
      });
      await emit(runner, id, 2, { type: 'terminal', status: 'completed' });
      await flushBroker();

      const operationId = randomUUID();
      const result = await broker.message(
        {
          ...rootParent,
          controlAuthor: 'user',
          turnId: 'moved-follow-up',
          toolCallId: 'moved-follow-up-call',
        },
        {
          delegationId: id,
          operation: 'follow_up',
          message: 'Continue with the edge case.',
        },
        operationId,
      );
      expect(result).toMatchObject({ ok: true });
      for (let attempt = 0; attempt < 200; attempt++) {
        if (
          runner.starts.some(
            (request) =>
              request.delegationId === id && request.runGeneration === 2,
          )
        )
          break;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      await flushBroker();

      // A reducer keeps the highest sequence it has seen per generation.
      const latestByGeneration = (
        transcripts: readonly AgentDelegationTranscript[],
      ): Map<number, AgentDelegationTranscript> => {
        const latest = new Map<number, AgentDelegationTranscript>();
        for (const transcript of transcripts) {
          if (transcript.delegationId !== id) continue;
          const prior = latest.get(transcript.runGeneration);
          if (!prior || transcript.sequence > prior.sequence)
            latest.set(transcript.runGeneration, transcript);
        }
        return latest;
      };
      const generationsWithMessage = (
        transcripts: readonly AgentDelegationTranscript[],
      ): number[] =>
        Array.from(latestByGeneration(transcripts).values())
          .filter((transcript) =>
            transcript.transcript.some((item) => item.id === operationId),
          )
          .map((transcript) => transcript.runGeneration);

      expect(generationsWithMessage(published)).toEqual([2]);
      expect(
        generationsWithMessage([
          ...published,
          ...(await broker.transcripts(rootParent)),
        ]),
      ).toEqual([2]);
    } finally {
      await broker.close();
    }
  });

  it('records accepted user and agent messages, deduplicates UUID calls, and denies another chat', async () => {
    const options = {
      resolveRoute: (): Promise<{
        ok: true;
        value: ReturnType<typeof routeFixture>;
      }> =>
        Promise.resolve({
          ok: true,
          value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
        }),
    };
    const storage = new MemoryDelegationStorage();
    const { broker } = createBrokerHarness(options, storage);
    await broker.initialize();
    let restartedBroker:
      | ReturnType<typeof createBrokerHarness>['broker']
      | undefined;

    try {
      const root = await broker.spawn(rootParent, {
        ...baseTask,
        allowNestedDelegation: true,
      });
      if (!root.ok) throw new Error('Expected root delegation admission');
      await flushBroker();

      const operationId = randomUUID();
      const userContext: DelegationParentContext = {
        ...rootParent,
        controlAuthor: 'user',
        turnId: 'user-message',
        toolCallId: 'viewer-message-call',
      };
      const userRequest = {
        delegationId: root.value.delegationId,
        operation: 'follow_up' as const,
        message: 'Please check the edge case.',
      };
      const [accepted, replayed] = await Promise.all([
        broker.message(userContext, userRequest, operationId),
        broker.message(userContext, userRequest, operationId),
      ]);
      const changed = await broker.message(
        userContext,
        {
          ...userRequest,
          message: 'A different request with the same operation id.',
        },
        operationId,
      );
      const otherChat = await broker.message(
        { ...userContext, chatId: 'another-chat' },
        userRequest,
        operationId,
      );

      expect(accepted).toMatchObject({ ok: true });
      expect(replayed).toEqual(accepted);
      expect(changed).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
      expect(otherChat).toMatchObject({
        ok: false,
        error: { code: 'parent_unavailable' },
      });

      const userTranscript = (await broker.transcripts(rootParent)).find(
        (transcript) =>
          transcript.delegationId === root.value.delegationId &&
          transcript.runGeneration === root.value.runGeneration,
      );
      expect(userTranscript?.transcript).toContainEqual(
        expect.objectContaining({
          type: 'text',
          text: 'Please check the edge case.',
          author: { kind: 'user' },
          delivery: 'follow_up',
        }),
      );

      const agentParent: DelegationParentContext = {
        ...rootParent,
        turnId: 'agent-target-turn',
        toolCallId: 'agent-target-call',
      };
      const agentTarget = await broker.spawn(agentParent, baseTask);
      if (!agentTarget.ok)
        throw new Error('Expected depth-zero agent delegation admission');
      await flushBroker();
      await expect(
        broker.message(agentParent, {
          delegationId: agentTarget.value.delegationId,
          operation: 'steer',
          message: 'This came from the root agent.',
        }),
      ).resolves.toMatchObject({ ok: true });
      const agentTranscript = (await broker.transcripts(agentParent)).find(
        (transcript) =>
          transcript.delegationId === agentTarget.value.delegationId,
      );
      expect(agentTranscript?.transcript).toContainEqual(
        expect.objectContaining({
          type: 'text',
          text: 'This came from the root agent.',
          author: { kind: 'agent', depth: 0 },
          delivery: 'steer',
        }),
      );

      const restartedStorage = new MemoryDelegationStorage();
      const retainedRoot = storage.records.get(root.value.delegationId);
      if (!retainedRoot) throw new Error('Expected a retained root record');
      await restartedStorage.commit(structuredClone(retainedRoot));
      const restarted = createBrokerHarness(options, restartedStorage);
      restartedBroker = restarted.broker;
      await restartedBroker.initialize();
      const changedEpochReplay = await restartedBroker.message(
        {
          ...userContext,
          harnessId: 'codex',
          runtimeGeneration: 2,
          turnId: 'new-provider-turn',
          toolCallId: 'new-provider-tool-call',
        },
        userRequest,
        operationId,
      );
      expect(changedEpochReplay).toEqual(accepted);
      await expect(
        restartedBroker.message(
          {
            ...userContext,
            harnessId: 'codex',
            runtimeGeneration: 2,
            turnId: 'new-provider-turn',
            toolCallId: 'new-provider-tool-call',
          },
          { ...userRequest, message: 'Changed after restart.' },
          operationId,
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });

      const nestedParent: DelegationParentContext = {
        ...rootParent,
        harnessId: 'third-harness',
        depth: 1,
        parentDelegationId: root.value.delegationId,
        parentRunGeneration: 1,
        parentDescription: 'Review the supplied task',
        toolCallId: 'nested-spawn',
      };
      const nested = await broker.spawn(nestedParent, baseTask);
      if (!nested.ok) throw new Error('Expected nested delegation admission');
      await flushBroker();
      const agentContext: DelegationParentContext = {
        ...nestedParent,
        turnId: 'agent-message',
        toolCallId: randomUUID(),
      };
      const agentMessage = await broker.message(agentContext, {
        delegationId: nested.value.delegationId,
        operation: 'steer',
        message: 'Use the updated evidence.',
      });
      expect(agentMessage).toMatchObject({ ok: true });

      const transcripts = await broker.transcripts(rootParent);
      const nestedTranscript = transcripts.find(
        (transcript) =>
          transcript.delegationId === nested.value.delegationId &&
          transcript.runGeneration === nested.value.runGeneration,
      );
      expect(nestedTranscript?.transcript).toContainEqual(
        expect.objectContaining({
          type: 'text',
          text: 'Use the updated evidence.',
          author: {
            kind: 'agent',
            depth: 1,
            delegationId: root.value.delegationId,
            description: 'Review the supplied task',
          },
          delivery: 'steer',
        }),
      );
    } finally {
      await restartedBroker?.close();
      await broker.close();
    }
  });

  it('interrupts one child without stopping its descendants', async () => {
    const storage = new MemoryDelegationStorage();
    const { broker, runner } = createBrokerHarness({}, storage);
    await broker.initialize();
    try {
      const root = await broker.spawn(rootParent, {
        ...baseTask,
        allowNestedDelegation: true,
      });
      if (!root.ok) throw new Error('Expected root delegation admission');
      await flushBroker();
      await waitForLaunch(runner, root.value.delegationId);

      const childParent: DelegationParentContext = {
        ...rootParent,
        harnessId: 'third-harness',
        depth: 1,
        parentDelegationId: root.value.delegationId,
        parentRunGeneration: 1,
        parentDescription: baseTask.description,
        turnId: 'child-turn',
        toolCallId: 'child-spawn',
      };
      const child = await broker.spawn(childParent, {
        ...baseTask,
        allowNestedDelegation: true,
      });
      if (!child.ok) throw new Error('Expected child delegation admission');
      await flushBroker();
      await waitForLaunch(runner, child.value.delegationId);

      const descendantParent: DelegationParentContext = {
        ...childParent,
        depth: 2,
        parentDelegationId: child.value.delegationId,
        parentRunGeneration: 1,
        parentDescription: baseTask.description,
        turnId: 'descendant-turn',
        toolCallId: 'descendant-spawn',
      };
      const descendant = await broker.spawn(descendantParent, baseTask);
      if (!descendant.ok)
        throw new Error('Expected descendant delegation admission');
      await flushBroker();
      await waitForLaunch(runner, descendant.value.delegationId);

      await expect(
        broker.message(childParent, {
          delegationId: child.value.delegationId,
          operation: 'interrupt',
        }),
      ).resolves.toMatchObject({ ok: true });
      await flushBroker();

      expect(runner.stopped).toContain(child.value.delegationId);
      expect(runner.stopped).not.toContain(descendant.value.delegationId);
      expect(
        broker.inspect(rootParent, child.value.delegationId),
      ).toMatchObject({
        status: 'interrupted',
      });
      const descendantAfterInterrupt = broker.inspect(
        rootParent,
        descendant.value.delegationId,
      );
      expect(descendantAfterInterrupt).toBeDefined();
      expect(['pending', 'running']).toContain(
        descendantAfterInterrupt?.status,
      );
      // Interrupt targets only this run. Stop is the separate operation that
      // cascades through descendants, so the descendant remains controllable.
      await expect(
        broker.message(rootParent, {
          delegationId: descendant.value.delegationId,
          operation: 'steer',
          message: 'Continue independently of the interrupted child.',
        }),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await broker.close();
    }
  });
});

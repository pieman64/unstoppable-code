import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDelegationTranscript } from '@canopy/protocol/delegation';
import { readMetadataOfRecord } from '@canopy/desktop-shared/node/delegation/record-v3';
import { createDelegationRecordReader } from '../agents/delegation/record-reader';
import {
  c12Backing,
  chatId,
  delegationId,
  target,
} from './helpers/delegation-c12-harness';
import { parent } from './helpers/delegation-two-scope-backing';
import {
  baseTask,
  flushBroker,
  waitForLaunch,
} from '../../../../../packages/desktop-shared/src/node/delegation/__tests__/broker-harness';
import { routeFixture } from '../../../../../packages/desktop-shared/src/node/delegation/__tests__/fixtures';

describe('production generation card anchors', () => {
  it('retains distinct generation prompts after file-backed broker and repository restart without relaunch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'generation-prompts-'));
    const f = await c12Backing(root, {
      broker: {
        resolveRoute: () =>
          Promise.resolve({
            ok: true,
            value: routeFixture({ capabilities: ['read', 'resume'] }),
          }),
      },
    });
    try {
      await f.start();
      await f.terminal('first answer');
      expect(
        await f.harness.broker.manage(
          { ...parent(f.scope), toolCallId: 'second-prompt' },
          {
            delegationId,
            operation: 'follow_up',
            message: 'Distinct second-generation prompt 🌿',
          },
        ),
      ).toMatchObject({ ok: true });
      for (let i = 0; i < 200 && f.harness.runner.starts.length < 2; i++)
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      expect(f.harness.runner.starts).toHaveLength(2);
      const sink = f.harness.runner.sinks.get(delegationId);
      if (!sink) throw new Error('Missing second generation sink');
      await sink({
        delegationId,
        runGeneration: 2,
        sequence: 1,
        occurredAt: 300,
        event: { type: 'started', nativeSessionId: 'c12-native' },
      });
      await sink({
        delegationId,
        runGeneration: 2,
        sequence: 2,
        occurredAt: 400,
        event: {
          type: 'terminal',
          status: 'completed',
          finalText: 'second answer',
        },
      });
      await f.harness.broker.flushCardPublication(target(2));
      await f.restart();
      await f.reopenRepository();
      expect(f.harness.runner.starts).toHaveLength(0);
      const record = await f.record();
      const reader = createDelegationRecordReader({
        port: f.repository,
        scope: f.scope,
      });
      const input = { record, readMetadata: readMetadataOfRecord(record) };
      expect(await reader.resolveGenerationHeader(input, 1)).toMatchObject({
        kind: 'stream',
        task: { prompt: baseTask.prompt },
      });
      expect(await reader.resolveGenerationHeader(input, 2)).toMatchObject({
        kind: 'stream',
        task: { prompt: 'Distinct second-generation prompt 🌿' },
      });
      expect(record.registration.origin.anchorMessageId).toBe(
        `delegated-agent-${delegationId}-run-2`,
      );
    } finally {
      await f.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves a card published after its registration without registering again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'generation-late-card-'));
    const envelopes: AgentDelegationTranscript[] = [];
    const f = await c12Backing(root, {
      broker: {
        onTranscript: (_parent, transcript) => {
          envelopes.push(transcript);
        },
      },
    });
    const registered = jest.spyOn(f.port, 'registerGeneration');
    try {
      const spawned = await f.spawn();
      if (!spawned.ok) throw new Error('Expected generation admission');
      await waitForLaunch(f.harness.runner, delegationId);
      await flushBroker();
      expect(registered).toHaveBeenCalled();
      // Card publication can idempotently register the same generation too.
      // Reader resolution must not need any registration after this point.
      registered.mockClear();
      expect(
        await f.repository.generation(f.scope, {
          chatId,
          delegationId,
          runGeneration: 1,
        }),
      ).toMatchObject({
        entry: {
          origin: { anchorMessageId: `delegated-agent-${delegationId}` },
        },
      });
      const record = await f.record();
      const input = { record, readMetadata: readMetadataOfRecord(record) };
      const reader = createDelegationRecordReader({
        port: f.repository,
        scope: f.scope,
      });
      expect(await reader.resolveGenerationHeader(input, 1)).toMatchObject({
        kind: 'stream',
        task: { prompt: '' },
      });
      const transcript = envelopes[0];
      if (!transcript) throw new Error('Missing card creation envelope');
      await f.service.ingestProviderEventWithOutcome({
        ...f.scope,
        chatId,
        data: {
          type: 'canopy_delegation',
          delegation: transcript,
          canopy_turn_user_message_id: transcript.parentTurnId,
        },
        mutationId: 'late-card-published',
      });
      expect(await reader.resolveGenerationHeader(input, 1)).toMatchObject({
        kind: 'stream',
        task: { prompt: baseTask.prompt },
      });
      expect(registered).toHaveBeenCalledTimes(0);
    } finally {
      registered.mockRestore();
      await f.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

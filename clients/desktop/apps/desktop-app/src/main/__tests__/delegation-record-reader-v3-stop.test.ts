import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryDelegationTranscriptPort } from '@canopy/desktop-shared/node/delegation/in-memory-transcript-port';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import type {
  DelegationTranscriptGeneration,
  DelegationTranscriptGenerationsPage,
  DelegationTranscriptResultEntry,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import {
  baseTask,
  createBrokerHarness,
  rootParent,
  waitForLaunch,
} from '../../../../../packages/desktop-shared/src/node/delegation/__tests__/broker-harness';
import { routeFixture } from '../../../../../packages/desktop-shared/src/node/delegation/__tests__/fixtures';
import { createDelegationRecordReader } from '../agents/delegation/record-reader';
import type { DelegationRecordReadPort } from '../agents/delegation/repository-transcript-port';
import type { ChatScopeKey } from '../services/chat-state-contracts';

const scope: ChatScopeKey = {
  projectId: rootParent.projectId,
  worktreeId: rootParent.worktreeId,
};

/** The app reader's port over the same registry the broker settles into. */
function readPortOver(
  transcripts: InMemoryDelegationTranscriptPort,
): DelegationRecordReadPort {
  return {
    generation: async (
      _scope,
      input,
    ): Promise<DelegationTranscriptGeneration | undefined> => {
      const read = await transcripts.generation(input);
      return read.ok ? read.value : undefined;
    },
    resultByGeneration: async (
      _scope,
      input,
    ): Promise<DelegationTranscriptResultEntry | undefined> => {
      const read = await transcripts.resultByGeneration(input);
      return read.ok ? read.value : undefined;
    },
    generationsPage: async (
      _scope,
      input,
    ): Promise<DelegationTranscriptGenerationsPage> => {
      const read = await transcripts.generationsPage(input);
      if (!read.ok) throw new Error('Expected a generations page');
      return read.value;
    },
    getChildStreamState: () => Promise.resolve(undefined),
    readStoredParentMessage: () => Promise.resolve(undefined),
  };
}

type CurrentStop =
  | Pick<
      NonNullable<AgentDelegationSnapshot['stopRequested']>,
      'operationId' | 'status'
    >
  | undefined;

describe('app record reader current stop policy on v3 records (B6)', () => {
  let directory: string;
  let closeBroker: (() => Promise<void>) | undefined;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'reader-v3-stop-'));
  });
  afterEach(async () => {
    // Close before removing the directory, even after a failed assertion.
    await closeBroker?.();
    closeBroker = undefined;
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('agrees with the broker snapshot through stop A, clear, resume, stop B and an A replay', async () => {
    const transcripts = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
      ownsChat: (): boolean => true,
    });
    const storage = new FileDelegationStorage(directory);
    let cleared: () => void = () => undefined;
    const clearGate = new Promise<void>((resolve) => {
      cleared = resolve;
    });
    const commit = storage.commit.bind(storage);
    jest
      .spyOn(storage, 'commit')
      .mockImplementation(
        async (record: Parameters<typeof storage.commit>[0]): Promise<void> => {
          await commit(record);
          if (
            'version' in record &&
            record.version === 3 &&
            record.receipts.stopReceipts.length > 0 &&
            !record.receipts.activeStop
          )
            cleared();
        },
      );
    const { broker, runner } = createBrokerHarness(
      {
        testOnlyStreamGeneration: true,
        resolveRoute: () =>
          Promise.resolve({
            ok: true as const,
            value: routeFixture({
              capabilities: ['read', 'progress', 'resume'],
            }),
          }),
        transcriptPort: transcripts,
      },
      storage,
    );
    closeBroker = (): Promise<void> => broker.close();
    const reader = createDelegationRecordReader({
      port: readPortOver(transcripts),
      scope,
    });
    await broker.initialize();
    const spawned = await broker.spawn(rootParent, baseTask);
    if (!spawned.ok) throw new Error('Expected admission');
    const id = spawned.value.delegationId;
    await waitForLaunch(runner, id);
    await runner.sink?.({
      delegationId: id,
      runGeneration: 1,
      sequence: 1,
      occurredAt: 100,
      event: { type: 'started', nativeSessionId: 'native' },
    });

    const appStop = async (): Promise<CurrentStop> => {
      // Read a record between settlements: a pending intent resolves as
      // `settling`, which carries no current snapshot to compare.
      let record = await storage.loadOne(id);
      for (
        let attempt = 0;
        attempt < 400 && record?.version === 3 && record.settling;
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        record = await storage.loadOne(id);
      }
      if (record?.version !== 3) throw new Error('Expected a v3 record');
      const resolved = await reader.resolveGenerationHeader(
        { record, readMetadata: record.readMetadata },
        record.state.runGeneration,
      );
      if (resolved.kind !== 'stream')
        throw new Error(`Expected a stream generation, got ${resolved.kind}`);
      return resolved.snapshot.stopRequested;
    };
    const brokerStop = (): CurrentStop => {
      const stop = broker.inspect(rootParent, id)?.stopRequested;
      return stop && { operationId: stop.operationId, status: stop.status };
    };
    const agree = async (): Promise<CurrentStop> => {
      const app = await appStop();
      expect(app).toEqual(brokerStop());
      return app;
    };

    const stopA = { ...rootParent, toolCallId: 'stop-A' };
    expect((await broker.requestStop(stopA, id)).ok).toBe(true);
    const accepted = await agree();
    expect(accepted?.operationId).toBeDefined();

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        clearGate,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const fenced = await agree();
    expect(fenced).toEqual({
      operationId: accepted?.operationId,
      status: 'completed',
    });

    const resume = await broker.manage(
      { ...rootParent, toolCallId: 'resume' },
      { delegationId: id, operation: 'resume', message: 'continue' },
    );
    expect(resume.ok).toBe(true);
    for (
      let attempt = 0;
      attempt < 200 &&
      !runner.starts.some((start) => start.runGeneration === 2);
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(await agree()).toBeUndefined();

    expect(
      (await broker.requestStop({ ...rootParent, toolCallId: 'stop-B' }, id))
        .ok,
    ).toBe(true);
    const stopB = await agree();
    expect(stopB?.operationId).not.toBe(accepted?.operationId);

    // An old A replay answers from A's outcome and leaves the current view on B.
    const replay = await broker.requestStop(stopA, id);
    expect(replay).toMatchObject({
      ok: true,
      value: {
        stopRequested: {
          operationId: accepted?.operationId,
          status: 'completed',
        },
      },
    });
    expect(await agree()).toEqual(stopB);
    await broker.close();
  }, 30_000);
});

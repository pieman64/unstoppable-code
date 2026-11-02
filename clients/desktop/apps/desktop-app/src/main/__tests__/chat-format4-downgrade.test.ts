// Candidate builds real mixed legacy/stream bytes. The root alone runs parent
// mode in 1735f9bf23 with that checkout's packages and a complete isolated copy.
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import { readMetadataOfRecord } from '@canopy/desktop-shared/node/delegation/record-v3';
import { createBrokerHarness } from '../../../../../packages/desktop-shared/src/node/delegation/__tests__/broker-harness';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { ChatStateService } from '../services/chat-state-service';
import { RepositoryDelegationTranscriptPort } from '../agents/delegation/repository-transcript-port';
import { loadDelegationRecoveryMutations } from '../agents/delegation/recovery';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { readChatStorageDiscoveryIndex } from '../lib/chat-storage-discovery';
import { ChatStorageNewerFormatError } from '../lib/chat-delta-journal/format';
import { snapshotHFiles as snapshotFormat4Files } from './helpers/delegation-promotion-files';
import {
  buildHLegacy,
  H_CHAT,
  H_ID,
  H_PARENT,
  H_SCOPE,
  hBody,
  hDirectory,
  hFollow,
  hPaths,
  hRuns,
  openH,
} from './helpers/delegation-promotion-fixture';
import {
  assertHLegacyReads,
  assertHRun,
} from './helpers/delegation-promotion-reads';

jest.setTimeout(120_000);
let mockFixtureRoot = '';
jest.mock('../lib/paths', () => ({
  ...jest.requireActual<object>('../lib/paths'),
  getWorktreeDataDir: (projectId: string, worktreeId: string): string =>
    join(mockFixtureRoot, projectId, worktreeId),
}));

const parentBuild = process.env.CANOPY_DOWNGRADE_BUILD === 'parent';
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'format4-downgrade-h-'));
  mockFixtureRoot = root;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

if (!parentBuild) {
  it('exports candidate-written format 4 with retained v3 settlement, reopens every target and preserves all result indexes', async () => {
    const source = process.env.CANOPY_DOWNGRADE_FIXTURE_DIR;
    if (source)
      await cp(source, root, { recursive: true, preserveTimestamps: true });
    else {
      await buildHLegacy(root);
      const writer = await openH(root, true);
      try {
        await writer.harness.broker.initialize();
        await hFollow(writer, 4);
        await hBody(writer, 4);
        expect(await writer.storage.loadOne(H_ID)).toMatchObject({
          version: 3,
          latestResult: { resultIndex: 4, runGeneration: 4 },
        });
      } finally {
        await writer.close();
      }
    }
    const out = process.env.CANOPY_DOWNGRADE_FIXTURE_OUT;
    if (out)
      await cp(root, out, {
        recursive: true,
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
      });
    const before = await snapshotFormat4Files(root);
    const old = new ChatStorageV2(
      hDirectory(root),
      H_SCOPE.worktreeId,
      undefined,
      { maxManifestVersion: 3 },
    );
    await expect(old.indexes()).rejects.toBeInstanceOf(
      ChatStorageNewerFormatError,
    );
    expect(await snapshotFormat4Files(root)).toEqual(before);
    const reader = await openH(root, false);
    try {
      await assertHLegacyReads(reader.service);
      await assertHRun(reader.service, H_ID, 4);
      // Load may rebuild this classified derived index; do not confuse the
      // broker's later owned startup-repair write with an actorless read.
      const canonical = (files: typeof before): typeof before =>
        files.filter((file) => !file.path.endsWith('/registry.index.json'));
      expect(canonical(await snapshotFormat4Files(root))).toEqual(
        canonical(before),
      );
      await reader.harness.broker.initialize();
      expect(reader.harness.runner.starts).toHaveLength(0);
      for (const resultIndex of [1, 2, 3, 4])
        expect(
          await reader.harness.broker.getOutput(H_PARENT, {
            delegationId: H_ID,
            resultIndex,
          }),
        ).toMatchObject({
          ok: true,
          value: { result: { resultIndex, runGeneration: resultIndex } },
        });
      expect(reader.errors).toEqual([]);
    } finally {
      await reader.close();
    }
  });
} else {
  it('parent discovery, repository, file broker repair and a mutation refuse format 4 without any file or native change', async () => {
    const source = process.env.CANOPY_DOWNGRADE_FIXTURE_DIR;
    if (!source)
      throw new Error('Parent mode requires CANOPY_DOWNGRADE_FIXTURE_DIR');
    await cp(source, root, { recursive: true, preserveTimestamps: true });
    const before = await snapshotFormat4Files(root);
    const storage = new FileDelegationStorage(hRuns(root));
    const records = await storage.load();
    const record = records.find((entry) => entry.state.delegationId === H_ID);
    expect(record).toMatchObject({
      version: 3,
      latestResult: { resultIndex: 4 },
    });
    if (record?.version !== 3)
      throw new Error('Missing retained-settlement v3 record');
    const repository = new ChatStateV2Repository({
      resolvePaths: (): ReturnType<typeof hPaths> => hPaths(root),
      delegationReadMetadata: readMetadataOfRecord,
    });
    const service = new ChatStateService({
      repository,
      recordDiagnostic: jest.fn(),
    });
    const port = new RepositoryDelegationTranscriptPort(service, H_SCOPE);
    const lookup = jest.spyOn(port, 'resultBySettlementKey');
    const harness = createBrokerHarness({ transcriptPort: port }, storage);
    try {
      await expect(
        readChatStorageDiscoveryIndex(hDirectory(root), H_SCOPE.worktreeId),
      ).rejects.toBeInstanceOf(ChatStorageNewerFormatError);
      let failure: unknown;
      try {
        await repository.getState(H_SCOPE);
      } catch (error) {
        failure = error;
      }
      expect(failure instanceof Error && failure.cause).toBeInstanceOf(
        ChatStorageNewerFormatError,
      );
      await expect(harness.broker.initialize()).rejects.toThrow(
        'newer version',
      );
      expect(lookup).toHaveBeenCalled();
      for (const call of lookup.mock.results) {
        if (call.type !== 'return')
          throw new Error('Expected repository-backed startup lookup');
        expect(await call.value).toMatchObject({
          ok: false,
          error: { code: 'unsupported_format', retryable: false },
        });
      }
      // Public recovery loader sees real file records outside the chat root.
      const recovery = await loadDelegationRecoveryMutations(
        H_SCOPE,
        {
          version: 1,
          tabs: [
            {
              id: H_CHAT,
              title: 'Downgrade recovery',
              createdAt: '2026-10-20',
              messages: [
                {
                  id: H_PARENT.turnId,
                  role: 'user',
                  timestamp: 1,
                  blocks: [{ type: 'text', text: 'First prompt 🌲' }],
                },
              ],
            },
          ],
          activeTabId: H_CHAT,
        },
        { version: 1, archived: [] },
        { readMetadata: readMetadataOfRecord },
      );
      expect(recovery.length).toBeGreaterThan(0);
      await expect(
        repository.transact(H_SCOPE, recovery, { source: 'provider' }),
      ).rejects.toBe(failure);
      expect(
        await port.registerGeneration({
          chatId: H_CHAT,
          delegationId: H_ID,
          ...record.registration,
        }),
      ).toMatchObject({
        ok: false,
        error: { code: 'unsupported_format', retryable: false },
      });
      // Representative canonical mutation, not a stubbed admission failure.
      await expect(
        repository.transact(
          H_SCOPE,
          [
            {
              type: 'message.upserted',
              chatId: H_CHAT,
              message: {
                id: 'parent-must-not-write',
                role: 'assistant',
                timestamp: 1,
                blocks: [{ type: 'text', text: 'refused' }],
              },
            },
          ],
          { source: 'provider' },
        ),
      ).rejects.toBe(failure);
      expect(harness.runner.starts).toHaveLength(0);
    } finally {
      await harness.broker.close();
      await repository.drainAll();
      lookup.mockRestore();
    }
    expect(await snapshotFormat4Files(root)).toEqual(before);
  });
}

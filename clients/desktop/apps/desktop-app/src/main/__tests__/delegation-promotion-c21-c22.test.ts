import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import type { AgentDelegationBrokerOptions } from '@canopy/desktop-shared/node/delegation/broker';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import * as standaloneHistory from '../lib/standalone-history';
import * as archivedContainers from '../lib/archived-containers';
import {
  baseTask,
  waitForLaunch,
} from '../../../../../packages/desktop-shared/src/node/delegation/__tests__/broker-harness';
import { snapshotHFiles as snapshotFormat4Files } from './helpers/delegation-promotion-files';
import {
  buildHLegacy,
  seedHLegacy,
  hBody,
  hLaunch,
  hDirectory,
  hFollow,
  H_CHAT,
  H_ID,
  H_INLINE,
  H_LOG,
  H_PARENT,
  H_SCOPE,
  hTarget,
  openH,
} from './helpers/delegation-promotion-fixture';
import {
  assertHLegacyReads,
  assertHRun,
} from './helpers/delegation-promotion-reads';

jest.setTimeout(120_000);

describe('phase 14 C21/C22 acceptance composition', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'promotion-h-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads exact mixed legacy targets before and after v2 history converts at one stream-generation boundary', async () => {
    await buildHLegacy(root);
    const before = await snapshotFormat4Files(root);
    const legacyFiles = before.filter(
      (file) =>
        file.path.includes('/transcripts/') ||
        file.path.includes('/delegation/runs/'),
    );
    expect(legacyFiles.length).toBeGreaterThan(3);
    let f = await openH(root, true);
    try {
      expect(await f.service.generationStoreReadiness(H_SCOPE)).toEqual({
        formatVersion: 4,
        enableFormat4: true,
      });
      await assertHLegacyReads(f.service);
      expect(
        (await snapshotFormat4Files(root)).filter((file) =>
          legacyFiles.some((old) => old.path === file.path),
        ),
      ).toEqual(legacyFiles);
      await f.close();
      f = await openH(root, true);
      await assertHLegacyReads(f.service);
      await f.close();
      f = await openH(root, true);
      await assertHLegacyReads(f.service);
      expect(
        (await snapshotFormat4Files(root)).filter((file) =>
          legacyFiles.some((old) => old.path === file.path),
        ),
      ).toEqual(legacyFiles);
      await f.harness.broker.initialize();
      expect(f.harness.runner.starts).toHaveLength(0);
      // A real owned control receipt write must not switch the current store.
      await f.harness.broker.manage(
        { ...H_PARENT, toolCallId: 'h-stop-settled' },
        { delegationId: H_ID, operation: 'stop' },
      );
      expect(await f.storage.loadOne(H_ID)).toMatchObject({ version: 2 });
      await hFollow(f, 4);
      expect(f.harness.runner.starts).toHaveLength(1);
      expect(f.harness.runner.starts[0]).toMatchObject({
        runGeneration: 4,
        transcriptStream: { target: { runGeneration: 4 } },
      });
      expect(await f.storage.loadOne(H_ID)).toMatchObject({
        version: 3,
        legacyPrefix: {
          results: [
            { resultIndex: 1, runGeneration: 1 },
            { resultIndex: 2, runGeneration: 2 },
            { resultIndex: 3, runGeneration: 3 },
          ],
        },
      });
      await hBody(f, 4);
      await assertHLegacyReads(f.service);
      await assertHRun(f.service, H_ID, 4);
      for (const index of [1, 2, 3, 4])
        expect(
          await f.harness.broker.getOutput(H_PARENT, {
            delegationId: H_ID,
            resultIndex: index,
          }),
        ).toMatchObject({
          ok: true,
          value: { result: { resultIndex: index, runGeneration: index } },
        });
      expect(f.errors).toEqual([]);
      await f.close();
      f = await openH(root, false);
      await f.harness.broker.initialize();
      expect(f.harness.runner.starts).toHaveLength(0);
      await assertHLegacyReads(f.service);
      await assertHRun(f.service, H_ID, 4);
      // B1: existing v3 continues stream even with promotion/selection disabled.
      await hFollow(f, 5);
      expect(f.harness.runner.starts).toHaveLength(1);
      expect(f.harness.runner.starts[0]).toMatchObject({
        runGeneration: 5,
        transcriptStream: { target: { runGeneration: 5 } },
      });
    } finally {
      await f.close();
    }
  });

  it('refuses a block cursor from another run and from a later legacy revision', async () => {
    await buildHLegacy(root);
    const f = await openH(root, true);
    try {
      const request = {
        ...H_SCOPE,
        chatId: H_CHAT,
        target: hTarget(H_LOG),
        messageId: `delegated-agent-${H_LOG}:log-tool`,
      };
      const page = await f.service.getTranscriptBlocks({
        ...request,
        limit: 1,
      });
      expect(page.cursor).toBeDefined();
      await expect(
        f.service.getTranscriptBlocks({
          ...request,
          target: hTarget(H_INLINE),
          cursor: page.cursor,
          limit: 1,
        }),
      ).rejects.toThrow();
      await f.service.appendDelegationItems(H_SCOPE, H_CHAT, [
        {
          run: hTarget(H_LOG),
          items: [
            {
              id: 'log-text',
              sequence: 0,
              occurredAt: 12,
              type: 'text',
              text: 'changed legacy revision',
            },
          ],
        },
      ]);
      await expect(
        f.service.getTranscriptBlocks({
          ...request,
          cursor: page.cursor,
          limit: 1,
        }),
      ).rejects.toThrow();
    } finally {
      await f.close();
    }
  });

  it('preserves complete copied bytes while an explicit ceiling-3 reader refuses promotion', async () => {
    await buildHLegacy(root);
    const f = await openH(root, true);
    await f.service.generationStoreReadiness(H_SCOPE);
    await f.close();
    const copy = join(root, 'isolated');
    await cp(hDirectory(root), copy, {
      recursive: true,
      preserveTimestamps: true,
    });
    const before = await snapshotFormat4Files(copy);
    const old = new ChatStorageV2(copy, H_SCOPE.worktreeId, undefined, {
      maxManifestVersion: 3,
    });
    await expect(old.indexes()).rejects.toMatchObject({
      name: 'ChatStorageNewerFormatError',
    });
    expect(await snapshotFormat4Files(copy)).toEqual(before);
  });

  it('fails closed without writes for journaled format-4 standalone and container archives (phase 15 gap)', async () => {
    await buildHLegacy(root);
    const f = await openH(root, true);
    await f.service.generationStoreReadiness(H_SCOPE);
    await f.close();
    const archiveRoot = join(root, 'archive-copy');
    await cp(hDirectory(root), archiveRoot, {
      recursive: true,
      preserveTimestamps: true,
    });
    const archiveStore = new ChatStorageV2(archiveRoot, H_SCOPE.worktreeId);
    const standalone = jest
      .spyOn(standaloneHistory, 'getStandaloneHistoryStorage')
      .mockResolvedValue(archiveStore);
    const container = jest
      .spyOn(archivedContainers, 'getArchivedContainerChatStorage')
      .mockResolvedValue(archiveStore);
    const reader = await openH(root, false);
    try {
      const before = await snapshotFormat4Files(archiveRoot);
      await expect(
        reader.service.getTranscriptPage({
          ...H_SCOPE,
          chatId: H_CHAT,
          target: hTarget(),
          standaloneHistory: true,
        }),
      ).rejects.toMatchObject({ name: 'ChatStorageNewerFormatError' });
      await expect(
        reader.service.getTranscriptPage({
          ...H_SCOPE,
          chatId: H_CHAT,
          target: hTarget(),
          archivedContainerId: 'h-container',
        }),
      ).rejects.toMatchObject({ name: 'ChatStorageNewerFormatError' });
      expect(await snapshotFormat4Files(archiveRoot)).toEqual(before);
    } finally {
      await reader.service.drain();
      await reader.close();
      standalone.mockRestore();
      container.mockRestore();
    }
  });

  it('refuses opted-in spawn and follow-up before native start or transcript publication when promotion cannot publish', async () => {
    await buildHLegacy(root);
    const published = jest.fn<
      ReturnType<NonNullable<AgentDelegationBrokerOptions['onTranscript']>>,
      Parameters<NonNullable<AgentDelegationBrokerOptions['onTranscript']>>
    >();
    const f = await openH(
      root,
      true,
      { onTranscript: published },
      {
        deltaJournalOnBoundary: (point): Promise<void> => {
          if (point === 'catalog-temp-written')
            throw new Error('H promotion storage fault');
          return Promise.resolve();
        },
      },
    );
    const registration = jest.spyOn(f.port, 'registerGeneration');
    try {
      expect(await f.service.generationStoreReadiness(H_SCOPE)).toEqual({
        formatVersion: 3,
        enableFormat4: true,
      });
      await f.harness.broker.initialize();
      published.mockClear();
      expect(
        await f.harness.broker.spawn(
          { ...H_PARENT, toolCallId: 'h-refused-spawn' },
          baseTask,
        ),
      ).toMatchObject({
        ok: false,
        error: { code: 'runtime_error', retryable: true },
      });
      // A refused initial admission must not publish even an accepted card.
      expect(published).not.toHaveBeenCalled();
      expect(
        await f.harness.broker.manage(
          { ...H_PARENT, toolCallId: 'h-refused-follow' },
          {
            delegationId: H_ID,
            operation: 'follow_up',
            message: 'must not publish',
          },
        ),
      ).toMatchObject({
        ok: false,
        error: { code: 'runtime_error', retryable: true },
      });
      expect(f.harness.runner.starts).toHaveLength(0);
      expect(registration).not.toHaveBeenCalled();
      expect(published).toHaveBeenCalled();
      for (const call of published.mock.calls)
        expect(call[1]).toMatchObject({ delegationId: H_ID, runGeneration: 3 });
      expect(await f.storage.loadOne(H_ID)).toMatchObject({
        version: 2,
        state: { runGeneration: 3 },
        control: {
          status: 'failed',
          error: 'Delegation storage is not ready. Try again.',
        },
      });
      expect(
        (
          await f.service.getTranscriptPage({ ...H_SCOPE, chatId: H_CHAT })
        ).messages.some((row) =>
          row.id.startsWith(`delegated-agent-${H_ID}-run-4`),
        ),
      ).toBe(false);
      expect(await f.storage.load()).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it('keeps a queued legacy admission legacy across actual ordered repository promotion', async () => {
    await seedHLegacy(root);
    const f = await openH(root, false, { capacity: 1 });
    try {
      await f.harness.broker.initialize();
      const uuid = jest.spyOn(crypto, 'randomUUID').mockReturnValueOnce(H_ID);
      try {
        expect(await f.harness.broker.spawn(H_PARENT, baseTask)).toMatchObject({
          ok: true,
        });
      } finally {
        uuid.mockRestore();
      }
      await hLaunch(f, 1);
      const queued = await f.harness.broker.spawn(
        { ...H_PARENT, toolCallId: 'h-queued' },
        baseTask,
      );
      expect(queued).toMatchObject({ ok: true, value: { phase: 'queued' } });
      if (!queued.ok) throw new Error('Missing queued admission');
      await f.reopen(true);
      expect(await f.service.generationStoreReadiness(H_SCOPE)).toEqual({
        formatVersion: 4,
        enableFormat4: true,
      });
      const ownedWrite = jest.spyOn(f.storage, 'commit');
      expect(
        await f.harness.broker.manage(
          { ...H_PARENT, toolCallId: 'h-interrupt-current' },
          { delegationId: H_ID, operation: 'interrupt' },
        ),
      ).toMatchObject({ ok: true });
      await f.sync();
      expect(ownedWrite).toHaveBeenCalled();
      expect(await f.storage.loadOne(H_ID)).toMatchObject({
        version: 2,
        state: { runGeneration: 1 },
      });
      ownedWrite.mockRestore();
      await hBody(f, 1);
      const run = await waitForLaunch(
        f.harness.runner,
        queued.value.delegationId,
      );
      expect(run.transcriptStream).toBeUndefined();
      expect(await f.storage.loadOne(queued.value.delegationId)).toMatchObject({
        version: 2,
      });
      expect(f.harness.runner.starts).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

  it('replays a retained stream resume idempotently after restart without relaunching earlier runs', async () => {
    await buildHLegacy(root);
    let f = await openH(root, true);
    try {
      await f.harness.broker.initialize();
      await hFollow(f, 4);
      await hBody(f, 4);
      await f.close();
      f = await openH(root, false);
      await f.harness.broker.initialize();
      expect(f.harness.runner.starts).toHaveLength(0);
      const request = {
        delegationId: H_ID,
        operation: 'resume' as const,
        message: 'Idempotent resume prompt',
      };
      const caller = {
        ...H_PARENT,
        controlAuthor: 'user' as const,
        toolCallId: 'h-resume-once',
      };
      const operationId = '55555555-5555-4555-8555-555555555555';
      expect(
        await f.harness.broker.manage(caller, request, operationId),
      ).toMatchObject({ ok: true });
      expect(
        await f.harness.broker.manage(caller, request, operationId),
      ).toMatchObject({ ok: true });
      await hLaunch(f, 5);
      expect(f.harness.runner.starts).toHaveLength(1);
      expect(f.harness.runner.starts[0]).toMatchObject({
        runGeneration: 5,
        transcriptStream: { target: hTarget(H_ID, 5) },
      });
      expect(await f.storage.loadOne(H_ID)).toMatchObject({
        version: 3,
        state: { runGeneration: 5 },
        registration: { origin: { kind: 'resume' }, store: 'stream' },
      });
      expect(await f.port.generation(hTarget(H_ID, 6))).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
    } finally {
      await f.close();
    }
  });
});

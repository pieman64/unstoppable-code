import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArchivedContainerManifest } from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatStorageNewerFormatError } from '../lib/chat-delta-journal/format';
import {
  commitArchivedContainer,
  getArchivedContainerChatStorage,
} from '../lib/archived-containers';
import {
  getArchivedContainerChatArchivesPath,
  getArchivedContainerChatsPath,
  getArchivedContainerDir,
} from '../lib/paths';
import {
  encodeStreamDescriptor,
  parseStreamDescriptor,
  streamRegistryPaths,
} from '../lib/chat-delta-journal/stream-registry';
import { delegationStreamKey } from '../lib/transcript-stream-paths';
import * as mainProcessLogging from '../lib/main-process-logging';
import {
  ChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { getWorktreeChatTranscriptSeed } from '../services/chat-service';
import { portalChatTabsCache } from '../services/portal-chat-tabs-cache';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import {
  buildHLegacy,
  H_CHAT,
  H_ID,
  H_SCOPE,
  hFollow,
  openH,
} from './helpers/delegation-promotion-fixture';
import { sourceFixture, target } from './helpers/stream-closure-copy-fixture';
import {
  BODY_TEXT,
  OLD_TEXT,
  PAGED_TEXT,
  portableFixture,
} from './helpers/stream-portable-fixture';
import { snapshotFormat4Files } from './helpers/chat-format4-scope';

jest.mock('../portal/portal-event-bus', () => ({
  createPortalEvent: jest.fn(),
  enqueuePortalEvent: jest.fn(),
  isCanopyPortalActive: jest.fn(() => true),
}));

jest.mock('../services/portal-chat-tabs-cache', () => ({
  portalChatTabsCache: { read: jest.fn() },
}));

const mockedPortalChatTabsCache = jest.mocked(portalChatTabsCache);

jest.setTimeout(180_000);

const P9_PROJECT = 'p9-project';
const P9_OVERLAY_SCOPE = 'p9-overlay-scope';
const P9_CHILD_SCOPE = 'p9-child-scope';
const P9_OVERLAY_ARCHIVE = 'p9-overlay-archive';
const P9_CHILD_ARCHIVE = 'p9-child-archive';
const P9_CAPTURED_AT = '2026-10-20T00:00:00.000Z';

function archivedManifest(id: string): ArchivedContainerManifest {
  return {
    version: 1,
    id,
    kind: 'worktree',
    projectId: P9_PROJECT,
    name: 'Stream lifecycle acceptance archive',
    createdAt: P9_CAPTURED_AT,
    archivedAt: P9_CAPTURED_AT,
    retentionDays: 365,
    expiresAt: '2099-10-20T00:00:00.000Z',
    chatCount: 1,
    archivedChatCount: 0,
    executionCount: 0,
  };
}

function archivedStorage(projectId: string, archiveId: string): ChatStorageV2 {
  const directory = getArchivedContainerDir(projectId, archiveId);
  return new ChatStorageV2(directory, archiveId, [
    getArchivedContainerChatsPath(projectId, archiveId),
    getArchivedContainerChatArchivesPath(projectId, archiveId),
    join(directory, 'chat-journal.jsonl'),
  ]);
}

function sourcePaths(
  store: Awaited<ReturnType<typeof sourceFixture>>['store'],
): {
  tabs: string;
  archives: string;
  journal: string;
} {
  const [tabs, archives, journal] = store.descriptor().legacyPaths ?? [];
  if (!tabs || !archives || !journal)
    throw new Error('The stream fixture is missing its canonical paths');
  return { tabs, archives, journal };
}

describe('stream lifecycle acceptance controls', () => {
  let root = '';
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'stream-lifecycle-controls-'));
    previousDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = join(root, 'canopy-data');
    resetResolvedCanopyDataDirForTests();
    jest.clearAllMocks();
  });

  afterEach(async () => {
    resetChatStateServiceForTests();
    jest.restoreAllMocks();
    if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previousDataDir;
    resetResolvedCanopyDataDirForTests();
    await rm(root, { recursive: true, force: true });
  });

  it('does not route a mixed Portal seed stream card through the legacy log reader when option-off', async () => {
    await buildHLegacy(root);
    let fixture = await openH(root, true);
    try {
      await fixture.harness.broker.initialize();
      await hFollow(fixture, 4);
      await fixture.sync();
      await fixture.close();
      fixture = await openH(root, false);

      expect(await fixture.service.generationStoreReadiness(H_SCOPE)).toEqual({
        formatVersion: 4,
        enableFormat4: false,
      });
      expect(await fixture.storage.loadOne(H_ID)).toMatchObject({
        version: 3,
        state: { runGeneration: 4 },
      });

      resetChatStateServiceForTests(fixture.service);
      registerWorkspaceTypes(new Map());
      const state = await fixture.service.getState(H_SCOPE);
      expect(JSON.stringify(state.tabsFile)).toContain('chat-stream-v2');
      mockedPortalChatTabsCache.read.mockResolvedValue(state.tabsFile);
      const legacyRead = jest.spyOn(fixture.service, 'readDelegationItems');
      const warn = jest.spyOn(mainProcessLogging, 'logMainProcessWarn');

      const seed = await getWorktreeChatTranscriptSeed({
        workspaceId: H_SCOPE.projectId,
        worktreeId: H_SCOPE.worktreeId,
        chatId: H_CHAT,
      });

      expect(
        legacyRead.mock.calls.some(
          ([request]) =>
            request.delegationId === H_ID && request.runGeneration === 4,
        ),
      ).toBe(false);
      expect(
        warn.mock.calls.filter(
          ([message]) =>
            message ===
            '[chat-service] Unable to read a delegated task transcript',
        ),
      ).toHaveLength(0);
      expect(JSON.stringify(seed.messages)).toContain(H_ID);
    } finally {
      resetChatStateServiceForTests();
      await fixture.close();
    }
  });

  it('reads captured stream state, children, blocks and content through the real archived-container backend', async () => {
    const overlayRoot = join(root, 'overlay-source');
    const childRoot = join(root, 'child-source');
    const overlay = await sourceFixture(overlayRoot, P9_OVERLAY_SCOPE, false);
    const children = await portableFixture(childRoot, P9_CHILD_SCOPE);
    const overlayDescriptorPaths = streamRegistryPaths(
      join(overlay.store.directory, 'transcripts'),
      'chat',
      delegationStreamKey(target),
    );
    const overlayDescriptor = parseStreamDescriptor(
      await readFile(overlayDescriptorPaths.descriptor),
    );
    await writeFile(
      overlayDescriptorPaths.descriptor,
      encodeStreamDescriptor({
        ...overlayDescriptor,
        cardState: {
          version: 2,
          cardRevision: 1,
          canonical: {
            status: 'completed',
            resultIndex: 1,
            finalText: 'archive overlay answer',
          },
        },
      }),
    );
    const sourcePathByScope = new Map([
      [P9_OVERLAY_SCOPE, sourcePaths(overlay.store)],
      [P9_CHILD_SCOPE, sourcePaths(children.store)],
    ]);
    const repository = new ChatStateV2Repository({
      resolvePaths: (scope): ReturnType<typeof sourcePaths> => {
        const paths = sourcePathByScope.get(scope.worktreeId);
        if (!paths)
          throw new Error(
            `Unexpected archive capture scope: ${scope.worktreeId}`,
          );
        return paths;
      },
    });
    const service = new ChatStateService({ repository });
    const overlayScope = {
      projectId: P9_PROJECT,
      worktreeId: P9_OVERLAY_SCOPE,
    };
    const childScope = {
      projectId: P9_PROJECT,
      worktreeId: P9_CHILD_SCOPE,
    };

    try {
      const overlayManifest = archivedManifest(P9_OVERLAY_ARCHIVE);
      const childManifest = archivedManifest(P9_CHILD_ARCHIVE);
      await commitArchivedContainer(overlayManifest);
      await commitArchivedContainer(childManifest);
      // Match the archive capture's destination descriptor without selecting
      // it first: the getter migrates/initializes a destination on first use.
      const overlayDestination = archivedStorage(
        P9_PROJECT,
        P9_OVERLAY_ARCHIVE,
      );
      const childDestination = archivedStorage(P9_PROJECT, P9_CHILD_ARCHIVE);

      // These are repository captures, not hand-built archive copies.
      await service.captureStorageScope(overlayScope, overlayDestination);
      await service.captureStorageScope(childScope, childDestination);
      const overlayStore = await getArchivedContainerChatStorage(
        P9_PROJECT,
        P9_OVERLAY_ARCHIVE,
      );
      const childStore = await getArchivedContainerChatStorage(
        P9_PROJECT,
        P9_CHILD_ARCHIVE,
      );
      expect(await overlayStore.format()).toBe('v4');
      expect(await childStore.format()).toBe('v4');

      const sourceBefore = await Promise.all([
        snapshotFormat4Files(overlayRoot),
        snapshotFormat4Files(childRoot),
      ]);
      const archiveBefore = await Promise.all([
        snapshotFormat4Files(
          getArchivedContainerDir(P9_PROJECT, P9_OVERLAY_ARCHIVE),
        ),
        snapshotFormat4Files(
          getArchivedContainerDir(P9_PROJECT, P9_CHILD_ARCHIVE),
        ),
      ]);

      const state = await service.getTranscriptPage({
        ...overlayScope,
        chatId: 'chat',
        archivedContainerId: P9_OVERLAY_ARCHIVE,
      });
      expect(
        state.messages
          .find((row) => row.id === 'parent')
          ?.blocks.some(
            (block) =>
              block.type === 'delegated_agent_call' &&
              block.status === 'completed' &&
              block.finalText === 'archive overlay answer' &&
              block.transcriptStore === 'chat-stream-v2',
          ),
      ).toBe(true);

      const childRequest = {
        ...childScope,
        chatId: 'chat',
        target,
        archivedContainerId: P9_CHILD_ARCHIVE,
      };
      let page = await service.getTranscriptPage(childRequest);
      const allChildPages = [...page.messages];
      for (let pageNumber = 0; pageNumber < 5 && page.cursor; pageNumber += 1) {
        page = await service.getTranscriptPage({
          ...childRequest,
          cursor: page.cursor,
        });
        allChildPages.push(...page.messages);
      }
      expect(JSON.stringify(allChildPages)).toContain(OLD_TEXT);
      expect(page.cursor).toBeUndefined();

      const blocks = await service.getTranscriptBlocks({
        ...childRequest,
        messageId: 'row-1',
        firstBlockOrdinal: 0,
        limit: 22,
      });
      expect(blocks.blockCount).toBe(22);
      expect(blocks.blocks[0]).toEqual({
        type: 'text',
        text: 'first logical block',
      });
      expect(
        blocks.blocks.some(
          (block) =>
            block.type === 'text' &&
            block.textRef?.byteLength === Buffer.byteLength(PAGED_TEXT),
        ),
      ).toBe(true);
      expect(
        blocks.blocks.some(
          (block) =>
            block.type === 'tool_result' &&
            block.toolUseId === 'tool' &&
            block.toolName === 'Read',
        ),
      ).toBe(true);
      await expect(
        service.readTranscriptContent({
          ...childRequest,
          messageId: 'row-1',
          blockOrdinal: 21,
          field: 'output',
          requestId: 'p9-child-content',
          offset: 0,
          limit: 48,
        }),
      ).resolves.toMatchObject({ text: BODY_TEXT.slice(0, 48) });
      await expect(
        service.readDelegationItems({
          ...childScope,
          chatId: 'chat',
          delegationId: target.delegationId,
          runGeneration: target.runGeneration,
          archivedContainerId: P9_CHILD_ARCHIVE,
        }),
      ).rejects.toThrow(
        'Stream-backed delegation requires target-aware transcript reads',
      );

      expect(
        await Promise.all([
          snapshotFormat4Files(overlayRoot),
          snapshotFormat4Files(childRoot),
        ]),
      ).toEqual(sourceBefore);
      expect(
        await Promise.all([
          snapshotFormat4Files(
            getArchivedContainerDir(P9_PROJECT, P9_OVERLAY_ARCHIVE),
          ),
          snapshotFormat4Files(
            getArchivedContainerDir(P9_PROJECT, P9_CHILD_ARCHIVE),
          ),
        ]),
      ).toEqual(archiveBefore);

      const manifestBytes = await readFile(childStore.manifestPath, 'utf8');
      const parsedManifest: unknown = JSON.parse(manifestBytes);
      if (
        typeof parsedManifest !== 'object' ||
        parsedManifest === null ||
        Array.isArray(parsedManifest)
      )
        throw new Error('Expected a chat storage manifest');
      await writeFile(
        childStore.manifestPath,
        `${JSON.stringify({ ...parsedManifest, version: 5 })}\n`,
        'utf8',
      );
      const versionFiveBefore = await snapshotFormat4Files(
        getArchivedContainerDir(P9_PROJECT, P9_CHILD_ARCHIVE),
      );
      const versionFiveReader = new ChatStateService({ repository });
      await expect(
        versionFiveReader.getTranscriptPage({
          ...childScope,
          chatId: 'chat',
          archivedContainerId: P9_CHILD_ARCHIVE,
        }),
      ).rejects.toBeInstanceOf(ChatStorageNewerFormatError);
      expect(
        await snapshotFormat4Files(
          getArchivedContainerDir(P9_PROJECT, P9_CHILD_ARCHIVE),
        ),
      ).toEqual(versionFiveBefore);
      await writeFile(childStore.manifestPath, manifestBytes, 'utf8');

      await commitArchivedContainer({
        ...overlayManifest,
        restoredTo: {
          kind: 'worktree',
          id: 'p9-restored-worktree',
          restoredAt: P9_CAPTURED_AT,
        },
      });
      const restoredBefore = await snapshotFormat4Files(
        getArchivedContainerDir(P9_PROJECT, P9_OVERLAY_ARCHIVE),
      );
      const restoredReader = new ChatStateService({ repository });
      await expect(
        restoredReader.getTranscriptPage({
          ...overlayScope,
          chatId: 'chat',
          archivedContainerId: P9_OVERLAY_ARCHIVE,
        }),
      ).rejects.toThrow('Archived chat payloads have already been restored');
      expect(
        await snapshotFormat4Files(
          getArchivedContainerDir(P9_PROJECT, P9_OVERLAY_ARCHIVE),
        ),
      ).toEqual(restoredBefore);

      await rm(getArchivedContainerDir(P9_PROJECT, P9_OVERLAY_ARCHIVE), {
        recursive: true,
        force: true,
      });
      const purgedReader = new ChatStateService({ repository });
      await expect(
        purgedReader.getTranscriptPage({
          ...overlayScope,
          chatId: 'chat',
          archivedContainerId: P9_OVERLAY_ARCHIVE,
        }),
      ).rejects.toThrow();
    } finally {
      await service.drain();
      resetChatStateServiceForTests();
    }
  });
});

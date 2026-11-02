// CAN-4908: real reconciliation, guard, reader, copy and provenance assembly.
// Only host integrations (acceptance/network/workspace creation) are replaced.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ReaderModule from '../shared-containers/read/reader';
import type * as ReconciliationModule from '../shared-containers/reconciliation-service';
import type * as WorkspacePersistenceModule from '../lib/workspace-persistence';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import {
  isSharedContainerPublishedChat,
  type SharedContainerForkRequest,
} from '@canopy/protocol/shared-containers';
import { forkSharedContainer } from '../shared-containers/fork';
import { SharedContainerForkError } from '../shared-containers/fork/destination';
import { withSharedContainerForkGuard } from '../shared-containers/fork/fork-guard';
import {
  getSharedContainerForkProvenancePath,
  readSharedContainerForkProvenance,
} from '../shared-containers/fork/provenance';
import {
  getSharedContainerReader,
  SharedContainerReader,
} from '../shared-containers/read/reader';
import {
  getSharedContainerReconciliationService,
  SharedContainerReconciliationService,
} from '../shared-containers/reconciliation-service';
import { SharedContainerReplicaManager } from '../shared-containers/replica/manager';
import { fetchLatestSharedContainerRevision } from '../shared-containers/canopy-server-client';
import { getSharedContainerAcceptance } from '../shared-containers/acceptance-store';
import { createCoworkWorkspace } from '../lib/cowork-workspace-crud';
import { readWorkspaceOwnership } from '../lib/workspace-persistence';
import { readAllSidebarItems } from '../lib/sidebar-items';
import {
  registerWorkspaceExternalPaths,
  registerWorkspaceTypes,
} from '../lib/workspace-registry';
import { readNote, readPrompt } from '../lib/standalone-workspace-files';
import {
  getChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';
import { resolveAgentAttachmentsDir } from '../lib/agent-attachments';
import {
  buildSharedContainerCoworkFixture,
  buildSharedContainerReplicaFixture,
  fetchForSharedContainerFixture,
  transportForSharedContainerFixture,
  type SharedContainerReplicaFixture,
} from './fixtures/shared-container-replica-fixture';

jest.mock('../shared-containers/read/reader', () => ({
  ...jest.requireActual<typeof ReaderModule>(
    '../shared-containers/read/reader',
  ),
  getSharedContainerReader: jest.fn(),
}));
jest.mock('../shared-containers/reconciliation-service', () => ({
  ...jest.requireActual<typeof ReconciliationModule>(
    '../shared-containers/reconciliation-service',
  ),
  getSharedContainerReconciliationService: jest.fn(),
}));
jest.mock('../shared-containers/acceptance-store', () => ({
  getSharedContainerAcceptance: jest.fn(),
}));
jest.mock('../shared-containers/canopy-server-client', () => ({
  fetchLatestSharedContainerRevision: jest.fn(),
}));
jest.mock('../lib/cowork-workspace-crud', () => ({
  createCoworkWorkspace: jest.fn(),
  updateCoworkWorkspace: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  ...jest.requireActual<typeof WorkspacePersistenceModule>(
    '../lib/workspace-persistence',
  ),
  readWorkspaceOwnership: jest.fn(),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
  removeWorkspaceIndexEntry: jest.fn(),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordSessionDiagnostic: jest.fn(),
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../lib/org-cowork-binding-deps', () => ({
  isOrgCoworkOperationEligible: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../lib/org-project-materialization', () => ({
  getOrgProjectMaterialization: jest.fn(),
}));
jest.mock('../services/org-project-catalog-service', () => ({
  getOrgProjectCatalogService: jest.fn(),
}));
import { getOrgProjectMaterialization } from '../lib/org-project-materialization';
import { getOrgProjectCatalogService } from '../services/org-project-catalog-service';

import { W5CommitLogHost } from '../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../lib/w5-commit-log-file-store';
import { nodeW5FileStore } from '../lib/w5-file-store';
import { getWorkspacesRootDir } from '../lib/paths';
import type * as TsxWorkerThreads from '../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const INSTANCE = '33333333-3333-4333-8333-333333333333';
const binding = {
  type: 'organization' as const,
  organizationId: ORG,
  projectId: PROJECT,
  instanceId: INSTANCE,
  bindingGeneration: 1,
};
const sourceTime = '2026-09-02T10:30:00.000Z';
function barrier(): { reached: Promise<void>; release: () => void } {
  let release = (): void => {};
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

async function fixture(
  revision: number,
): Promise<SharedContainerReplicaFixture> {
  const { layout, blobs } = buildSharedContainerCoworkFixture();
  const note =
    revision === 2
      ? '# Revision two follow-up\n\nCall the customer on Friday. Ada added a scheduling detail.\n'
      : '# Follow-up note\n\nRevision one only.\n';
  layout.notes[0].title =
    revision === 2 ? 'Revision two follow-up' : 'Follow-up note';
  for (const blob of blobs) {
    if (blob.artifactId === 'note-artifact') blob.bytes = Buffer.from(note);
    if (blob.artifactId === 'prompt-artifact')
      blob.bytes = Buffer.from(`# Prompt revision ${revision}\n`);
    if (
      blob.artifactId === 'file-artifact' ||
      blob.artifactId === 'attachment-artifact'
    ) {
      blob.bytes = Buffer.from(`${blob.artifactId} revision ${revision}`);
      const hash = createHash('sha256').update(blob.bytes).digest('hex');
      if (blob.artifactId === 'file-artifact') blob.path = `files/${hash}`;
      else {
        blob.path = `attachments/${hash}`;
        layout.attachmentPaths = {
          [blob.path]: {
            artifactId: blob.artifactId,
            displayName: 'evidence.txt',
          },
        };
      }
    }
    if (blob.artifactId === 'chat-artifact' && revision === 2) {
      const chat: unknown = JSON.parse(blob.bytes.toString('utf8'));
      if (!isSharedContainerPublishedChat(chat))
        throw new Error('Invalid published chat fixture');
      chat.messages.push({
        messageId: 'message-2',
        chatId: 'chat-1',
        role: 'assistant',
        status: 'complete',
        text: 'Publisher added a scheduling detail at revision two.',
        createdAtMs: 2,
      });
      blob.bytes = Buffer.from(JSON.stringify(chat));
    }
  }
  layout.files[0].sizeBytes = String(
    blobs.find((b) => b.artifactId === 'file-artifact')?.bytes.length,
  );
  const built = await buildSharedContainerReplicaFixture({
    revisionId: `revision-${revision}`,
    revision,
    layout,
    plaintextArtifacts: blobs,
  });
  built.detail.organizationId = ORG;
  built.detail.access = 'organization';
  built.detail.organizationName = 'Acme';
  built.revision.revision.createdAt =
    revision === 2 ? sourceTime : '2026-09-01T10:00:00.000Z';
  return built;
}

describe('reviewed revision fork through reconciliation', () => {
  let temp: string;
  let destination: string;
  let upstream: SharedContainerReplicaFixture;
  let second: SharedContainerReplicaFixture;
  let service: SharedContainerReconciliationService;
  let manager: SharedContainerReplicaManager;
  const originalDataDir = process.env.CANOPY_DATA_DIR;
  let bound = false;
  let receiptHost: W5CommitLogHost | undefined;
  const request = (revisionId = 'revision-2'): SharedContainerForkRequest => ({
    containerId: 'container-1',
    revisionId,
    organizationId: ORG,
    sourceOwnerDisplayName: 'Ada',
    destination: {
      kind: 'new-workspace',
      owner: { kind: 'organization', organizationId: ORG },
    },
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    temp = await mkdtemp(join(tmpdir(), 'fork-revision-'));
    process.env.CANOPY_DATA_DIR = join(temp, 'data');
    resetResolvedCanopyDataDirForTests();
    destination = join(temp, 'cowork');
    bound = false;
    receiptHost = undefined;
    registerWorkspaceTypes(new Map([['copy', 'cowork']]));
    registerWorkspaceExternalPaths(new Map([['copy', destination]]));
    jest.mocked(createCoworkWorkspace).mockImplementation(async () => {
      await mkdir(destination, { recursive: true });
      return {
        id: 'copy',
        type: 'cowork',
        name: 'Work Entry',
        createdAt: '2026-10-22T00:00:00.000Z',
        color: '#000000',
        collapsed: false,
        order: 0,
      };
    });
    jest.mocked(readAllSidebarItems).mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'copy',
          type: 'cowork',
          name: 'Work Entry',
          color: '#000000',
          collapsed: false,
          order: 0,
        },
      ],
    });
    jest.mocked(readWorkspaceOwnership).mockImplementation(() =>
      Promise.resolve({
        authority: 'ok',
        type: 'cowork',
        ...(bound ? { owner: binding } : {}),
      }),
    );
    jest.mocked(getOrgProjectMaterialization).mockReturnValue({
      convertCoworkWorkspace: jest.fn(() => {
        bound = true;
        return Promise.resolve({
          ok: true,
          workspaceId: 'copy',
          owner: binding,
        });
      }),
      moveBackToPersonal: jest.fn(() => {
        bound = false;
        return Promise.resolve({ ok: true });
      }),
    } as never);
    jest.mocked(getOrgProjectCatalogService).mockReturnValue({
      refresh: jest.fn(() =>
        Promise.resolve({
          stale: false,
          error: null,
          projects: [
            {
              id: PROJECT,
              organizationId: ORG,
              kind: 'COWORK',
              state: 'ACTIVE',
              location: 'LOCAL',
              capabilities: { use: true },
              instance: { id: INSTANCE, state: 'READY' },
            },
          ],
        }),
      ),
    } as never);
    upstream = await fixture(1);
    second = await fixture(2);
    const transport: ReturnType<typeof transportForSharedContainerFixture> = {
      resolveLatest: (...args) =>
        transportForSharedContainerFixture(upstream).resolveLatest(...args),
      fetchRevision: (...args) =>
        transportForSharedContainerFixture(upstream).fetchRevision(...args),
      requestDownloadUrls: (...args) =>
        transportForSharedContainerFixture(upstream).requestDownloadUrls(
          ...args,
        ),
    };
    manager = new SharedContainerReplicaManager({
      rootDir: join(temp, 'replicas'),
      transport,
      fetchImpl: (input, init): Promise<Response> =>
        fetchForSharedContainerFixture(upstream)(input, init),
    });
    service = new SharedContainerReconciliationService(manager, transport);
    jest
      .mocked(getSharedContainerReader)
      .mockReturnValue(new SharedContainerReader(manager.store));
    jest
      .mocked(getSharedContainerReconciliationService)
      .mockReturnValue(service);
    jest.mocked(getSharedContainerAcceptance).mockResolvedValue({
      organizationId: ORG,
      access: 'organization',
      acceptedAt: '2026-09-01T11:00:00.000Z',
    });
    jest
      .mocked(fetchLatestSharedContainerRevision)
      .mockImplementation(() => Promise.resolve(upstream.detail));
    await service.open('container-1', ORG);
  });

  afterEach(async () => {
    await service.close('container-1');
    await getChatStateService().drain();
    resetChatStateServiceForTests();
    registerWorkspaceTypes(new Map());
    registerWorkspaceExternalPaths(new Map());
    await manager.purgeAll();
    __setDesktopW5FileStoreForTests(nodeW5FileStore);
    await receiptHost?.shutdown();
    await rm(temp, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    resetResolvedCanopyDataDirForTests();
  });

  async function promote(): Promise<void> {
    upstream = second;
    await expect(service.open('container-1', ORG, true)).resolves.toMatchObject(
      { revisionId: 'revision-2' },
    );
  }

  async function assertCopy(revision = 2): Promise<void> {
    const result = await forkSharedContainer(request(`revision-${revision}`));
    expect(bound).toBe(true);
    const noteFiles = await readdir(
      getCoworkManagedSubdir(destination, 'notes'),
    );
    const note = await readNote('copy', noteFiles[0].slice(0, -3));
    expect(note.content).toBe(
      revision === 2
        ? '# Revision two follow-up\n\nCall the customer on Friday. Ada added a scheduling detail.\n'
        : '# Follow-up note\n\nRevision one only.\n',
    );
    expect(note.meta.title).toBe(
      revision === 2 ? 'Revision two follow-up' : 'Follow-up note',
    );
    const promptFiles = await readdir(
      getCoworkManagedSubdir(destination, 'prompts'),
    );
    expect(
      (await readPrompt('copy', promptFiles[0].slice(0, -3))).content,
    ).toBe(`# Prompt revision ${revision}\n`);
    expect(
      await readFile(join(destination, 'evidence/approved.txt'), 'utf8'),
    ).toBe(`file-artifact revision ${revision}`);
    expect(
      await readFile(
        join(
          resolveAgentAttachmentsDir(result.projectId, result.worktreeId),
          'evidence.txt',
        ),
        'utf8',
      ),
    ).toBe(`attachment-artifact revision ${revision}`);
    const chats = await getChatStateService().getCompatibilityTabs(
      {
        projectId: result.projectId,
        worktreeId: result.worktreeId,
      },
      { chatIds: ['chat-1'], fullTranscript: true },
    );
    expect(JSON.stringify(chats)).toContain('Review the approved evidence.');
    if (revision === 2) {
      expect(JSON.stringify(chats)).toContain(
        'Publisher added a scheduling detail at revision two.',
      );
      expect(note.content).not.toContain('Revision one only');
    } else
      expect(JSON.stringify(chats)).not.toContain(
        'Publisher added a scheduling detail at revision two.',
      );
    const provenance = await readSharedContainerForkProvenance(
      getSharedContainerForkProvenancePath(result.projectId, result.worktreeId),
    );
    expect(provenance).toEqual(result.provenance);
    expect(provenance).toMatchObject({
      sourceRevisionId: `revision-${revision}`,
      sourceRevisionCreatedAt:
        revision === 2 ? sourceTime : '2026-09-01T10:00:00.000Z',
      organizationId: ORG,
    });
    expect(provenance?.forkedAt).not.toBe(sourceTime);
  }

  it('copies revision two notes, chats, prompts, files and attachments into a new organization project', async () => {
    await promote();
    await assertCopy();
  });

  it('refuses a superseded reviewed revision before creating a destination', async () => {
    await promote();
    await expect(
      forkSharedContainer(request('revision-1')),
    ).rejects.toMatchObject({
      name: 'SharedContainerForkError',
      code: 'source-unavailable',
      message:
        'Ada published a newer version of this share. Open it again, then make your copy.',
    });
    expect(createCoworkWorkspace).not.toHaveBeenCalled();
    await expect(
      readdir(join(getWorkspacesRootDir(), 'copy')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(destination)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses promotion between initial authorization and guard acquisition', async () => {
    const entered = barrier();
    const proceed = barrier();
    jest
      .mocked(fetchLatestSharedContainerRevision)
      .mockImplementationOnce(async () => {
        entered.release();
        await proceed.reached;
        return upstream.detail;
      });
    const copying = forkSharedContainer(request('revision-1'));
    const checked = expect(copying).rejects.toBeInstanceOf(
      SharedContainerForkError,
    );
    await entered.reached;
    await promote();
    proceed.release();
    await checked;
    expect(createCoworkWorkspace).not.toHaveBeenCalled();
    await expect(
      readdir(join(getWorkspacesRootDir(), 'copy')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses unreadable replicas without describing them as newer publications', async () => {
    await manager.purgeAll();
    await expect(
      forkSharedContainer(request('revision-1')),
    ).rejects.toMatchObject({
      code: 'source-unavailable',
      message:
        'The share is unavailable. Open the share again before making a copy.',
    });
    expect(createCoworkWorkspace).not.toHaveBeenCalled();
    await expect(
      readdir(join(getWorkspacesRootDir(), 'copy')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves access refusal before effects', async () => {
    jest
      .mocked(fetchLatestSharedContainerRevision)
      .mockRejectedValueOnce(new Error('Access revoked'));
    await expect(
      forkSharedContainer(request('revision-1')),
    ).rejects.toMatchObject({
      code: 'source-unavailable',
      message: 'The share is unavailable. The copy wasn’t made.',
    });
    expect(createCoworkWorkspace).not.toHaveBeenCalled();
    await expect(
      readdir(join(getWorkspacesRootDir(), 'copy')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([true, false])(
    'returns a typed refusal during an authorization transition (access retained: %p)',
    async (retainsAccess) => {
      const entered = barrier();
      const proceed = barrier();
      const snapshot = manager.withOrganizationSnapshotFence(
        retainsAccess ? [ORG] : [],
        async () => {
          if (!retainsAccess) {
            await manager.purge('container-1', {
              allowDuringAuthorizationTransition: true,
            });
          }
          entered.release();
          await proceed.reached;
        },
      );
      await entered.reached;
      const copy = jest.fn(() => Promise.resolve());
      try {
        await expect(
          withSharedContainerForkGuard(request('revision-1'), copy),
        ).rejects.toMatchObject({
          name: 'SharedContainerForkError',
          code: 'source-unavailable',
          message:
            'The share is unavailable. Open the share again before making a copy.',
        });
        expect(copy).not.toHaveBeenCalled();
        expect(createCoworkWorkspace).not.toHaveBeenCalled();
      } finally {
        proceed.release();
        await snapshot;
      }
    },
  );

  it('returns a typed refusal if authorization changes while the read guard waits for the lock', async () => {
    const entered = barrier();
    const proceed = barrier();
    const holding = manager.withReplicaReadGuard(
      'container-1',
      ORG,
      'revision-1',
      async () => {
        entered.release();
        await proceed.reached;
      },
    );
    await entered.reached;
    const snapshot = manager.withOrganizationSnapshotFence([ORG], () =>
      Promise.resolve(),
    );
    const copy = jest.fn(() => Promise.resolve());
    const checked = expect(
      withSharedContainerForkGuard(request('revision-1'), copy),
    ).rejects.toMatchObject({
      name: 'SharedContainerForkError',
      code: 'source-unavailable',
    });
    proceed.release();
    await Promise.all([holding, snapshot, checked]);
    expect(copy).not.toHaveBeenCalled();
  });

  it('does not translate or retry an abort from the copy operation', async () => {
    const failure = new DOMException('Copy interrupted', 'AbortError');
    const copy = jest.fn(() => Promise.reject(failure));
    await expect(
      withSharedContainerForkGuard(request('revision-1'), copy),
    ).rejects.toBe(failure);
    expect(copy).toHaveBeenCalledTimes(1);
  });

  it('does not translate filesystem failures by matching their message', async () => {
    const failure = new Error('Shared-container revision is not available');
    jest
      .spyOn(manager.store, 'resolveRevisionRootForRead')
      .mockRejectedValueOnce(failure);
    await expect(forkSharedContainer(request('revision-1'))).rejects.toBe(
      failure,
    );
    expect(createCoworkWorkspace).not.toHaveBeenCalled();
    await expect(
      readdir(join(getWorkspacesRootDir(), 'copy')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses malformed publication metadata before effects instead of dropping the anchor', async () => {
    const state = await manager.getState('container-1');
    if (state?.status !== 'available')
      throw new Error('Expected readable revision');
    await manager.store.set({ ...state, revisionCreatedAt: 'invalid' });
    await expect(forkSharedContainer(request('revision-1'))).rejects.toThrow(
      'Invalid shared-container revision publication time',
    );
    expect(createCoworkWorkspace).not.toHaveBeenCalled();
    await expect(
      readdir(join(getWorkspacesRootDir(), 'copy')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses duplicate in-flight submissions and replays the exact anchored result after completion', async () => {
    await promote();
    receiptHost = new W5CommitLogHost({
      dbPath: join(temp, 'w5', 'commit-log.sqlite'),
      root: getWorkspacesRootDir(),
      workerEntry: join(__dirname, '../w5-commit-log/commit-log-worker.ts'),
    });
    const host = receiptHost;
    __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));

    const entered = barrier();
    const proceed = barrier();
    const create = jest.mocked(createCoworkWorkspace).getMockImplementation();
    if (!create) throw new Error('Missing workspace host');
    jest
      .mocked(createCoworkWorkspace)
      .mockImplementationOnce(async (...args) => {
        entered.release();
        await proceed.reached;
        return create(...args);
      });
    const command = { ...request(), idempotencyKey: 'can-4908-copy' };
    const copying = forkSharedContainer(command);
    await Promise.race([
      entered.reached,
      copying.then(() => {
        throw new Error('Copy completed before the barrier');
      }),
    ]);
    try {
      await expect(forkSharedContainer(command)).rejects.toMatchObject({
        reason: 'in-progress',
      });
    } finally {
      proceed.release();
    }
    const result = await copying;
    await expect(forkSharedContainer(command)).resolves.toEqual(result);
    expect(result.provenance).toMatchObject({
      sourceRevisionId: 'revision-2',
      sourceRevisionCreatedAt: sourceTime,
    });
    expect(createCoworkWorkspace).toHaveBeenCalledTimes(1);
  });

  it('keeps the guarded revision usable until copying finishes while promotion waits', async () => {
    const entered = barrier();
    const proceed = barrier();
    jest
      .mocked(fetchLatestSharedContainerRevision)
      .mockImplementationOnce(() => Promise.resolve(upstream.detail))
      .mockImplementationOnce(async () => {
        entered.release();
        await proceed.reached;
        return upstream.detail;
      });
    const copying = assertCopy(1);
    await entered.reached;
    upstream = second;
    const promotion = service.open('container-1', ORG, true);
    proceed.release();
    const settled = await Promise.allSettled([copying, promotion]);
    for (const item of settled)
      if (item.status === 'rejected') throw item.reason;
    expect(await promotion).toMatchObject({ revisionId: 'revision-2' });
  });
});

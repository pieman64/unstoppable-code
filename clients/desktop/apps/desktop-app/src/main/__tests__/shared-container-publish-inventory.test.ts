import { readChatTabsFileForIndex } from '../lib/chat-tabs-reader';
import {
  buildCoworkPublishInventory,
  collectCoworkChatAttachmentSourcePaths,
  readChatTabs,
} from '../shared-containers/publish/inventory';
import { SharedContainerPublishRefusalError } from '../shared-containers/publish/errors';
import { SharedContainerPublishInventoryChangedError } from '../shared-containers/publish/source-files';
import {
  mkdir,
  link,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import type * as FsPromisesModule from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import {
  getCoworkManagedDirCandidates,
  getCoworkManagedSubdir,
} from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { getCoworkWorkspaceRootDir } from '../lib/paths';
import { resolveAgentAttachmentsDir } from '../lib/agent-attachments';
import { resolveChatTabsFilePath } from '../lib/resolve-worktree';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import { MAX_SHARED_CONTAINER_ARTIFACT_BYTES } from '@canopy/protocol/shared-containers';
import { getChatStateService } from '../services/chat-state-service';
import { selectSharedContainerCandidatePaths } from '../shared-containers/publish/cowork-files';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import { writeSharedContainerFileScope } from '../shared-containers/file-scope-store';
import { panelLayoutPersistenceStore } from '../panels/persistence';
import type { SerializablePanelLayoutFile } from '@canopy/protocol/panels';
import type * as ObservabilityModule from '../observability';

jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
  return { ...actual, open: jest.fn(actual.open) };
});

// Chat-state diagnostics flush asynchronously after inventory reads. Keep this
// unrelated writer from racing removal of the spec's temporary data directory.
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordSessionDiagnostic: jest.fn(),
    recordAppDiagnostic: jest.fn(),
  })),
}));

describe('Cowork shared-container publish inventory', () => {
  afterAll(() => {
    // These fixtures delete their data directories. A real diagnostic writer
    // can flush later and recreate files while cleanup is removing them.
    const { peekObservabilityService } =
      jest.requireActual<typeof ObservabilityModule>('../observability');
    expect(peekObservabilityService() === null).toBe(true);
  });

  it('continues first-fit selection after a candidate exceeds the byte budget', () => {
    expect(
      selectSharedContainerCandidatePaths(
        'CODE_WORKTREE',
        ['too-large.bin', 'fits.txt'],
        { includedPaths: [] },
        2,
        { 'too-large.bin': 11, 'fits.txt': 4 },
        10,
      ),
    ).toEqual(['fits.txt']);
  });

  it('does not inventory attachments referenced only by hidden messages', () => {
    expect(
      collectCoworkChatAttachmentSourcePaths([
        {
          id: 'chat-1',
          title: 'Chat',
          createdAt: 'now',
          messages: [
            {
              id: 'visible',
              role: 'user',
              timestamp: 'now',
              blocks: [],
              attachmentPaths: ['/attachments/visible.txt'],
            },
            {
              id: 'hidden',
              role: 'user',
              timestamp: 'now',
              blocks: [],
              hidden: true,
              attachmentPaths: ['/attachments/hidden.txt'],
            },
          ],
        },
      ]),
    ).toEqual(['/attachments/visible.txt']);
  });

  it('counts UTF-16LE tool-output references by their stored byte length', async () => {
    const service = getChatStateService();
    const reference = {
      version: 1 as const,
      artifactId: `sha256-v1-${'a'.repeat(64)}`,
      byteLength: MAX_SHARED_CONTAINER_ARTIFACT_BYTES + 1,
      sha256: 'a'.repeat(64),
      encoding: 'utf-16le' as const,
      mediaType: 'text/plain' as const,
    };
    const persisted = {
      id: 'message-1',
      role: 'assistant' as const,
      timestamp: 1,
      blocks: [
        {
          type: 'tool_result' as const,
          toolUseId: 'tool-1',
          toolName: 'Read',
          output: 'preview',
          isError: false,
          outputTruncated: true,
          fullOutputRef: reference,
        },
      ],
    };
    const getCompatibilityTabs = jest
      .spyOn(service, 'getCompatibilityTabs')
      .mockResolvedValue({
        version: 1,
        activeTabId: 'chat-1',
        tabs: [
          {
            id: 'chat-1',
            title: 'Chat',
            createdAt: 'now',
            messages: [],
            transcript: {
              format: 'complete-message-jsonl-v1',
              committedMessageCount: 1,
              committedByteLength: 1,
              transcriptRevision: 1,
              hasActiveSidecar: false,
            },
          },
        ],
      });
    const consumeTranscript = jest
      .spyOn(service, 'consumeTranscript')
      .mockImplementation(async (_scope, _chatId, _fullOutputs, consume) =>
        consume(
          (async function* (): AsyncGenerator<typeof persisted> {
            yield await Promise.resolve(persisted);
          })(),
        ),
      );
    try {
      await expect(readChatTabs('workspace', 'worktree')).rejects.toThrow(
        SharedContainerPublishRefusalError,
      );
    } finally {
      getCompatibilityTabs.mockRestore();
      consumeTranscript.mockRestore();
    }
  });

  it('does not count visual bytes toward the published chat-size budget', async () => {
    const service = getChatStateService();
    const persisted: PersistedChatMessage = {
      id: 'message-1',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'tool-1',
          toolName: 'Read',
          output: 'preview',
          isError: false,
          visualRef: {
            version: 1,
            visualId: 'vis_00000000-0000-4000-8000-000000000001',
            artifactId: `sha256-v1-${'b'.repeat(64)}`,
            byteLength: MAX_SHARED_CONTAINER_ARTIFACT_BYTES + 1,
            sha256: 'b'.repeat(64),
            mediaType: 'text/html',
            title: 'A visual',
            maxHeight: 600,
          },
        },
      ],
    };
    const getCompatibilityTabs = jest
      .spyOn(service, 'getCompatibilityTabs')
      .mockResolvedValue({
        version: 1,
        activeTabId: 'chat-1',
        tabs: [
          {
            id: 'chat-1',
            title: 'Chat',
            createdAt: 'now',
            messages: [],
            transcript: {
              format: 'complete-message-jsonl-v1',
              committedMessageCount: 1,
              committedByteLength: 1,
              transcriptRevision: 1,
              hasActiveSidecar: false,
            },
          },
        ],
      });
    const consumeTranscript = jest
      .spyOn(service, 'consumeTranscript')
      .mockImplementation(async (_scope, _chatId, _fullOutputs, consume) =>
        consume(
          (async function* (): AsyncGenerator<PersistedChatMessage> {
            yield await Promise.resolve(persisted);
          })(),
        ),
      );
    try {
      await expect(
        readChatTabs('workspace', 'worktree'),
      ).resolves.toBeDefined();
    } finally {
      getCompatibilityTabs.mockRestore();
      consumeTranscript.mockRestore();
    }
  });

  it('publishes delegated tasks with their children from the delegate log', async () => {
    const service = getChatStateService();
    const getCompatibilityTabs = jest
      .spyOn(service, 'getCompatibilityTabs')
      .mockResolvedValue({
        version: 1,
        activeTabId: 'chat-1',
        tabs: [
          {
            id: 'chat-1',
            title: 'Chat',
            createdAt: 'now',
            messages: [],
            transcript: {
              format: 'complete-message-jsonl-v1',
              committedMessageCount: 1,
              committedByteLength: 1,
              transcriptRevision: 1,
              hasActiveSidecar: false,
            },
          },
        ],
      });
    const consumeTranscript = jest
      .spyOn(service, 'consumeTranscript')
      .mockImplementation(async (_scope, _chatId, _fullOutputs, consume) =>
        consume((async function* (): AsyncGenerator<never> {})()),
      );
    try {
      await readChatTabs('workspace', 'worktree');
      // Both the size check and the published read carry the children: the
      // published copy has no delegate log.
      expect(consumeTranscript).toHaveBeenCalledTimes(2);
      for (const call of consumeTranscript.mock.calls)
        expect(call[4]).toEqual({ inlineDelegationChildren: true });
    } finally {
      getCompatibilityTabs.mockRestore();
      consumeTranscript.mockRestore();
    }
  });

  it('includes every chat, defaults notes and prompts on, and honors exclusions', async () => {
    const inventory = await buildCoworkPublishInventory(
      {
        projectId: 'workspace-1',
        worktreeId: 'entry-1',
        scope: {
          includedPaths: ['approved.txt'],
          excludedNoteIds: ['note-1'],
        },
      },
      {
        readChatTabs: () =>
          Promise.resolve({
            version: 1,
            activeTabId: 'chat-1',
            tabs: [
              { id: 'chat-1', title: 'Chat', createdAt: 'now', messages: [] },
              {
                id: 'file-1',
                title: 'File',
                createdAt: 'now',
                kind: 'file',
                messages: [],
              },
            ],
          }),
        listAttachments: () =>
          Promise.resolve([
            { displayName: 'image.png', bytes: Buffer.from('image') },
          ]),
        listNotes: () =>
          Promise.resolve([
            { id: 'note-1', title: 'One' },
            { id: 'note-2', title: 'Two' },
          ]),
        readNote: (_projectId, id) =>
          Promise.resolve({
            meta: { id, title: id },
            content: `note:${id}`,
          }),
        listPrompts: () =>
          Promise.resolve([{ id: 'prompt-1', title: 'Prompt' }]),
        readPrompt: (_projectId, id) =>
          Promise.resolve({
            meta: { id, title: id },
            content: `prompt:${id}`,
          }),
        readWorkspaceFile: (_projectId, path) =>
          Promise.resolve({
            path,
            bytes: Buffer.from(`file:${path}`),
          }),
        resolveStartPage: () =>
          Promise.resolve({
            startPage: { kind: 'file', path: 'approved.txt' },
            source: 'cowork',
          }),
      },
    );

    expect(inventory.chats.map((chat) => chat.id)).toEqual(['chat-1']);
    expect(inventory.notes.map((note) => note.meta.id)).toEqual(['note-2']);
    expect(inventory.prompts.map((prompt) => prompt.meta.id)).toEqual([
      'prompt-1',
    ]);
    expect(inventory.files.map((file) => file.path)).toEqual(['approved.txt']);
    expect(inventory.attachments.map((item) => item.displayName)).toEqual([
      'image.png',
    ]);
    expect(inventory.startPage).toEqual({
      kind: 'file',
      repoId: 'workspace',
      relativePath: 'approved.txt',
    });
  });

  it('caps default Cowork files to the remaining artifact budget', async () => {
    const inventory = await buildCoworkPublishInventory(
      {
        projectId: 'workspace-1',
        worktreeId: 'entry-1',
        scope: { includedPaths: [], excludedPaths: [] },
      },
      {
        readChatTabs: () =>
          Promise.resolve({
            version: 1,
            activeTabId: 'chat-0',
            tabs: Array.from({ length: 198 }, (_, index) => ({
              id: `chat-${index}`,
              title: `Chat ${index}`,
              createdAt: 'now',
              messages: [],
            })),
          }),
        listAttachments: () => Promise.resolve([]),
        listNotes: () => Promise.resolve([]),
        readNote: (_projectId, id) =>
          Promise.resolve({ meta: { id, title: id }, content: '' }),
        listPrompts: () => Promise.resolve([]),
        readPrompt: (_projectId, id) =>
          Promise.resolve({ meta: { id, title: id }, content: '' }),
        listCoworkCandidateFiles: () =>
          Promise.resolve({
            paths: ['first.txt', 'past-budget.txt'],
            withheldFileCount: 2,
          }),
        readWorkspaceFile: (_projectId, path) =>
          Promise.resolve({ path, bytes: Buffer.from(path) }),
      },
    );

    expect(inventory.files.map((file) => file.path)).toEqual(['first.txt']);
    expect(inventory).toMatchObject({ withheldFileCount: 2 });
  });

  it('does not silently cap a legacy Cowork allowlist', async () => {
    const inventory = await buildCoworkPublishInventory(
      {
        projectId: 'workspace-1',
        worktreeId: 'entry-1',
        scope: { includedPaths: ['first.txt', 'over-budget.txt'] },
      },
      {
        readChatTabs: () =>
          Promise.resolve({
            version: 1,
            activeTabId: 'chat-0',
            tabs: Array.from({ length: 198 }, (_, index) => ({
              id: `chat-${index}`,
              title: `Chat ${index}`,
              createdAt: 'now',
              messages: [],
            })),
          }),
        listAttachments: () => Promise.resolve([]),
        listNotes: () => Promise.resolve([]),
        readNote: (_projectId, id) =>
          Promise.resolve({ meta: { id, title: id }, content: '' }),
        listPrompts: () => Promise.resolve([]),
        readPrompt: (_projectId, id) =>
          Promise.resolve({ meta: { id, title: id }, content: '' }),
        listCoworkCandidateFiles: () =>
          Promise.resolve({
            paths: ['first.txt', 'over-budget.txt'],
            withheldFileCount: 0,
          }),
        readWorkspaceFile: (_projectId, path) =>
          Promise.resolve({ path, bytes: Buffer.from(path) }),
      },
    );

    expect(inventory.files.map((file) => file.path)).toEqual([
      'first.txt',
      'over-budget.txt',
    ]);
  });

  it('publishes legacy allowlisted paths outside the bounded candidate ranking', async () => {
    const inventory = await buildCoworkPublishInventory(
      {
        projectId: 'workspace-1',
        worktreeId: 'entry-1',
        scope: { includedPaths: ['ranked-out.txt'] },
      },
      {
        readChatTabs: () =>
          Promise.resolve({ version: 1, activeTabId: null, tabs: [] }),
        listAttachments: () => Promise.resolve([]),
        listNotes: () => Promise.resolve([]),
        readNote: (_projectId, id) =>
          Promise.resolve({ meta: { id, title: id }, content: '' }),
        listPrompts: () => Promise.resolve([]),
        readPrompt: (_projectId, id) =>
          Promise.resolve({ meta: { id, title: id }, content: '' }),
        listCoworkCandidateFiles: (_projectId, _worktreeId, requiredPaths) =>
          Promise.resolve({
            paths: ['ranked-in.txt', ...(requiredPaths ?? [])],
            withheldFileCount: 0,
          }),
        readWorkspaceFile: (_projectId, path) =>
          Promise.resolve({ path, bytes: Buffer.from(path) }),
      },
    );

    expect(inventory.files.map((file) => file.path)).toEqual([
      'ranked-out.txt',
    ]);
  });

  it('caps default Cowork files before they exhaust the revision byte budget', async () => {
    const paths = Array.from({ length: 20 }, (_, index) => `file-${index}.bin`);
    const inventory = await buildCoworkPublishInventory(
      {
        projectId: 'workspace-1',
        worktreeId: 'entry-1',
        scope: { includedPaths: [], excludedPaths: [] },
      },
      {
        readChatTabs: () =>
          Promise.resolve({ version: 1, activeTabId: null, tabs: [] }),
        listAttachments: () => Promise.resolve([]),
        listNotes: () => Promise.resolve([]),
        readNote: (_projectId, id) =>
          Promise.resolve({ meta: { id, title: id }, content: '' }),
        listPrompts: () => Promise.resolve([]),
        readPrompt: (_projectId, id) =>
          Promise.resolve({ meta: { id, title: id }, content: '' }),
        listCoworkCandidateFiles: () =>
          Promise.resolve({
            paths,
            sizeBytesByPath: Object.fromEntries(
              paths.map((path) => [path, MAX_SHARED_CONTAINER_ARTIFACT_BYTES]),
            ),
            withheldFileCount: 0,
          }),
        readWorkspaceFile: (_projectId, path) =>
          Promise.resolve({
            path,
            source: {
              sizeBytes: MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
              hash: `sha256:${path}`,
              createReadStream: () => Readable.from([]),
            },
          }),
      },
    );

    expect(inventory.files.map((file) => file.path)).toEqual(
      paths.slice(0, 19),
    );
  });

  it('does not reserve 25 MiB for every tiny Cowork chat', async () => {
    const inventory = await buildCoworkPublishInventory(
      {
        projectId: 'workspace-1',
        worktreeId: 'entry-1',
        scope: { includedPaths: [], excludedPaths: [] },
      },
      {
        readChatTabs: () =>
          Promise.resolve({
            version: 1,
            activeTabId: 'chat-0',
            tabs: Array.from({ length: 19 }, (_, index) => ({
              id: `chat-${index}`,
              title: `Chat ${index}`,
              createdAt: 'now',
              messages: [],
            })),
          }),
        listAttachments: () => Promise.resolve([]),
        listNotes: () => Promise.resolve([]),
        readNote: (_projectId, id) =>
          Promise.resolve({ meta: { id, title: id }, content: '' }),
        listPrompts: () => Promise.resolve([]),
        readPrompt: (_projectId, id) =>
          Promise.resolve({ meta: { id, title: id }, content: '' }),
        listCoworkCandidateFiles: () =>
          Promise.resolve({
            paths: ['evidence.txt'],
            sizeBytesByPath: { 'evidence.txt': 8 },
            withheldFileCount: 0,
          }),
        readWorkspaceFile: (_projectId, path) =>
          Promise.resolve({ path, bytes: Buffer.from('evidence') }),
      },
    );

    expect(inventory.files.map((file) => file.path)).toEqual(['evidence.txt']);
  });

  it('treats a missing chat-tabs file as an empty transcript', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-publish-empty-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-empty-project';
    const worktreeId = 'entry-1';
    registerWorkspaceTypes(new Map([[projectId, 'cowork']]));
    try {
      const inventory = await buildCoworkPublishInventory({
        projectId,
        worktreeId,
        scope: { includedPaths: [] },
      });

      expect(inventory).toEqual({
        chats: [],
        attachments: [],
        notes: [],
        prompts: [],
        files: [],
      });
    } finally {
      registerWorkspaceTypes(new Map());
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('fails closed when an indexed transcript disappears during publication', async () => {
    const service = getChatStateService();
    const getCompatibilityTabs = jest
      .spyOn(service, 'getCompatibilityTabs')
      .mockResolvedValue({
        version: 1,
        activeTabId: 'chat-1',
        tabs: [
          {
            id: 'chat-1',
            title: 'Chat',
            createdAt: 'now',
            messages: [],
            transcript: {
              format: 'complete-message-jsonl-v1',
              committedMessageCount: 1,
              committedByteLength: 1,
              transcriptRevision: 1,
              hasActiveSidecar: false,
            },
          },
        ],
      });
    const missingTranscript = Object.assign(
      new Error('indexed transcript disappeared'),
      { code: 'ENOENT' },
    );
    const consumeTranscript = jest
      .spyOn(service, 'consumeTranscript')
      .mockRejectedValue(missingTranscript);

    try {
      await expect(readChatTabs('workspace', 'worktree')).rejects.toBe(
        missingTranscript,
      );
    } finally {
      getCompatibilityTabs.mockRestore();
      consumeTranscript.mockRestore();
    }
  });

  it('publishes walked Cowork files by default and subtracts exclusions', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-publish-files-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-default-files-project';
    const worktreeId = 'entry-1';
    registerWorkspaceTypes(new Map([[projectId, 'cowork']]));
    try {
      const root = getCoworkWorkspaceRootDir(projectId);
      await mkdir(join(root, 'nested'), { recursive: true });
      await writeFile(join(root, 'hello.md'), 'hello\n');
      await writeFile(join(root, 'nested', 'second.txt'), 'second\n');

      const defaultInventory = await buildCoworkPublishInventory({
        projectId,
        worktreeId,
        scope: { includedPaths: [] },
      });
      expect(defaultInventory.files.map((file) => file.path).sort()).toEqual([
        'hello.md',
        'nested/second.txt',
      ]);

      const excludedInventory = await buildCoworkPublishInventory({
        projectId,
        worktreeId,
        scope: {
          includedPaths: [],
          excludedPaths: ['nested/second.txt'],
        },
      });
      expect(excludedInventory.files.map((file) => file.path)).toEqual([
        'hello.md',
      ]);
    } finally {
      registerWorkspaceTypes(new Map());
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('ships the pinned preferred layout for a Cowork entry, and none once it is off', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-publish-layout-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-layout-project';
    const worktreeId = 'entry-1';
    registerWorkspaceTypes(new Map([[projectId, 'cowork']]));
    const chatLayout = (chatTabId: string): SerializablePanelLayoutFile => ({
      version: 1,
      grid: {
        orientation: 1,
        width: 1200,
        height: 800,
        root: {
          type: 'leaf',
          groupId: 'group-1',
          size: 1200,
          activePanelId: 'panel-1',
          panels: [
            { panelId: 'panel-1', kind: 'chat', instance: { chatTabId } },
          ],
        },
      },
      activeGroupId: 'group-1',
      mostRecentActiveGroupIds: ['group-1'],
    });
    const build = (): ReturnType<typeof buildCoworkPublishInventory> =>
      buildCoworkPublishInventory(
        { projectId, worktreeId, scope: { includedPaths: [] } },
        {
          readChatTabs: () =>
            Promise.resolve({
              version: 1,
              activeTabId: 'chat-1',
              tabs: [
                { id: 'chat-1', title: 'One', createdAt: 'now', messages: [] },
                { id: 'chat-2', title: 'Two', createdAt: 'now', messages: [] },
              ],
            }),
          listAttachments: () => Promise.resolve([]),
          listNotes: () => Promise.resolve([]),
          readNote: () => Promise.reject(new Error('no notes')),
          listPrompts: () => Promise.resolve([]),
          readPrompt: () => Promise.reject(new Error('no prompts')),
        },
      );
    try {
      await mkdir(getCoworkWorkspaceRootDir(projectId), { recursive: true });
      panelLayoutPersistenceStore.saveWorktreeLayout(
        projectId,
        worktreeId,
        chatLayout('chat-1'),
      );

      // The Cowork publish reads the same scope file, so its first publish
      // pins the layout exactly as a code worktree's does.
      expect((await build()).layout).toMatchObject({
        orientation: 1,
        root: { tabs: [{ kind: 'chat', chatId: 'chat-1' }] },
      });

      // The pin ships, not the live layout.
      panelLayoutPersistenceStore.saveWorktreeLayout(
        projectId,
        worktreeId,
        chatLayout('chat-2'),
      );
      expect((await build()).layout).toMatchObject({
        orientation: 1,
        root: { tabs: [{ kind: 'chat', chatId: 'chat-1' }] },
      });

      await writeSharedContainerFileScope(projectId, worktreeId, {
        includedPaths: [],
        preferredLayout: { enabled: false },
      });
      expect(await build()).not.toHaveProperty('layout');
    } finally {
      registerWorkspaceTypes(new Map());
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('matches NFC Cowork exclusions to decomposed filesystem paths', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-publish-unicode-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-unicode-files-project';
    const worktreeId = 'entry-1';
    const nfdPath = 'cafe\u0301.txt';
    const nfcPath = 'caf\u00e9.txt';
    registerWorkspaceTypes(new Map([[projectId, 'cowork']]));
    try {
      const root = getCoworkWorkspaceRootDir(projectId);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, nfdPath), 'private\n');

      const inventory = await buildCoworkPublishInventory({
        projectId,
        worktreeId,
        scope: { includedPaths: [], excludedPaths: [nfcPath] },
      });

      expect(inventory.files).toEqual([]);
    } finally {
      registerWorkspaceTypes(new Map());
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a Cowork file swapped to a hard link before publication reads it', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-publish-hardlink-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-hardlink-publish-project';
    const worktreeId = 'entry-1';
    const actualOpen =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises').open;
    registerWorkspaceTypes(new Map([[projectId, 'cowork']]));
    try {
      const root = getCoworkWorkspaceRootDir(projectId);
      const approvedPath = join(root, 'innocent.txt');
      const outsidePath = join(dataDir, 'outside-secret.txt');
      await mkdir(root, { recursive: true });
      await writeFile(approvedPath, 'safe\n');
      await writeFile(outsidePath, 'secret\n');
      const canonicalApprovedPath = await realpath(approvedPath);
      jest.mocked(open).mockImplementation(async (...args) => {
        if (args[0] === canonicalApprovedPath) {
          jest.mocked(open).mockImplementation(actualOpen);
          await rm(approvedPath);
          await link(outsidePath, approvedPath);
        }
        return actualOpen(...args);
      });

      await expect(
        buildCoworkPublishInventory({
          projectId,
          worktreeId,
          scope: { includedPaths: ['innocent.txt'] },
        }),
      ).rejects.toBeInstanceOf(SharedContainerPublishInventoryChangedError);
    } finally {
      jest.mocked(open).mockImplementation(actualOpen);
      registerWorkspaceTypes(new Map());
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed persisted chat tabs before building artifacts', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-publish-malformed-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-malformed-project';
    const worktreeId = 'entry-1';
    try {
      const chatTabsPath = resolveChatTabsFilePath(projectId, worktreeId);
      await mkdir(dirname(chatTabsPath), { recursive: true });
      await writeFile(
        chatTabsPath,
        JSON.stringify({ tabs: 'invalid' }),
        'utf8',
      );

      await expect(
        buildCoworkPublishInventory({
          projectId,
          worktreeId,
          scope: { includedPaths: [] },
        }),
      ).rejects.toThrow('Unable to recover legacy chat snapshot');
    } finally {
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('omits an approved file that was deleted before the publish scan', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-publish-deleted-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-deleted-project';
    const worktreeId = 'entry-1';
    try {
      const root = getCoworkWorkspaceRootDir(projectId);
      await mkdir(root, { recursive: true });
      const chatTabsPath = resolveChatTabsFilePath(projectId, worktreeId);
      await mkdir(dirname(chatTabsPath), { recursive: true });
      await writeFile(
        chatTabsPath,
        JSON.stringify({ version: 1, activeTabId: '', tabs: [] }),
        'utf8',
      );

      await expect(
        buildCoworkPublishInventory({
          projectId,
          worktreeId,
          scope: { includedPaths: ['deleted.txt'] },
        }),
      ).resolves.toEqual({
        chats: [],
        attachments: [],
        notes: [],
        prompts: [],
        files: [],
      });
    } finally {
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps approved file plaintext out of the in-memory inventory', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-publish-streamed-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-streamed-project';
    const worktreeId = 'entry-1';
    try {
      const root = getCoworkWorkspaceRootDir(projectId);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'approved.txt'), 'approved', 'utf8');
      const chatTabsPath = resolveChatTabsFilePath(projectId, worktreeId);
      await mkdir(dirname(chatTabsPath), { recursive: true });
      await writeFile(
        chatTabsPath,
        JSON.stringify({ version: 1, activeTabId: '', tabs: [] }),
        'utf8',
      );

      const inventory = await buildCoworkPublishInventory({
        projectId,
        worktreeId,
        scope: { includedPaths: ['approved.txt'] },
      });

      expect(inventory.files).toHaveLength(1);
      expect(inventory.files[0]).not.toHaveProperty('bytes');
      const source = (
        inventory.files[0] as unknown as {
          source?: {
            sizeBytes: number;
            hash: string;
            createReadStream: () => AsyncIterable<Buffer | string>;
          };
        }
      ).source;
      if (!source) throw new Error('Missing approved file source');
      expect(source.sizeBytes).toBe(8);
      expect(source.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      const chunks: Buffer[] = [];
      for await (const chunk of source.createReadStream()) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString('utf8')).toBe('approved');
    } finally {
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps selected note and prompt plaintext out of the in-memory inventory', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-publish-items-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-items-project';
    const worktreeId = 'entry-1';
    registerWorkspaceTypes(new Map([[projectId, 'cowork']]));
    try {
      const root = getCoworkWorkspaceRootDir(projectId);
      const notesDir = getCoworkManagedSubdir(root, 'notes');
      const promptsDir = getCoworkManagedSubdir(root, 'prompts');
      await mkdir(notesDir, { recursive: true });
      await mkdir(promptsDir, { recursive: true });
      await writeFile(join(notesDir, 'note-1.md'), '# Selected note\n', 'utf8');
      await writeFile(
        join(promptsDir, 'prompt-1.md'),
        '---\ntitle: Selected prompt\ntags: []\n---\nPrompt body\n',
        'utf8',
      );
      const chatTabsPath = resolveChatTabsFilePath(projectId, worktreeId);
      await mkdir(dirname(chatTabsPath), { recursive: true });
      await writeFile(
        chatTabsPath,
        JSON.stringify({ version: 1, activeTabId: '', tabs: [] }),
        'utf8',
      );

      const inventory = await buildCoworkPublishInventory({
        projectId,
        worktreeId,
        scope: {
          includedPaths: [],
          includedNoteIds: ['note-1'],
          includedPromptIds: ['prompt-1'],
        },
      });

      const items = [inventory.notes[0], inventory.prompts[0]] as Array<
        | undefined
        | {
            content?: string;
            source?: { createReadStream: () => AsyncIterable<Buffer> };
          }
      >;
      expect(items).toHaveLength(2);
      expect(items[0]).not.toHaveProperty('content');
      expect(items[1]).not.toHaveProperty('content');
      const readSource = async (
        item: (typeof items)[number],
      ): Promise<string> => {
        if (!item?.source) throw new Error('Missing project item source');
        const chunks: Buffer[] = [];
        for await (const chunk of item.source.createReadStream()) {
          chunks.push(chunk);
        }
        return Buffer.concat(chunks).toString('utf8');
      };
      await expect(readSource(items[0])).resolves.toBe('# Selected note\n');
      await expect(readSource(items[1])).resolves.toBe('Prompt body\n');
    } finally {
      registerWorkspaceTypes(new Map());
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('withholds a selected path whose intermediate symlink resolves into managed metadata', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-publish-inventory-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-symlink-project';
    const worktreeId = 'entry-1';
    try {
      const root = getCoworkWorkspaceRootDir(projectId);
      const managedDir = getCoworkManagedDirCandidates(root)[0];
      await mkdir(managedDir, { recursive: true });
      await writeFile(join(managedDir, 'private.md'), 'private', 'utf8');
      await symlink(managedDir, join(root, 'approved'));
      const chatTabsPath = resolveChatTabsFilePath(projectId, worktreeId);
      await mkdir(dirname(chatTabsPath), { recursive: true });
      await writeFile(
        chatTabsPath,
        JSON.stringify({ version: 1, activeTabId: '', tabs: [] }),
        'utf8',
      );

      await expect(
        buildCoworkPublishInventory({
          projectId,
          worktreeId,
          scope: {
            includedPaths: ['approved/private.md'],
            includedNoteIds: [],
            includedPromptIds: [],
          },
        }),
      ).resolves.toMatchObject({ files: [] });
    } finally {
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects an approved file swapped to an out-of-root symlink before open', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-publish-swap-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-swap-project';
    const worktreeId = 'entry-1';
    const actualOpen =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises').open;
    try {
      const root = getCoworkWorkspaceRootDir(projectId);
      await mkdir(root, { recursive: true });
      const approvedPath = join(root, 'approved.txt');
      const outsidePath = join(dataDir, 'outside-secret.txt');
      await writeFile(approvedPath, 'approved', 'utf8');
      await writeFile(outsidePath, 'secret', 'utf8');
      const chatTabsPath = resolveChatTabsFilePath(projectId, worktreeId);
      await mkdir(dirname(chatTabsPath), { recursive: true });
      await writeFile(
        chatTabsPath,
        JSON.stringify({ version: 1, activeTabId: '', tabs: [] }),
        'utf8',
      );
      const canonicalApprovedPath = await realpath(approvedPath);
      jest.mocked(open).mockImplementation(async (...args) => {
        if (args[0] === canonicalApprovedPath) {
          jest.mocked(open).mockImplementation(actualOpen);
          await rm(approvedPath);
          await symlink(outsidePath, approvedPath);
        }
        return actualOpen(...args);
      });

      await expect(
        buildCoworkPublishInventory({
          projectId,
          worktreeId,
          scope: { includedPaths: ['approved.txt'] },
        }),
      ).rejects.toThrow();
    } finally {
      jest.mocked(open).mockImplementation(actualOpen);
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('retries when an approved file disappears after the publish scan', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-publish-removed-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-removed-project';
    const worktreeId = 'entry-1';
    const actualOpen =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises').open;
    try {
      const root = getCoworkWorkspaceRootDir(projectId);
      await mkdir(root, { recursive: true });
      const approvedPath = join(root, 'approved.txt');
      await writeFile(approvedPath, 'approved', 'utf8');
      const chatTabsPath = resolveChatTabsFilePath(projectId, worktreeId);
      await mkdir(dirname(chatTabsPath), { recursive: true });
      await writeFile(
        chatTabsPath,
        JSON.stringify({ version: 1, activeTabId: '', tabs: [] }),
        'utf8',
      );
      await readChatTabsFileForIndex(projectId, worktreeId);
      jest.mocked(open).mockImplementationOnce(async (...args) => {
        await rm(approvedPath);
        return actualOpen(...args);
      });

      await expect(
        buildCoworkPublishInventory({
          projectId,
          worktreeId,
          scope: { includedPaths: ['approved.txt'] },
        }),
      ).rejects.toBeInstanceOf(SharedContainerPublishInventoryChangedError);
    } finally {
      jest.mocked(open).mockImplementation(actualOpen);
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects an approved file changed while its bytes are read', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-publish-read-race-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-read-race-project';
    const worktreeId = 'entry-1';
    const actualOpen =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises').open;
    try {
      const root = getCoworkWorkspaceRootDir(projectId);
      const approvedPath = join(root, 'approved.txt');
      await mkdir(root, { recursive: true });
      await writeFile(approvedPath, 'approved', 'utf8');
      const chatTabsPath = resolveChatTabsFilePath(projectId, worktreeId);
      await mkdir(dirname(chatTabsPath), { recursive: true });
      await writeFile(
        chatTabsPath,
        JSON.stringify({ version: 1, activeTabId: '', tabs: [] }),
        'utf8',
      );
      await readChatTabsFileForIndex(projectId, worktreeId);
      jest.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await actualOpen(...args);
        const createReadStream = handle.createReadStream.bind(handle);
        Object.defineProperty(handle, 'createReadStream', {
          value: (...streamArgs: Parameters<typeof handle.createReadStream>) =>
            Readable.from(
              (async function* (): AsyncGenerator<Buffer> {
                await writeFile(approvedPath, 'changed while reading', 'utf8');
                yield* createReadStream(...streamArgs);
              })(),
            ),
        });
        return handle;
      });

      await expect(
        buildCoworkPublishInventory({
          projectId,
          worktreeId,
          scope: { includedPaths: ['approved.txt'] },
        }),
      ).rejects.toBeInstanceOf(SharedContainerPublishInventoryChangedError);
    } finally {
      jest.mocked(open).mockImplementation(actualOpen);
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a referenced attachment changed while its bytes are read', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(
      join(tmpdir(), 'cowork-publish-attachment-race-'),
    );
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-attachment-race-project';
    const worktreeId = 'entry-1';
    const actualOpen =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises').open;
    registerWorkspaceTypes(new Map([[projectId, 'cowork']]));
    try {
      const attachmentDir = resolveAgentAttachmentsDir(projectId, worktreeId);
      const attachmentPath = join(attachmentDir, 'referenced.png');
      await mkdir(attachmentDir, { recursive: true });
      await writeFile(attachmentPath, 'attachment', 'utf8');
      const chatTabsPath = resolveChatTabsFilePath(projectId, worktreeId);
      await mkdir(dirname(chatTabsPath), { recursive: true });
      await writeFile(
        chatTabsPath,
        JSON.stringify({
          version: 1,
          activeTabId: 'chat-1',
          tabs: [
            {
              id: 'chat-1',
              title: 'Chat',
              createdAt: 'now',
              messages: [
                {
                  id: 'message-1',
                  role: 'user',
                  timestamp: 1,
                  blocks: [],
                  attachmentPaths: [attachmentPath],
                },
              ],
            },
          ],
        }),
        'utf8',
      );
      await readChatTabsFileForIndex(projectId, worktreeId);
      jest.mocked(open).mockImplementation(async (...args) => {
        const handle = await actualOpen(...args);
        if (args[0] !== attachmentPath) return handle;
        const createReadStream = handle.createReadStream.bind(handle);
        Object.defineProperty(handle, 'createReadStream', {
          value: (...streamArgs: Parameters<typeof handle.createReadStream>) =>
            Readable.from(
              (async function* (): AsyncGenerator<Buffer> {
                await writeFile(
                  attachmentPath,
                  'changed attachment while reading',
                  'utf8',
                );
                yield* createReadStream(...streamArgs);
              })(),
            ),
        });
        return handle;
      });

      await expect(
        buildCoworkPublishInventory({
          projectId,
          worktreeId,
          scope: { includedPaths: [] },
        }),
      ).rejects.toBeInstanceOf(SharedContainerPublishInventoryChangedError);
    } finally {
      jest.mocked(open).mockImplementation(actualOpen);
      registerWorkspaceTypes(new Map());
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("loads only this entry's referenced attachments from the Cowork managed directory", async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(
      join(tmpdir(), 'cowork-publish-attachments-'),
    );
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-attachment-project';
    const worktreeId = 'entry-1';
    registerWorkspaceTypes(new Map([[projectId, 'cowork']]));
    try {
      const attachmentDir = resolveAgentAttachmentsDir(projectId, worktreeId);
      const referencedPath = join(attachmentDir, 'referenced.png');
      await mkdir(attachmentDir, { recursive: true });
      await writeFile(referencedPath, 'referenced');
      await writeFile(join(attachmentDir, 'sibling-entry.png'), 'sibling');
      const chatTabsPath = resolveChatTabsFilePath(projectId, worktreeId);
      await mkdir(dirname(chatTabsPath), { recursive: true });
      await writeFile(
        chatTabsPath,
        JSON.stringify({
          version: 1,
          activeTabId: 'chat-1',
          tabs: [
            {
              id: 'chat-1',
              title: 'Chat',
              createdAt: 'now',
              messages: [
                {
                  id: 'message-1',
                  role: 'user',
                  timestamp: 1,
                  blocks: [],
                  attachmentPaths: [referencedPath],
                },
              ],
            },
          ],
        }),
        'utf8',
      );

      const inventory = await buildCoworkPublishInventory({
        projectId,
        worktreeId,
        scope: { includedPaths: [] },
      });

      expect(inventory.attachments).toHaveLength(1);
      expect(inventory.attachments[0]?.displayName).toBe('referenced.png');
      expect(inventory.attachments[0]?.sourcePath).toBe(referencedPath);
      expect(inventory.attachments[0]?.source?.sizeBytes).toBe(10);
      expect(inventory.attachments[0]?.source?.hash).toMatch(
        /^sha256:[a-f0-9]{64}$/,
      );
    } finally {
      registerWorkspaceTypes(new Map());
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects oversized attachments and withholds oversized workspace files before reading their contents', async () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'cowork-publish-bounds-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    const projectId = 'cowork-bounds-project';
    const worktreeId = 'entry-1';
    registerWorkspaceTypes(new Map([[projectId, 'cowork']]));
    try {
      const attachmentsDir = getCoworkManagedSubdir(
        getCoworkWorkspaceRootDir(projectId),
        'attachments',
      );
      await mkdir(attachmentsDir, { recursive: true });
      const largeAttachment = join(attachmentsDir, 'large.bin');
      await writeFile(largeAttachment, '');
      await truncate(largeAttachment, MAX_SHARED_CONTAINER_ARTIFACT_BYTES + 1);
      const chatTabsPath = resolveChatTabsFilePath(projectId, worktreeId);
      await mkdir(dirname(chatTabsPath), { recursive: true });
      await writeFile(
        chatTabsPath,
        JSON.stringify({
          version: 1,
          activeTabId: 'chat-1',
          tabs: [
            {
              id: 'chat-1',
              title: 'Chat',
              createdAt: 'now',
              messages: [
                {
                  id: 'message-1',
                  role: 'user',
                  timestamp: 1,
                  blocks: [],
                  attachmentPaths: [largeAttachment],
                },
              ],
            },
          ],
        }),
        'utf8',
      );

      await expect(
        buildCoworkPublishInventory({
          projectId,
          worktreeId,
          scope: { includedPaths: [] },
        }),
      ).rejects.toThrow(SharedContainerPublishRefusalError);

      await rm(largeAttachment);
      const root = getCoworkWorkspaceRootDir(projectId);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'large-approved.bin'), '');
      await truncate(
        join(root, 'large-approved.bin'),
        MAX_SHARED_CONTAINER_ARTIFACT_BYTES + 1,
      );
      await expect(
        buildCoworkPublishInventory({
          projectId,
          worktreeId,
          scope: { includedPaths: ['large-approved.bin'] },
        }),
      ).resolves.toMatchObject({ files: [] });
    } finally {
      registerWorkspaceTypes(new Map());
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

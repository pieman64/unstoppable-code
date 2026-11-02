import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import {
  migratePanelLayout,
  type ISerializedPanelEntry,
  type SerializablePanelLayoutFile,
} from '@canopy/protocol/panels';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { panelLayoutPersistenceStore } from '../panels/persistence';
import type { ChatStateService } from '../services/chat-state-service';
import { projectSharedContainerViewerChats } from '../shared-containers/chat-projection';
import type * as SharedContainerReaderModule from '../shared-containers/read/reader';
import {
  SharedContainerReader,
  getSharedContainerReader,
} from '../shared-containers/read/reader';
import { SharedContainerReplicaStore } from '../shared-containers/replica/store';

jest.mock('../lib/start-page-feature-flag', () => ({
  isStartPageFeatureEnabled: (): boolean => true,
}));
jest.mock('../shared-containers/read/reader', () => {
  const actual = jest.requireActual<typeof SharedContainerReaderModule>(
    '../shared-containers/read/reader',
  );
  return { ...actual, getSharedContainerReader: jest.fn() };
});

const VIEWER = 'shared-container-viewer';
const CONTAINER_ID = 'container-1';

const PUBLISHER_LAYOUT = {
  orientation: 0,
  root: {
    type: 'leaf',
    size: 1,
    tabs: [
      { kind: 'file-explorer' },
      {
        kind: 'file',
        repoId: 'repo-1',
        relativePath: 'docs/guide.md',
        viewMode: 'raw',
      },
    ],
    activeTabIndex: 1,
  },
};

const RECIPIENT_LAYOUT: SerializablePanelLayoutFile = {
  version: 1,
  grid: {
    orientation: 0,
    root: {
      type: 'leaf',
      groupId: 'recipient-group',
      panels: [{ panelId: 'recipient-panel', kind: 'activity-section' }],
      activePanelId: 'recipient-panel',
      size: 1,
    },
    width: 1200,
    height: 800,
  },
  activeGroupId: 'recipient-group',
  mostRecentActiveGroupIds: ['recipient-group'],
};

describe('shared-container viewer layout reset on open', () => {
  const originalDataDir = process.env.CANOPY_DATA_DIR;
  let tempPath = '';
  let repoRoot = '';

  async function seedRevision(options: {
    layout: boolean;
    startPage: boolean;
  }): Promise<void> {
    const replicaRoot = join(tempPath, 'replicas');
    const revisionRoot = join(
      replicaRoot,
      CONTAINER_ID,
      'revisions',
      'revision-1',
    );
    repoRoot = join(revisionRoot, 'repos', 'repo-1');
    await mkdir(join(revisionRoot, 'artifacts', 'chats'), { recursive: true });
    await mkdir(join(repoRoot, 'docs'), { recursive: true });
    await writeFile(join(repoRoot, 'docs', 'guide.md'), '# Guide');
    await writeFile(join(repoRoot, 'docs', 'start.md'), '# Start');
    await writeFile(join(repoRoot, 'docs', 'own.md'), '# Own');
    await writeFile(
      join(revisionRoot, 'artifacts', 'container.json'),
      JSON.stringify({
        schemaVersion: options.startPage ? 4 : 3,
        containerType: 'CODE_WORKTREE',
        title: 'Shared feature',
        repositories: [
          {
            repoId: 'repo-1',
            repoName: 'Repo',
            remoteUrl: 'https://github.com/acme/repo.git',
            owner: 'acme',
            repository: 'repo',
            baseCommitSha: 'a'.repeat(40),
            files: ['guide.md', 'start.md', 'own.md'].map((name, index) => ({
              path: `docs/${name}`,
              status: 'added',
              artifactId: `file-${index}`,
              mode: '100644',
            })),
          },
        ],
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
        ...(options.startPage
          ? {
              startPage: {
                kind: 'file',
                repoId: 'repo-1',
                relativePath: 'docs/start.md',
              },
            }
          : {}),
        ...(options.layout ? { layout: PUBLISHER_LAYOUT } : {}),
      }),
    );
    const store = new SharedContainerReplicaStore(replicaRoot);
    await store.set({
      containerId: CONTAINER_ID,
      organizationId: 'organization-1',
      containerType: 'CODE_WORKTREE',
      status: 'available',
      revisionId: 'revision-1',
      revision: 1,
      revisionCreatedAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    });
    jest
      .mocked(getSharedContainerReader)
      .mockReturnValue(new SharedContainerReader(store));
  }

  /** A file tab the recipient opened themselves in an earlier session. */
  function recipientFileTab(): PersistedChatTab {
    return {
      id: 'recipient-file',
      title: 'own.md',
      messages: [],
      createdAt: new Date(0).toISOString(),
      kind: 'file',
      filePath: join(repoRoot, 'docs', 'own.md'),
      readOnly: true,
    };
  }

  function chatStateWith(previousTabs: PersistedChatTab[]): {
    chatState: ChatStateService;
    replaceCompatibilityTabs: jest.Mock<Promise<void>, unknown[]>;
  } {
    const replaceCompatibilityTabs = jest
      .fn<Promise<void>, unknown[]>()
      .mockResolvedValue(undefined);
    const chatState = {
      getCompatibilityTabs: jest.fn().mockResolvedValue({
        version: 1,
        tabs: previousTabs,
        activeTabId: previousTabs[0]?.id ?? '',
      }),
      replaceCompatibilityTabs,
    } as unknown as ChatStateService;
    return { chatState, replaceCompatibilityTabs };
  }

  function viewerPanels(): readonly ISerializedPanelEntry[] {
    const root = migratePanelLayout(
      panelLayoutPersistenceStore.loadWorktreeLayout(VIEWER, CONTAINER_ID),
    )?.grid.root;
    return root?.type === 'leaf' ? root.panels : [];
  }

  function projectedTabs(replace: jest.Mock<Promise<void>, unknown[]>): {
    tabs: PersistedChatTab[];
    activeTabId: string;
  } {
    return replace.mock.calls[0]?.[1] as {
      tabs: PersistedChatTab[];
      activeTabId: string;
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    tempPath = await mkdtemp(join(tmpdir(), 'shared-container-reset-'));
    process.env.CANOPY_DATA_DIR = join(tempPath, 'data');
    resetResolvedCanopyDataDirForTests();
  });

  afterEach(async () => {
    panelLayoutPersistenceStore.deleteWorktreeLayout(VIEWER, CONTAINER_ID);
    await rm(tempPath, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    resetResolvedCanopyDataDirForTests();
  });

  it('resets a returning recipient to the publisher layout, ahead of the start page', async () => {
    await seedRevision({ layout: true, startPage: true });
    panelLayoutPersistenceStore.saveWorktreeLayout(
      VIEWER,
      CONTAINER_ID,
      RECIPIENT_LAYOUT,
    );
    const { chatState, replaceCompatibilityTabs } = chatStateWith([
      recipientFileTab(),
    ]);

    await projectSharedContainerViewerChats(
      CONTAINER_ID,
      'revision-1',
      chatState,
      { mode: 'reset' },
    );

    expect(viewerPanels().map((panel) => panel.kind)).toEqual([
      'file-explorer',
      'file-diff',
    ]);
    const { tabs, activeTabId } = projectedTabs(replaceCompatibilityTabs);
    // The recipient's own file tab would come back as a panel, so it goes.
    expect(tabs.map((tab) => tab.filePath)).toEqual([
      join(repoRoot, 'docs', 'guide.md'),
    ]);
    // The layout's active panel decides the active tab.
    expect(activeTabId).toBe(tabs[0]?.id);
  });

  it('keeps a returning recipient layout and tabs when the sync seeds', async () => {
    await seedRevision({ layout: true, startPage: true });
    panelLayoutPersistenceStore.saveWorktreeLayout(
      VIEWER,
      CONTAINER_ID,
      RECIPIENT_LAYOUT,
    );
    const { chatState, replaceCompatibilityTabs } = chatStateWith([
      recipientFileTab(),
    ]);

    await projectSharedContainerViewerChats(
      CONTAINER_ID,
      'revision-1',
      chatState,
    );

    expect(viewerPanels().map((panel) => panel.panelId)).toEqual([
      'recipient-panel',
    ]);
    const { tabs, activeTabId } = projectedTabs(replaceCompatibilityTabs);
    expect(tabs.map((tab) => tab.id)).toEqual(['recipient-file']);
    expect(activeTabId).toBe('recipient-file');
  });

  it('opens a first-time recipient to the start page when no layout ships', async () => {
    await seedRevision({ layout: false, startPage: true });
    const { chatState, replaceCompatibilityTabs } = chatStateWith([]);

    await projectSharedContainerViewerChats(
      CONTAINER_ID,
      'revision-1',
      chatState,
      { mode: 'reset' },
    );

    expect(viewerPanels().map((panel) => panel.kind)).toEqual(['file-diff']);
    expect(
      projectedTabs(replaceCompatibilityTabs).tabs.map((tab) => tab.filePath),
    ).toEqual([join(repoRoot, 'docs', 'start.md')]);
  });

  it('keeps a returning recipient arrangement when no layout ships', async () => {
    await seedRevision({ layout: false, startPage: true });
    panelLayoutPersistenceStore.saveWorktreeLayout(
      VIEWER,
      CONTAINER_ID,
      RECIPIENT_LAYOUT,
    );
    const { chatState, replaceCompatibilityTabs } = chatStateWith([
      recipientFileTab(),
    ]);

    await projectSharedContainerViewerChats(
      CONTAINER_ID,
      'revision-1',
      chatState,
      { mode: 'reset' },
    );

    expect(viewerPanels().map((panel) => panel.panelId)).toEqual([
      'recipient-panel',
    ]);
    expect(
      projectedTabs(replaceCompatibilityTabs).tabs.map((tab) => tab.id),
    ).toEqual(['recipient-file']);
  });

  it('restores the recipient layout when the chat projection fails after a reset', async () => {
    await seedRevision({ layout: true, startPage: false });
    panelLayoutPersistenceStore.saveWorktreeLayout(
      VIEWER,
      CONTAINER_ID,
      RECIPIENT_LAYOUT,
    );
    const { chatState, replaceCompatibilityTabs } = chatStateWith([]);
    replaceCompatibilityTabs.mockRejectedValue(new Error('projection failed'));

    await expect(
      projectSharedContainerViewerChats(CONTAINER_ID, 'revision-1', chatState, {
        mode: 'reset',
      }),
    ).rejects.toThrow('projection failed');

    expect(viewerPanels().map((panel) => panel.panelId)).toEqual([
      'recipient-panel',
    ]);
  });
});

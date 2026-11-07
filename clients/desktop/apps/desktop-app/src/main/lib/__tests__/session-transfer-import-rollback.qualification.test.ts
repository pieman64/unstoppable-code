import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packSessionBundle } from '../session-bundle-archive';
import {
  discardStagedSessionImport,
  getStagedSessionImportPathForTesting,
  importChatSession,
  inspectChatSessionImport,
} from '../session-transfer';
import { cleanupPersistedWorktreeData } from '../worktree-data-cleanup';
import { removeWorkEntryRow } from '../cowork-work-entries';

const mockBundle: { bytes: Buffer; contentHash: string } = {
  bytes: Buffer.alloc(0),
  contentHash: '',
};

jest.mock('electron', () => ({ app: { getVersion: (): string => '1.0.0' } }));
jest.mock('../canopy-cloud-account-store', () => ({
  subscribeCanopyCloudAccountChanges: jest.fn(),
  loadCanopyCloudAccount: jest.fn(() =>
    Promise.resolve({
      apiKey: 'key',
      capabilities: ['session-exports-v1'],
      account: { id: 'acct-1' },
    }),
  ),
}));
jest.mock('../../session-exports/canopy-server-client', () => ({
  getSessionExport: jest.fn(() =>
    Promise.resolve({ contentHash: mockBundle.contentHash }),
  ),
  downloadSessionExportBundle: jest.fn(() => Promise.resolve(mockBundle.bytes)),
}));
jest.mock('../sidebar-items', () => ({
  readAllSidebarItems: jest.fn(() =>
    Promise.resolve({
      items: [
        {
          id: 'cowork-1',
          type: 'cowork',
          name: 'Cowork',
          color: '#000000',
          order: 0,
          collapsed: false,
          worktrees: [],
        },
      ],
    }),
  ),
}));
jest.mock('../cowork-work-entries', () => ({
  createWorkEntry: jest.fn(() => Promise.resolve({ entry: { id: 'entry-1' } })),
  removeWorkEntryRow: jest.fn(() => Promise.resolve()),
}));
jest.mock('../worktree-data-cleanup', () => ({
  cleanupPersistedWorktreeData: jest.fn(() => Promise.resolve()),
}));
jest.mock('../chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(() =>
    Promise.resolve({ version: 1, tabs: [], activeTabId: '' }),
  ),
}));
jest.mock('../chat-tab-dispatch-utils', () => ({
  upsertPersistedChatTab: jest.fn(() => Promise.reject(new Error('disk full'))),
}));
jest.mock('../../browser/browser-profile-lifecycle', () => ({
  withBrowserTaskOwnerRemoval: (
    _projectId: string,
    _worktreeId: string,
    work: () => Promise<void>,
  ): Promise<void> => work(),
}));

describe('session import rollback (CAN-4113)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'can-4113-'));
  const build = globalThis as Record<string, unknown>;
  const originalBaseUrl = build.__CANOPY_CLOUD_BASE_URL__;

  beforeAll(async () => {
    // The account context resolves the cloud base URL; the client is mocked.
    build.__CANOPY_CLOUD_BASE_URL__ = 'https://cloud.example.test';
    const bundleDir = join(scratch, 'bundle');
    mkdirSync(bundleDir);
    writeFileSync(
      join(bundleDir, 'canopy-session.json'),
      JSON.stringify({
        version: 1,
        appVersion: '1.0.0',
        exportedAt: '2026-11-05T10:00:00.000Z',
        source: {
          projectId: 'src-p',
          worktreeId: 'src-w',
          chatId: 'src-c',
          workspaceName: 'Src',
        },
        workspaceType: 'cowork',
        repos: [],
        tab: {
          id: 'src-c',
          title: 'Imported chat',
          createdAt: '2026-11-05T09:00:00.000Z',
          messages: [],
        },
      }),
    );
    const archivePath = join(scratch, 'bundle.tar.gz');
    await packSessionBundle(bundleDir, archivePath);
    mockBundle.bytes = readFileSync(archivePath);
    mockBundle.contentHash = createHash('sha256')
      .update(mockBundle.bytes)
      .digest('hex');
  });

  afterAll(() => {
    build.__CANOPY_CLOUD_BASE_URL__ = originalBaseUrl;
    rmSync(scratch, { recursive: true, force: true });
  });

  it('removes the new Work Entry and keeps the staged export when the chat write fails', async () => {
    await inspectChatSessionImport({
      workspaceId: 'cowork-1',
      exportId: 'exp-1',
    });
    await expect(
      importChatSession(
        { exportId: 'exp-1', workspaceId: 'cowork-1' },
        () => null,
      ),
    ).rejects.toThrow('disk full');
    expect(cleanupPersistedWorktreeData).toHaveBeenCalledWith(
      'cowork-1',
      'entry-1',
    );
    expect(removeWorkEntryRow).toHaveBeenCalledWith('cowork-1', 'entry-1');
    expect(getStagedSessionImportPathForTesting('exp-1')).not.toBeNull();

    await discardStagedSessionImport('exp-1');
    expect(getStagedSessionImportPathForTesting('exp-1')).toBeNull();
  });
});

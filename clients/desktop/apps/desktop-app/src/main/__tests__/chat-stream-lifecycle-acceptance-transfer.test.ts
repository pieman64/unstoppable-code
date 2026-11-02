import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SessionExportRecord,
  SessionExportUploadMetadata,
} from '@canopy/protocol/session-exports';

jest.mock('electron', () => ({ app: { getVersion: (): string => 'test' } }));
jest.mock('../agents/session-manager', () => ({
  getActiveChatIds: (): string[] => [],
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: jest.fn(() =>
    Promise.resolve({
      apiKey: 'synthetic-test-key',
      authMode: 'api-key',
      credentialSource: 'manual',
      capabilities: ['session-exports-v1'],
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
    }),
  ),
  subscribeCanopyCloudAccountChanges: (): (() => void) => (): void => {},
}));
jest.mock('../canopy-cloud/config', () => ({
  getCanopyCloudBaseUrl: (): string => 'https://invalid.example.test',
}));
const mockUpload = jest.fn<
  Promise<SessionExportRecord>,
  [SessionExportUploadMetadata, { filePath: string }, unknown]
>();
jest.mock('../session-exports/canopy-server-client', () => ({
  uploadSessionExport: (
    ...args: Parameters<typeof mockUpload>
  ): Promise<SessionExportRecord> => mockUpload(...args),
}));

import { exportChatSession } from '../lib/session-transfer';
import { unpackSessionBundle } from '../lib/session-bundle-archive';
import * as stateService from '../services/chat-state-service';
import * as sidebar from '../lib/sidebar-items';
import {
  lifecycleFixture,
  SOURCE,
  assertInlineRows,
} from './helpers/stream-lifecycle-fixture';
import { drainOpenRepositories } from './helpers/chat-delta-journal-scope';
import { isPersistedChatMessage } from '../lib/persisted-chat-message-validation';

jest.setTimeout(180_000);
describe('session transfer through the real exporter, creation option off', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'stream-lifecycle-transfer-'));
  });
  afterEach(async () => {
    await drainOpenRepositories();
    jest.restoreAllMocks();
    mockUpload.mockReset();
    await rm(root, { recursive: true, force: true });
  });
  it.each([false, true])(
    'exports exact old-page/full-body rows (settled=%s)',
    async (settled) => {
      const f = await lifecycleFixture(root, settled);
      jest
        .spyOn(stateService, 'getChatStateService')
        .mockReturnValue(f.service);
      jest.spyOn(sidebar, 'readAllSidebarItems').mockResolvedValue({
        version: 1,
        items: [
          {
            type: 'cowork',
            id: 'p',
            name: 'Synthetic workspace',
            color: '#8B5CF6',
            collapsed: false,
            order: 0,
          },
        ],
      });
      let uploaded: Buffer | undefined;
      mockUpload.mockImplementation(async (metadata, bundle) => {
        uploaded = await readFile(bundle.filePath);
        return {
          ...metadata,
          id: 'synthetic-export',
          sizeBytes: uploaded.length,
          createdAt: '2026-10-20T00:00:00.000Z',
          updatedAt: '2026-10-20T00:00:00.000Z',
        };
      });
      expect(
        (await exportChatSession({ ...SOURCE, chatId: 'chat' })).exportId,
      ).toBe('synthetic-export');
      if (!uploaded) throw new Error('Export did not upload a bundle');
      const archive = join(root, 'bundle.tar.gz');
      const directory = join(root, 'unpacked');
      await writeFile(archive, uploaded);
      await mkdir(directory);
      await unpackSessionBundle(archive, directory);
      const manifest: unknown = JSON.parse(
        await readFile(join(directory, 'canopy-session.json'), 'utf8'),
      );
      if (
        !manifest ||
        typeof manifest !== 'object' ||
        !('tab' in manifest) ||
        !manifest.tab ||
        typeof manifest.tab !== 'object' ||
        !('messages' in manifest.tab)
      )
        throw new Error('Exported manifest is invalid');
      const messages = manifest.tab.messages;
      if (!Array.isArray(messages))
        throw new Error('Exported messages are not an array');
      expect(messages.every(isPersistedChatMessage)).toBe(true);
      if (!messages.every(isPersistedChatMessage))
        throw new Error('Exported messages are invalid');
      assertInlineRows(messages);
      await f.repository.transact(
        SOURCE,
        [{ type: 'tab.removed', tabId: 'chat' }],
        { source: 'migration' },
      );
      await f.repository.flushScope(SOURCE);
      assertInlineRows(messages);
    },
  );
});

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  drainOpenRepositories,
  repositoryAt,
} from './helpers/chat-delta-journal-scope';

const scope = { projectId: 'workspace', worktreeId: 'scope' };
const legacyTabs = {
  version: 1,
  activeTabId: 'chat',
  tabs: [
    {
      id: 'chat',
      title: 'Chat',
      createdAt: '2026-09-05',
      messages: [
        {
          id: 'message',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'hello' }],
        },
      ],
    },
  ],
};

describe('delegation generation-store readiness', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'delegation-generation-readiness-'));
    await mkdir(join(root, 'chats'), { recursive: true });
    await writeFile(
      join(root, 'chats', `${scope.worktreeId}.json`),
      JSON.stringify(legacyTabs),
    );
  });

  afterEach(async () => {
    await drainOpenRepositories();
    await rm(root, { recursive: true, force: true });
  });

  it('returns the manifest selected by ordered load when format 4 is disabled', async () => {
    const repository = repositoryAt(root, { enableFormat4: false });

    await expect(repository.generationStoreReadiness(scope)).resolves.toEqual({
      formatVersion: 3,
      enableFormat4: false,
    });
  });

  it('returns format 4 after ordered load promotes an enabled scope', async () => {
    const repository = repositoryAt(root, { enableFormat4: true });

    await expect(repository.generationStoreReadiness(scope)).resolves.toEqual({
      formatVersion: 4,
      enableFormat4: true,
    });
  });

  it.each([false, true])(
    'propagates repository load failures with format 4 option %s',
    async (enableFormat4) => {
      await writeFile(join(root, 'chats', `${scope.worktreeId}.json`), '{');
      const repository = repositoryAt(root, { enableFormat4 });

      await expect(repository.generationStoreReadiness(scope)).rejects.toThrow(
        'Unable to load chat scope',
      );
    },
  );
});

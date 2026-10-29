import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';
import {
  createWorkspaceManifestRepository,
  WorkspaceConfigUnreadableError,
  type WorkspaceManifestRepository,
} from '../workspace-manifest-repository';
import {
  createMemoryFileStore,
  type MemoryFileStore,
} from './w5-memory-file-store';

const manifestPath = (workspaceId: string): string =>
  `/data/workspaces/${workspaceId}/workspace.json`;

describe('workspace manifest repository (CAN-3800)', () => {
  let memory: MemoryFileStore;
  let repository: WorkspaceManifestRepository;

  function setUp(initial: Record<string, string> = {}): void {
    memory = createMemoryFileStore(initial);
    repository = createWorkspaceManifestRepository({
      store: memory.store,
      filePath: manifestPath,
      storage: { namespace: 'workspace_manifest', writer: 'electron_main' },
      knownFields: new Set(['version', 'type', 'repos', 'planDetection']),
      knownRepoFields: new Set(['id', 'name', 'repoPath']),
    });
  }

  function onDisk(workspaceId: string): unknown {
    const raw = memory.files.get(manifestPath(workspaceId));
    if (raw === undefined) throw new Error(`No manifest for ${workspaceId}`);
    return JSON.parse(raw);
  }

  const config: WorkspaceConfigFile = {
    version: 1,
    type: 'multi-repo',
    repos: [{ id: 'api', name: 'api', repoPath: '/src/api' }],
  };

  describe('read', () => {
    it.each<[string, string | undefined, string]>([
      ['a missing file', undefined, 'absent'],
      ['invalid JSON', '{"version": 1, "ty', 'unreadable'],
      ['another version', '{"version": 2}', 'unreadable'],
      ['a non-object', '[1]', 'unreadable'],
      ['a version 1 manifest', '{"version": 1, "type": "cowork"}', 'ok'],
    ])('reports %s as %s', async (_label, initial, authority) => {
      setUp(initial === undefined ? {} : { [manifestPath('w')]: initial });
      expect((await repository.read('w')).authority).toBe(authority);
    });

    it('reports a failed read as unreadable', async () => {
      setUp({ [manifestPath('w')]: '{"version": 1}' });
      memory.unreadable.add(manifestPath('w'));
      expect(await repository.read('w')).toEqual({ authority: 'unreadable' });
    });
  });

  describe('replace', () => {
    it('keeps unknown project and repository fields and clears known ones', async () => {
      setUp({
        [manifestPath('w')]: JSON.stringify({
          version: 1,
          type: 'multi-repo',
          planDetection: { disabledRuleIds: ['a'] },
          futureSetting: { level: 2 },
          repos: [
            { id: 'api', name: 'api', repoPath: '/old', futureRepoField: 1 },
            { id: 'gone', name: 'gone', repoPath: '/gone', futureRepoField: 2 },
          ],
        }),
      });

      await repository.replace('w', config, await repository.read('w'));

      expect(onDisk('w')).toEqual({
        version: 1,
        type: 'multi-repo',
        repos: [
          { id: 'api', name: 'api', repoPath: '/src/api', futureRepoField: 1 },
        ],
        futureSetting: { level: 2 },
      });
    });

    it('writes the config as it is for a new manifest', async () => {
      setUp();

      await repository.replace('w', config, await repository.read('w'));

      expect(memory.files.get(manifestPath('w'))).toBe(
        JSON.stringify(config, null, 2),
      );
    });

    it('refuses to replace a manifest that could not be read', async () => {
      setUp({ [manifestPath('w')]: '{"version": 1, "ty' });

      await expect(
        repository.replace('w', config, await repository.read('w')),
      ).rejects.toBeInstanceOf(WorkspaceConfigUnreadableError);

      expect(memory.files.get(manifestPath('w'))).toBe('{"version": 1, "ty');
      expect(memory.writes).toEqual([]);
    });
  });

  describe('serialize', () => {
    it('runs one workspace’s tasks in order, after a failed one too', async () => {
      setUp();
      const order: string[] = [];
      let releaseFirst: () => void = () => {};
      const first = repository.serialize('w', async () => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push('first');
        throw new Error('first failed');
      });
      const second = repository.serialize('w', () => {
        order.push('second');
        return Promise.resolve();
      });
      const other = repository.serialize('other', () => {
        order.push('other');
        return Promise.resolve();
      });

      await other;
      expect(order).toEqual(['other']);
      releaseFirst();
      await expect(first).rejects.toThrow('first failed');
      await second;
      expect(order).toEqual(['other', 'first', 'second']);
    });

    it('keeps both of two concurrent read-modify-writes', async () => {
      setUp({
        [manifestPath('w')]: JSON.stringify({ ...config, planDetection: {} }),
      });
      const addRepo = (id: string): Promise<void> =>
        repository.serialize('w', async () => {
          const read = await repository.read('w');
          if (read.authority !== 'ok') throw new Error('unreadable');
          const repos = Array.isArray(read.document.repos)
            ? read.document.repos.length
            : 0;
          await repository.replace(
            'w',
            {
              ...config,
              repos: [
                ...config.repos,
                ...Array.from({ length: repos }, (_, index) => ({
                  id: `${id}-${index}`,
                  name: id,
                  repoPath: `/src/${id}`,
                })),
              ],
            },
            read,
          );
        });

      await Promise.all([addRepo('x'), addRepo('y')]);

      // The second task saw the first one's write (two repos), not the
      // original manifest (one repo).
      expect(onDisk('w')).toMatchObject({
        repos: [{ id: 'api' }, { id: 'y-0' }, { id: 'y-1' }],
      });
    });
  });
});

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveBrowserTaskOwner,
  legacyBrowserPartitionOwners,
} from '../owners';

describe('trusted browser profile owners', () => {
  let root: string;
  const seed = async (path: string, data: unknown): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(data));
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'profile-owners-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('resolves every task kind without granting a workspace home or global advisor profile', async () => {
    await seed('workspaces/index.json', {
      version: 1,
      workspaces: [
        { id: 'code', type: 'single-repo' },
        { id: 'cowork', type: 'cowork' },
      ],
    });
    await seed('workspaces/code/worktrees.json', {
      version: 1,
      worktrees: [{ id: 'a', createdAt: '1' }],
    });
    await seed('workspaces/cowork/work-entries.json', {
      version: 1,
      entries: [{ id: 'a', createdAt: '2' }],
    });
    await seed('app-workspaces/app-advisor/work-entries.json', {
      version: 1,
      entries: [{ id: 'a', createdAt: '3' }],
    });
    expect((await resolveBrowserTaskOwner(root, 'code', 'a'))?.scope.kind).toBe(
      'worktree',
    );
    expect(
      (await resolveBrowserTaskOwner(root, 'cowork', 'a'))?.scope.kind,
    ).toBe('cowork_work_entry');
    expect(
      (await resolveBrowserTaskOwner(root, 'app-advisor', 'a'))?.scope.kind,
    ).toBe('app_advisor_work_entry');
    expect(await resolveBrowserTaskOwner(root, 'cowork', 'home')).toBeNull();
    expect(
      await resolveBrowserTaskOwner(root, 'app-advisor', 'app-advisor'),
    ).toBeNull();
    expect(await resolveBrowserTaskOwner(root, 'foreign', 'a')).toBeNull();
  });

  it('detects legacy partition aliases across different project/entry tuples', async () => {
    await seed('workspaces/index.json', {
      version: 1,
      workspaces: [
        { id: 'a-b', type: 'single-repo' },
        { id: 'a', type: 'cowork' },
      ],
    });
    await seed('workspaces/a-b/worktrees.json', {
      version: 1,
      worktrees: [{ id: 'c', createdAt: '1' }],
    });
    await seed('workspaces/a/work-entries.json', {
      version: 1,
      entries: [{ id: 'b-c', createdAt: '2' }],
    });
    expect(
      await legacyBrowserPartitionOwners(root, 'persist:canopy-browser-a-b-c'),
    ).toHaveLength(2);
  });

  it('preserves an indexed owner when its registry is missing', async () => {
    await seed('workspaces/index.json', {
      version: 1,
      workspaces: [{ id: 'code', type: 'single-repo' }],
    });
    await expect(
      resolveBrowserTaskOwner(root, 'code', 'a'),
    ).rejects.toMatchObject({ code: 'recovery_required' });
  });

  it('does not treat malformed or future owner registries as deleted owners', async () => {
    await seed('workspaces/index.json', {
      version: 1,
      workspaces: [{ id: 'code', type: 'single-repo' }],
    });
    await seed('workspaces/code/worktrees.json', { version: 2, worktrees: [] });
    await expect(
      resolveBrowserTaskOwner(root, 'code', 'a'),
    ).rejects.toMatchObject({ code: 'recovery_required' });
    await seed('workspaces/index.json', { version: 99, workspaces: [] });
    await expect(
      resolveBrowserTaskOwner(root, 'code', 'a'),
    ).rejects.toMatchObject({ code: 'recovery_required' });
  });
});

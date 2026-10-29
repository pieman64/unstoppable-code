import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as paths from 'node:path';
import type { CanopyWorkspaceScope } from '@canopy/protocol/canopy-core';
import { readNativeRootIdentity } from '../catalog-revision';
import { listFilesystemScopeRoots } from '../scope-queries';
import type { WorkspaceFileRead } from '../../workspace/read-formats';
import {
  createFilesystemScopeResolver,
  type FilesystemScopeResolverOptions,
} from '../scope-resolver';

const TEAM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEAM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const binding = (organizationId: string): Record<string, unknown> => ({
  type: 'organization',
  organizationId,
  projectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  bindingGeneration: 1,
});
const invalid = (operation = 'roots'): object => ({
  payload: {
    kind: 'failed_precondition',
    code: `worker.filesystem.${operation}.invalidState`,
    retry: { kind: 'never' },
  },
});
const missing = { payload: { code: 'worker.filesystem.roots.notFound' } };

let dataRoot: string;
let options: FilesystemScopeResolverOptions;
async function json(relative: string, document: unknown): Promise<void> {
  const target = paths.join(dataRoot, relative);
  await mkdir(paths.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(document));
}
async function workspace(id: string, owner?: unknown): Promise<void> {
  await json(`workspaces/${id}/workspace.json`, {
    version: 1,
    type: 'single-repo',
    repos: [],
    ...(owner !== undefined && { owner }),
  });
  await json(`workspaces/${id}/worktrees.json`, {
    version: 1,
    worktrees: [{ id: 'task', branchName: 'topic', createdAt: 'now' }],
  });
  await mkdir(paths.join(dataRoot, `workspaces/${id}/worktrees/task`), {
    recursive: true,
  });
}
beforeEach(async () => {
  dataRoot = await realpath(await mkdtemp(paths.join(tmpdir(), 'can4304-')));
  options = {
    canonicalDataRoot: dataRoot,
    authorityId: 'authority',
    targetId: 'in_process_worker',
    coworkManagedDirName: '.canopy',
    paths,
    rootIdentity: readNativeRootIdentity,
  };
  await json('workspaces/index.json', {
    version: 1,
    workspaces: ['personal', 'team-a', 'team-b', 'malformed'].map((id) => ({
      id,
      name: id,
      type: 'single-repo',
      color: '#fff',
    })),
  });
  await workspace('personal');
  await workspace('team-a', binding(TEAM_A.toUpperCase()));
  await workspace('team-b', binding(TEAM_B));
  await workspace('malformed', { type: 'organization', organizationId: 'x' });
});
afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

it('resolves Personal and two organization owners per request from one data root', async () => {
  const resolve = await createFilesystemScopeResolver(options);
  const revisions = new Set<string | undefined>();
  for (const [workspaceId, organizationId] of [
    ['personal', undefined],
    ['team-a', TEAM_A],
    ['team-b', TEAM_B],
    ['team-a', TEAM_A],
  ] as const) {
    const scope = { workspaceId, worktreeId: 'task' };
    const dependencies = await resolve(scope, 'roots');
    expect(dependencies.organizationId).toBe(organizationId);
    expect(dependencies).toMatchObject({
      dataRoot,
      authorityId: 'authority',
      targetId: 'in_process_worker',
    });
    const roots = await listFilesystemScopeRoots({ scope }, dependencies);
    expect(roots.roots).toEqual([
      { fileRootId: workspaceId, name: workspaceId, kind: 'git-repo' },
    ]);
    revisions.add(roots.catalogRevision);
  }
  expect(revisions.size).toBe(3);
});

it('ignores a request ownership claim that the persisted owner does not match', async () => {
  const resolve = await createFilesystemScopeResolver(options);
  for (const [workspaceId, organizationId] of [
    ['personal', TEAM_A],
    ['team-a', TEAM_B],
    ['team-b', TEAM_A],
    ['team-a', 'team-a'],
  ])
    await expect(
      resolve({ workspaceId, worktreeId: 'task', organizationId }, 'roots'),
    ).rejects.toMatchObject(invalid());
  await expect(
    resolve(
      { workspaceId: 'team-a', worktreeId: 'task', organizationId: TEAM_A },
      'roots',
    ),
  ).resolves.toMatchObject({ organizationId: TEAM_A });
});

it.each([
  null,
  {},
  { type: 'user' },
  { type: 'organization', organizationId: 'team-a' },
  { ...binding(TEAM_A), instanceId: undefined },
  { ...binding(TEAM_A), bindingGeneration: undefined },
])('fails a malformed owner %j with a typed invalid state', async (owner) => {
  await workspace('malformed', owner);
  const resolve = await createFilesystemScopeResolver(options);
  const scope = { workspaceId: 'malformed', worktreeId: 'task' };
  await expect(resolve(scope, 'roots')).rejects.toMatchObject(invalid());
  await expect(resolve(scope, 'directory')).rejects.toMatchObject(
    invalid('directory'),
  );
});

it.each<[string, CanopyWorkspaceScope]>([
  ['parent workspace', { workspaceId: '../outside' }],
  ['absolute workspace', { workspaceId: '/etc' }],
  ['nested workspace', { workspaceId: 'personal/../team-a' }],
  ['upper-case workspace', { workspaceId: 'Personal' }],
  ['leading-dash workspace', { workspaceId: '-x' }],
  ['missing workspace', {}],
  ['parent worktree', { workspaceId: 'personal', worktreeId: '..' }],
  ['drive worktree', { workspaceId: 'personal', worktreeId: 'C:task' }],
  ['foreign authority', { workspaceId: 'personal', authorityId: 'foreign' }],
  ['foreign target', { workspaceId: 'personal', targetId: 'foreign' }],
  ['slug organization', { workspaceId: 'personal', organizationId: 'team' }],
])('refuses a %s selector before any read', async (_label, scope) => {
  const reads: string[] = [];
  const resolve = await createFilesystemScopeResolver({
    ...options,
    readFile: async (absolutePath): Promise<WorkspaceFileRead> => {
      reads.push(absolutePath);
      return { state: 'present', raw: await readFile(absolutePath, 'utf8') };
    },
  });
  await expect(resolve(scope, 'roots')).rejects.toMatchObject(invalid());
  expect(reads).toEqual([]);
});

it.each(['missing', 'plan-explore-chat', 'code-review-chat'])(
  'reports an untracked or alias workspace %s as not found after reading only the index',
  async (workspaceId) => {
    const reads: string[] = [];
    const resolve = await createFilesystemScopeResolver({
      ...options,
      readFile: async (absolutePath): Promise<WorkspaceFileRead> => {
        reads.push(absolutePath);
        return { state: 'present', raw: await readFile(absolutePath, 'utf8') };
      },
    });
    await expect(
      resolve({ workspaceId, worktreeId: 'task' }, 'roots'),
    ).rejects.toMatchObject(missing);
    expect(reads).toEqual([paths.join(dataRoot, 'workspaces', 'index.json')]);
  },
);

it('fails a corrupt or missing ownership record closed', async () => {
  const resolve = await createFilesystemScopeResolver(options);
  const scope = { workspaceId: 'team-a', worktreeId: 'task' };
  await writeFile(
    paths.join(dataRoot, 'workspaces/team-a/workspace.json'),
    '{',
  );
  await expect(resolve(scope, 'roots')).rejects.toMatchObject(invalid());
  await rm(paths.join(dataRoot, 'workspaces/team-a/workspace.json'));
  await expect(resolve(scope, 'roots')).rejects.toMatchObject(missing);
  await writeFile(paths.join(dataRoot, 'workspaces/index.json'), '[');
  await expect(resolve(scope, 'roots')).rejects.toMatchObject(invalid());
});

it('fails the first snapshot when ownership changes after resolution', async () => {
  const resolve = await createFilesystemScopeResolver(options);
  const scope = { workspaceId: 'team-a', worktreeId: 'task' };
  const dependencies = await resolve(scope, 'roots');
  await workspace('team-a', binding(TEAM_B));
  await expect(
    listFilesystemScopeRoots({ scope }, dependencies),
  ).rejects.toMatchObject(invalid());
  await workspace('team-a');
  await expect(
    listFilesystemScopeRoots({ scope }, dependencies),
  ).rejects.toMatchObject(invalid());
});

it('refuses untrusted host inputs at creation', async () => {
  const linked = `${dataRoot}-link`;
  await symlink(dataRoot, linked);
  try {
    for (const canonicalDataRoot of [
      linked,
      `${dataRoot}/`,
      'relative',
      paths.join(dataRoot, 'missing'),
    ])
      await expect(
        createFilesystemScopeResolver({ ...options, canonicalDataRoot }),
      ).rejects.toThrow();
  } finally {
    await rm(linked);
  }
  for (const coworkManagedDirName of ['', 'canopy', '.Canopy', '../x', '.'])
    await expect(
      createFilesystemScopeResolver({ ...options, coworkManagedDirName }),
    ).rejects.toThrow('managed Cowork folder');
  for (const identity of [{ authorityId: ' ' }, { targetId: '' }])
    await expect(
      createFilesystemScopeResolver({ ...options, ...identity }),
    ).rejects.toThrow('authority and target');
});

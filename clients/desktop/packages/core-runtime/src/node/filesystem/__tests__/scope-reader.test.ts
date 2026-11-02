import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  readdir,
  lstat,
  rename,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as paths from 'node:path';
import type * as filesystem from 'node:fs/promises';
import type { WorkspaceFileRead } from '../../workspace/read-formats';
import {
  readFilesystemScope,
  type FilesystemScopeDependencies,
} from '../scope-reader';

import {
  listFilesystemScopeRoots,
  listFilesystemScopeDirectory,
  requireFilesystemCatalogRevision,
  withVerifiedFilesystemCatalog,
} from '../scope-queries';
import { readNativeRootIdentity } from '../catalog-revision';

let dataRoot: string;
let dependencies: FilesystemScopeDependencies;
const scope = { workspaceId: 'project', worktreeId: 'task' };
const entry = {
  id: 'project',
  name: 'Project',
  type: 'single-repo',
  color: '#fff',
};
const row = { id: 'task', branchName: 'topic', createdAt: 'now' };
async function json(relative: string, document: unknown): Promise<void> {
  const target = paths.join(dataRoot, relative);
  await mkdir(paths.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(document));
}
async function seed(
  type = 'single-repo',
  fields: Record<string, unknown> = {},
): Promise<void> {
  await json('workspaces/index.json', {
    version: 1,
    workspaces: [{ ...entry, type }],
  });
  await json('workspaces/project/workspace.json', {
    version: 1,
    type,
    repos: [],
    ...fields,
  });
  await json('workspaces/project/worktrees.json', {
    version: 1,
    worktrees: [row],
  });
  await mkdir(paths.join(dataRoot, 'workspaces/project/worktrees/task'), {
    recursive: true,
  });
}
beforeEach(async () => {
  dataRoot = await mkdtemp(paths.join(tmpdir(), 'can4215-'));
  dependencies = {
    dataRoot,
    authorityId: 'local',
    targetId: 'worker',
    paths,
    coworkManagedDirName: '.canopy',
    rootIdentity: readNativeRootIdentity,
  };
  await seed();
});
afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});
const invalid = { payload: { code: 'worker.filesystem.roots.invalidState' } };
const missing = { payload: { code: 'worker.filesystem.roots.notFound' } };

it('reads canonical single-repo paths without using repoPath as a checkout', async () => {
  await seed('single-repo', {
    repoPath: '/untrusted-other-checkout',
    future: { keep: true },
  });
  const catalog = await readFilesystemScope(scope, dependencies);
  expect(catalog.roots).toMatchObject([
    {
      id: 'project',
      absolutePath: paths.join(dataRoot, 'workspaces/project/worktrees/task'),
    },
  ]);
});
it('preserves ordered repo duplicates and last-root lookup, with visible attachments collision allocation', async () => {
  await seed('multi-repo', {
    sourceRepoPath: '/source',
    repos: [
      { id: 'attachments', name: 'First', repoPath: '/a' },
      { id: 'attachments', name: 'Last', repoPath: '/b' },
    ],
  });
  const attachmentPath = paths.join(
    dataRoot,
    'workspaces/project/attachments/task',
  );
  await mkdir(attachmentPath, { recursive: true });
  await writeFile(paths.join(attachmentPath, 'image.png'), 'data');
  const catalog = await readFilesystemScope(scope, dependencies);
  expect(catalog.roots.map((root) => root.id)).toEqual([
    '__workspace_root__',
    'attachments',
    'attachments',
    'canopy-attachments',
  ]);
  expect(catalog.byId.get('attachments')?.name).toBe('Last');
  expect(catalog.roots[0]?.excludedDescendantRoots[0]).toBe(
    paths.join(dataRoot, 'workspaces/project/worktrees/task/repos'),
  );
});
it.each([undefined, 'external'])(
  'reads Cowork %s with managed subroots and registered entry',
  async (external) => {
    const home = paths.join(dataRoot, external ?? 'workspaces/project/home');
    await seed('cowork', external ? { externalPath: home } : {});
    await json('workspaces/project/work-entries.json', {
      version: 1,
      entries: [{ id: 'task', createdAt: 'now', status: 'future' }],
    });
    const catalog = await readFilesystemScope(scope, dependencies);
    expect(catalog.roots[0]?.name).toBe('Project');
    expect(catalog.roots.map((root) => root.absolutePath)).toEqual([
      home,
      paths.join(home, '.canopy/notes'),
      paths.join(home, '.canopy/prompts'),
    ]);
  },
);
it.each([undefined, '', '   ', '  Vendor Spend Q3 / 支出 🌳  '])(
  'resolves Cowork index name %j with a folder fallback',
  async (name) => {
    await seed('cowork', {
      externalPath: paths.join(dataRoot, 'attached-folder'),
    });
    await json('workspaces/index.json', {
      version: 1,
      workspaces: [
        { ...entry, id: 'other', type: 'cowork', name: 'Wrong workspace' },
        { ...entry, type: 'cowork', name },
      ],
    });
    const catalog = await readFilesystemScope(
      { workspaceId: 'project', worktreeId: 'home' },
      dependencies,
    );
    expect(catalog.roots[0]).toMatchObject({
      id: 'workspace',
      name: name?.trim() || 'attached-folder',
      kind: 'standalone',
      absolutePath: paths.join(dataRoot, 'attached-folder'),
    });
  },
);
it('uses the host root path when its basename is empty', async () => {
  const home = paths.parse(dataRoot).root;
  await seed('cowork', { externalPath: home });
  await json('workspaces/index.json', {
    version: 1,
    workspaces: [{ ...entry, type: 'cowork', name: '' }],
  });
  const catalog = await readFilesystemScope(
    { workspaceId: 'project' },
    { ...dependencies, rootVisibility: () => Promise.resolve(false) },
  );
  expect(catalog.roots[0]?.name).toBe(home);
});

it('rejects absent selected records and distinguishes unreadable selected authority', async () => {
  await expect(
    readFilesystemScope({ ...scope, workspaceId: 'gone' }, dependencies),
  ).rejects.toMatchObject(missing);
  await expect(
    readFilesystemScope({ ...scope, worktreeId: 'gone' }, dependencies),
  ).rejects.toMatchObject(missing);
  await writeFile(
    paths.join(dataRoot, 'workspaces/project/workspace.json'),
    '{',
  );
  await expect(readFilesystemScope(scope, dependencies)).rejects.toMatchObject(
    invalid,
  );
});
it.each([{ id: 'other' }, { id: 'task' }, {}])(
  'handles partial worktree authority %j',
  async (bad) => {
    await json('workspaces/project/worktrees.json', {
      version: 1,
      worktrees: [row, bad],
    });
    if (bad.id === 'task')
      await expect(
        readFilesystemScope(scope, dependencies),
      ).rejects.toMatchObject(invalid);
    else
      expect(
        (await readFilesystemScope(scope, dependencies)).roots,
      ).toHaveLength(1);
    await expect(
      readFilesystemScope({ ...scope, worktreeId: 'gone' }, dependencies),
    ).rejects.toMatchObject(invalid);
  },
);
it('ignores provably unrelated malformed index rows, but rejects ambiguous selected ids', async () => {
  await json('workspaces/index.json', {
    version: 1,
    workspaces: [entry, { id: 'other' }],
  });
  expect((await readFilesystemScope(scope, dependencies)).roots).toHaveLength(
    1,
  );
  for (const bad of [{ id: 'project' }, {}, entry]) {
    await json('workspaces/index.json', {
      version: 1,
      workspaces: [entry, bad],
    });
    await expect(
      readFilesystemScope(scope, dependencies),
    ).rejects.toMatchObject(invalid);
  }
});
it.each([
  { authorityId: 'foreign' },
  { targetId: 'foreign' },
  { organizationId: 'foreign' },
  { workspaceId: '../project' },
  { worktreeId: 'C:drive' },
  { worktreeId: '..\\task' },
])('rejects foreign or unsafe scope %j', async (fields) => {
  await expect(
    readFilesystemScope({ ...scope, ...fields }, dependencies),
  ).rejects.toMatchObject(invalid);
});
it('rejects cross-workspace rows and unknown repository references', async () => {
  await expect(
    readFilesystemScope({ ...scope, repoId: 'other' }, dependencies),
  ).rejects.toMatchObject(missing);
  await json('workspaces/project/worktrees.json', {
    version: 1,
    worktrees: [{ ...row, workspaceId: 'other' }],
  });
  await expect(readFilesystemScope(scope, dependencies)).rejects.toMatchObject(
    invalid,
  );
});
it.each([2, null])(
  'rejects unsupported manifest version %s',
  async (version) => {
    await json('workspaces/project/workspace.json', { version });
    await expect(
      readFilesystemScope(scope, dependencies),
    ).rejects.toMatchObject(invalid);
  },
);
it('rejects duplicate worktree selection', async () => {
  await json('workspaces/project/worktrees.json', {
    version: 1,
    worktrees: [row, row],
  });
  await expect(readFilesystemScope(scope, dependencies)).rejects.toMatchObject(
    invalid,
  );
});

const options = { matchingRules: { isIndexExcluded: (): boolean => false } };
const directoryParams = { scope, fileRootId: 'project', relativePath: '' };
const conflict = {
  payload: { code: 'worker.filesystem.directory.revisionConflict' },
};
it('returns safe revisioned results and lists the selected directory exactly once', async () => {
  const home = paths.join(dataRoot, 'workspaces/project/worktrees/task');
  await writeFile(paths.join(home, 'file.txt'), 'data');
  const readDirectory = jest.fn(async (_root: string, target: string) =>
    readdir(target, { withFileTypes: true }),
  );
  const roots = await listFilesystemScopeRoots({ scope }, dependencies);
  const result = await listFilesystemScopeDirectory(
    {
      ...directoryParams,
      catalogRevision: requireFilesystemCatalogRevision(roots, 'roots'),
    },
    dependencies,
    {
      ...options,
      readBoundary: {
        assertDirectory: async () => {},
        readDirectory,
        lstatEntry: async (_root, target) => lstat(target),
      },
    },
  );
  expect(result.entries).toMatchObject([
    { name: 'file.txt', relativePath: 'file.txt' },
  ]);
  expect(JSON.stringify(result)).not.toContain(dataRoot);
  expect(readDirectory).toHaveBeenCalledTimes(1);
  expect(
    (await listFilesystemScopeRoots({ scope }, { ...dependencies }))
      .catalogRevision,
  ).toBe(roots.catalogRevision);
});
it.each([
  '../outside',
  'C:/outside',
  'C:outside',
  '..\\outside',
  '/outside',
  'a\0b',
])('rejects unsafe relative path %s', async (relativePath) => {
  await expect(
    listFilesystemScopeDirectory(
      { ...directoryParams, relativePath },
      dependencies,
      options,
    ),
  ).rejects.toMatchObject({
    payload: { code: 'worker.filesystem.directory.invalidState' },
  });
});
it('keeps symlink and sibling-prefix containment independent of revision', async () => {
  const home = paths.join(dataRoot, 'workspaces/project/worktrees/task');
  await mkdir(`${home}-outside`);
  await writeFile(paths.join(`${home}-outside`, 'secret'), 'private');
  await symlink(`${home}-outside`, paths.join(home, 'escape'));
  await expect(
    listFilesystemScopeDirectory(
      { ...directoryParams, relativePath: 'escape' },
      dependencies,
      options,
    ),
  ).rejects.toMatchObject({
    payload: { code: 'worker.filesystem.directory.invalidState' },
  });
  expect(
    (await listFilesystemScopeDirectory(directoryParams, dependencies, options))
      .entries,
  ).toEqual([]);
});
it('rejects revision changes before listing without opening the directory', async () => {
  let identityReads = 0;
  const rootIdentity = jest.fn(() =>
    Promise.resolve(++identityReads > 1 ? 'new' : 'old'),
  );
  const readDirectory = jest.fn(() => Promise.resolve([]));
  await expect(
    listFilesystemScopeDirectory(
      directoryParams,
      { ...dependencies, rootIdentity },
      {
        ...options,
        readBoundary: {
          assertDirectory: async () => {},
          readDirectory,
          lstatEntry: async (_root, target) => lstat(target),
        },
      },
    ),
  ).rejects.toMatchObject(conflict);
  expect(readDirectory).not.toHaveBeenCalled();
});
it('rejects deletion during listing before returning entries', async () => {
  const readDirectory = jest.fn(async () => {
    await rm(paths.join(dataRoot, 'workspaces/project/workspace.json'));
    return [];
  });
  await expect(
    listFilesystemScopeDirectory(directoryParams, dependencies, {
      ...options,
      readBoundary: {
        assertDirectory: async () => {},
        readDirectory,
        lstatEntry: async (_root, target) => lstat(target),
      },
    }),
  ).rejects.toMatchObject(conflict);
  expect(readDirectory).toHaveBeenCalledTimes(1);
});
it('rejects same-path replacement before projection and changes inside projection', async () => {
  const before = await listFilesystemScopeRoots({ scope }, dependencies);
  const revision = requireFilesystemCatalogRevision(before, 'roots');
  const home = paths.join(dataRoot, 'workspaces/project/worktrees/task');
  await rename(home, `${home}-old`);
  await mkdir(home);
  const project = jest.fn(() => Promise.resolve('projected'));
  await expect(
    withVerifiedFilesystemCatalog(
      scope,
      revision,
      dependencies,
      'directory',
      project,
    ),
  ).rejects.toMatchObject(conflict);
  expect(project).not.toHaveBeenCalled();
  const current = requireFilesystemCatalogRevision(
    await listFilesystemScopeRoots({ scope }, dependencies),
    'roots',
  );
  await expect(
    withVerifiedFilesystemCatalog(
      scope,
      current,
      dependencies,
      'directory',
      async () => {
        await seed('cowork');
        return 'stale';
      },
    ),
  ).rejects.toMatchObject(conflict);
});
it('requires an upgraded daemon for opted-in projection, without fallback', () => {
  expect(() => requireFilesystemCatalogRevision({}, 'roots')).toThrow(
    'Update the daemon',
  );
});

const TEAM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEAM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const organizationOwner = (
  organizationId: string,
): Record<string, unknown> => ({
  type: 'organization',
  organizationId,
  projectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  bindingGeneration: 0,
});

it.each([
  [undefined, TEAM_A],
  [TEAM_A, undefined],
  [TEAM_A, TEAM_B],
])(
  'rejects persisted owner %s in context %s, including omitted selectors',
  async (ownerId, organizationId) => {
    await seed(
      'single-repo',
      ownerId ? { owner: organizationOwner(ownerId) } : {},
    );
    const trusted = { ...dependencies, organizationId };
    for (const selected of [scope, { ...scope, organizationId }]) {
      await expect(
        readFilesystemScope(selected, trusted),
      ).rejects.toMatchObject(invalid);
    }
  },
);

it('accepts matching persisted ownership and rejects malformed owner authority', async () => {
  await seed('single-repo', { owner: organizationOwner(TEAM_A) });
  expect(
    (
      await readFilesystemScope(scope, {
        ...dependencies,
        organizationId: TEAM_A,
      })
    ).roots,
  ).toHaveLength(1);
  for (const owner of [
    null,
    {},
    { type: 'organization' },
    { type: 'user', organizationId: TEAM_A },
    { ...organizationOwner(TEAM_A), projectId: undefined },
  ]) {
    await seed('single-repo', { owner });
    for (const organizationId of [undefined, TEAM_A])
      await expect(
        readFilesystemScope(scope, { ...dependencies, organizationId }),
      ).rejects.toMatchObject(invalid);
  }
});

it('never treats a slug organization owner as Personal or as that organization', async () => {
  await seed('single-repo', { owner: organizationOwner('team-a') });
  for (const organizationId of [undefined, 'team-a'])
    await expect(
      readFilesystemScope(scope, { ...dependencies, organizationId }),
    ).rejects.toMatchObject(invalid);
});

it('compares the normalized persisted owner and selector with the trusted organization', async () => {
  await seed('single-repo', {
    owner: organizationOwner(` ${TEAM_A.toUpperCase()} `),
  });
  const trusted = { ...dependencies, organizationId: TEAM_A };
  for (const organizationId of [undefined, TEAM_A, TEAM_A.toUpperCase()])
    expect(
      (await readFilesystemScope({ ...scope, organizationId }, trusted)).roots,
    ).toHaveLength(1);
  for (const organizationId of ['team-a', TEAM_B])
    await expect(
      readFilesystemScope({ ...scope, organizationId }, trusted),
    ).rejects.toMatchObject(invalid);
});

it('rejects ownership reassignment before projection', async () => {
  const roots = await listFilesystemScopeRoots({ scope }, dependencies);
  await seed('single-repo', { owner: organizationOwner(TEAM_A) });
  const project = jest.fn(() => Promise.resolve('stale'));
  await expect(
    withVerifiedFilesystemCatalog(
      scope,
      requireFilesystemCatalogRevision(roots, 'roots'),
      dependencies,
      'directory',
      project,
    ),
  ).rejects.toMatchObject(conflict);
  expect(project).not.toHaveBeenCalled();
});

it.each([undefined, 'home'])(
  'rejects registered Cowork home ambiguity for selector %s',
  async (worktreeId) => {
    await seed('cowork');
    await json('workspaces/project/work-entries.json', {
      version: 1,
      entries: [{ id: 'home', createdAt: 'first' }],
    });
    await expect(
      readFilesystemScope({ ...scope, worktreeId }, dependencies),
    ).rejects.toMatchObject(invalid);
  },
);

it.each([undefined, 'home'])(
  'preserves unregistered Cowork home for selector %s',
  async (worktreeId) => {
    await seed('cowork');
    const selected = { ...scope, worktreeId };
    expect(
      (await readFilesystemScope(selected, dependencies)).containerCreatedAt,
    ).toBeNull();
    await json('workspaces/project/work-entries.json', {
      version: 1,
      entries: [{ id: 'task', createdAt: 'now' }],
    });
    expect(
      (await readFilesystemScope(selected, dependencies)).containerCreatedAt,
    ).toBeNull();
    await json('workspaces/project/work-entries.json', {
      version: 2,
      entries: [],
    });
    await expect(
      readFilesystemScope(selected, dependencies),
    ).rejects.toMatchObject(invalid);
  },
);

it.each(['x', 'revision:v2/opaque', 'x'.repeat(128)])(
  'accepts bounded opaque revision %s',
  (catalogRevision) => {
    expect(requireFilesystemCatalogRevision({ catalogRevision }, 'roots')).toBe(
      catalogRevision,
    );
  },
);

it.each([undefined, null, 42, '', 'x'.repeat(129)])(
  'rejects missing or out-of-contract revision %s',
  (catalogRevision) => {
    expect(() =>
      requireFilesystemCatalogRevision({ catalogRevision }, 'directory'),
    ).toThrow('Update the daemon');
  },
);

it.each(['single-repo', 'cowork'])(
  'rejects same-ID %s reincarnation with unchanged native roots',
  async (type) => {
    await seed(type);
    const registry = type === 'cowork' ? 'work-entries.json' : 'worktrees.json';
    const document = (createdAt: string): unknown =>
      type === 'cowork'
        ? { version: 1, entries: [{ id: 'task', createdAt }] }
        : { version: 1, worktrees: [{ ...row, createdAt }] };
    await json(`workspaces/project/${registry}`, document('first'));
    const revision = requireFilesystemCatalogRevision(
      await listFilesystemScopeRoots({ scope }, dependencies),
      'roots',
    );
    await json(`workspaces/project/${registry}`, document('replacement'));
    const project = jest.fn(() => Promise.resolve('stale'));
    await expect(
      withVerifiedFilesystemCatalog(
        scope,
        revision,
        dependencies,
        'directory',
        project,
      ),
    ).rejects.toMatchObject(conflict);
    expect(project).not.toHaveBeenCalled();
  },
);

it('lists attachments once across query and local projection, including visibility reads', async () => {
  const attachments = paths.join(
    dataRoot,
    'workspaces/project/attachments/task',
  );
  await mkdir(attachments, { recursive: true });
  await writeFile(paths.join(attachments, 'file.txt'), 'data');
  const roots = await listFilesystemScopeRoots({ scope }, dependencies);
  const reads = jest.spyOn(
    jest.requireActual<typeof filesystem>('node:fs/promises'),
    'readdir',
  );
  try {
    const result = await listFilesystemScopeDirectory(
      {
        ...directoryParams,
        fileRootId: 'attachments',
        catalogRevision: requireFilesystemCatalogRevision(roots, 'roots'),
      },
      dependencies,
      options,
    );
    expect(result.entries).toMatchObject([{ name: 'file.txt' }]);
    expect(reads).toHaveBeenCalledTimes(1);
    await withVerifiedFilesystemCatalog(
      scope,
      requireFilesystemCatalogRevision(result, 'directory'),
      dependencies,
      'directory',
      () => Promise.resolve('projected'),
    );
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    reads.mockRestore();
  }
});

it('keeps root mapping revisions independent of attachment visibility', async () => {
  const attachments = paths.join(
    dataRoot,
    'workspaces/project/attachments/task',
  );
  await mkdir(attachments, { recursive: true });
  const empty = await listFilesystemScopeRoots({ scope }, dependencies);
  expect(empty.roots.map((root) => root.fileRootId)).toEqual(['project']);
  await writeFile(paths.join(attachments, 'file.txt'), 'data');
  const visible = await listFilesystemScopeRoots({ scope }, dependencies);
  expect(visible.roots.map((root) => root.fileRootId)).toEqual([
    'project',
    'attachments',
  ]);
  expect(visible.catalogRevision).toBe(empty.catalogRevision);
});

it.each(['C:\\', '\\\\server\\share\\'])(
  'uses the injected Windows basename and root fallback for %s',
  async (home) => {
    const catalog = await readFilesystemScope(
      { workspaceId: 'project' },
      {
        ...dependencies,
        dataRoot: 'C:\\data',
        paths: paths.win32,
        rootVisibility: () => Promise.resolve(false),
        readFile: (path) =>
          Promise.resolve<WorkspaceFileRead>({
            state: 'present',
            raw: JSON.stringify(
              path.endsWith('index.json')
                ? {
                    version: 1,
                    workspaces: [{ ...entry, type: 'cowork', name: '' }],
                  }
                : path.endsWith('workspace.json')
                  ? { version: 1, type: 'cowork', externalPath: home }
                  : { version: 1, entries: [] },
            ),
          }),
      },
    );
    expect(catalog.roots[0]?.name).toBe(paths.win32.basename(home) || home);
    expect(catalog.roots[0]?.absolutePath).toBe(paths.win32.resolve(home));
  },
);

it('preserves typed failures for unavailable index reads on both read operations', async () => {
  for (const operation of ['roots', 'directory'] as const) {
    await expect(
      readFilesystemScope(
        scope,
        {
          ...dependencies,
          readFile: () =>
            Promise.resolve<WorkspaceFileRead>({ state: 'unreadable' }),
        },
        operation,
      ),
    ).rejects.toMatchObject({
      payload: { code: `worker.filesystem.${operation}.invalidState` },
    });
  }
});

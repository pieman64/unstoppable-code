// CAN-3819: the typed core.workspace.type.convert boundary. Runs the real
// sidebar and persistence modules against a temporary data dir.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../git', () => ({
  // The reference repository of a source repository is itself.
  getRepoRootFromWorktree: jest.fn((repoPath: string) =>
    Promise.resolve(repoPath),
  ),
}));

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  MultiRepoSidebarItem,
  SidebarItem,
  SingleRepoSidebarItem,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import {
  getWorkspaceConfigPath,
  getWorkspaceIndexFilePath,
  getWorkspaceWorktreesFilePath,
} from '../paths';
import * as sidebarItems from '../sidebar-items';
import {
  __resetSidebarItemsStateForTests,
  writeAllSidebarItems,
} from '../sidebar-items';
import { getWorkspaceType } from '../workspace-registry';
import {
  convertWorkspaceType,
  WorkspaceTypeConversionRefusedError,
  type WorkspaceTypeConversionRefusal,
} from '../workspace-type-conversion';

type JsonRecord = Record<string, unknown>;

const OWNER: WorkspaceOwnerBinding = {
  type: 'organization',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  bindingGeneration: 1,
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`Expected an object in ${filePath}`);
  return parsed;
}

async function indexEntry(workspaceId: string): Promise<unknown> {
  const index = await readJson(getWorkspaceIndexFilePath());
  const workspaces = Array.isArray(index.workspaces) ? index.workspaces : [];
  return workspaces.find(
    (entry: unknown) => isRecord(entry) && entry.id === workspaceId,
  );
}

async function expectRefusal(
  promise: Promise<unknown>,
  reason: WorkspaceTypeConversionRefusal,
  message: string,
): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WorkspaceTypeConversionRefusedError);
  expect(error).toMatchObject({ reason, message });
}

describe('workspace type conversion boundary (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let singleRepoPath: string;
  let sourceRepoPath: string;

  function single(overrides: Partial<SingleRepoSidebarItem> = {}): SidebarItem {
    return {
      id: 'single',
      name: 'Single',
      type: 'single-repo',
      color: '#0EA5E9',
      collapsed: false,
      order: 0,
      pinned: true,
      itemSortMode: 'last-updated',
      repoPath: singleRepoPath,
      worktrees: [],
      ...overrides,
    };
  }

  function multi(overrides: Partial<MultiRepoSidebarItem> = {}): SidebarItem {
    return {
      id: 'multi',
      name: 'Multi',
      type: 'multi-repo',
      color: '#0EA5E9',
      collapsed: false,
      order: 1,
      sourceRepoPath,
      repos: [],
      worktrees: [],
      ...overrides,
    };
  }

  function other(): SidebarItem {
    return {
      id: 'other',
      name: 'Other',
      type: 'single-repo',
      color: '#0EA5E9',
      collapsed: false,
      order: 2,
      repoPath: '/repos/other',
      worktrees: [
        {
          id: 'otter',
          branchName: 'otter',
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    };
  }

  beforeEach(async () => {
    __resetSidebarItemsStateForTests();
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-ws-convert-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    singleRepoPath = path.join(dataDir, 'src', 'single');
    sourceRepoPath = path.join(dataDir, 'src', 'multi');
    await mkdir(singleRepoPath, { recursive: true });
    await mkdir(sourceRepoPath, { recursive: true });
    await writeFile(
      path.join(sourceRepoPath, 'canopy.json'),
      JSON.stringify({
        version: 1,
        repos: [],
        scripts: { dev: 'npm run dev' },
      }),
    );
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('converts a single-repo project and rewrites no other project', async () => {
    await writeAllSidebarItems([single(), multi(), other()]);
    const manifest = await readJson(getWorkspaceConfigPath('single'));
    await writeFile(
      getWorkspaceConfigPath('single'),
      JSON.stringify({ ...manifest, futureManifestField: { kept: true } }),
    );
    // A field another writer set on the other project after the sidebar was
    // read: a whole-sidebar save would put the snapshot back.
    const otherList = await readJson(getWorkspaceWorktreesFilePath('other'));
    const otherListText = JSON.stringify({
      ...otherList,
      futureListField: 1,
    });
    await writeFile(getWorkspaceWorktreesFilePath('other'), otherListText);
    const otherManifestText = await readFile(
      getWorkspaceConfigPath('other'),
      'utf8',
    );

    await convertWorkspaceType({
      workspaceId: 'single',
      targetType: 'multi-repo',
      claudeMdMode: 'unchanged',
      source: 'workspace_settings',
    });

    expect(await readJson(getWorkspaceConfigPath('single'))).toMatchObject({
      type: 'multi-repo',
      sourceRepoPath: singleRepoPath,
      repos: [],
      itemSortMode: 'last-updated',
      futureManifestField: { kept: true },
    });
    expect(
      (await readJson(getWorkspaceConfigPath('single'))).repoPath,
    ).toBeUndefined();
    expect(await indexEntry('single')).toMatchObject({
      type: 'multi-repo',
      pinned: true,
      order: 0,
    });
    expect(
      await readJson(path.join(singleRepoPath, 'canopy.json')),
    ).toMatchObject({ version: 1, repos: [] });
    expect(
      await readFile(path.join(singleRepoPath, '.gitignore'), 'utf8'),
    ).toMatch(/^repos\/$/m);
    expect(await readFile(getWorkspaceWorktreesFilePath('other'), 'utf8')).toBe(
      otherListText,
    );
    expect(await readFile(getWorkspaceConfigPath('other'), 'utf8')).toBe(
      otherManifestText,
    );
    expect(getWorkspaceType('single')).toBe('multi-repo');
  });

  // CAN-4106: the IPC request's mode is optional. Without one, existing
  // instructions are kept and only a missing file gets the default.
  it('keeps existing instructions when no instructions mode is given', async () => {
    await writeAllSidebarItems([single()]);
    await writeFile(path.join(singleRepoPath, 'CLAUDE.md'), '# Mine\n');

    await convertWorkspaceType({
      workspaceId: 'single',
      targetType: 'multi-repo',
      source: 'workspace_settings',
    });

    expect(await readFile(path.join(singleRepoPath, 'CLAUDE.md'), 'utf8')).toBe(
      '# Mine\n',
    );
    await expect(
      readFile(path.join(singleRepoPath, 'AGENTS.md'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes default instructions when no mode is given and none exist', async () => {
    await writeAllSidebarItems([single()]);

    await convertWorkspaceType({
      workspaceId: 'single',
      targetType: 'multi-repo',
      source: 'workspace_settings',
    });

    expect(
      await readFile(path.join(singleRepoPath, 'AGENTS.md'), 'utf8'),
    ).toContain('Single');
  });

  it('leaves the manifest as it is when the index update fails', async () => {
    await writeAllSidebarItems([single(), multi()]);
    const manifestText = await readFile(
      getWorkspaceConfigPath('single'),
      'utf8',
    );
    // index.json sits directly in workspaces/, the manifest one level below:
    // a read-only workspaces/ fails only the index write.
    const workspacesDir = path.dirname(getWorkspaceIndexFilePath());
    await chmod(workspacesDir, 0o555);
    try {
      await expect(
        convertWorkspaceType({
          workspaceId: 'single',
          targetType: 'multi-repo',
          claudeMdMode: 'unchanged',
          source: 'workspace_settings',
        }),
      ).rejects.toThrow();
    } finally {
      await chmod(workspacesDir, 0o755);
    }

    expect(await indexEntry('single')).toMatchObject({ type: 'single-repo' });
    expect(await readFile(getWorkspaceConfigPath('single'), 'utf8')).toBe(
      manifestText,
    );
  });

  it('refuses while the project settings cannot be read', async () => {
    await writeAllSidebarItems([single()]);
    const indexText = await readFile(getWorkspaceIndexFilePath(), 'utf8');
    const readItems = sidebarItems.readAllSidebarItems;
    // The settings become unreadable after the sidebar read projected the
    // project.
    const spy = jest
      .spyOn(sidebarItems, 'readAllSidebarItems')
      .mockImplementationOnce(async () => {
        const read = await readItems();
        await writeFile(getWorkspaceConfigPath('single'), '{ "version": 1, ');
        return read;
      });
    try {
      await expectRefusal(
        convertWorkspaceType({
          workspaceId: 'single',
          targetType: 'multi-repo',
          claudeMdMode: 'unchanged',
          source: 'workspace_settings',
        }),
        'configuration-unavailable',
        "Couldn't read this project's settings, so it wasn't converted. Try again.",
      );
    } finally {
      spy.mockRestore();
    }
    expect(await readFile(getWorkspaceIndexFilePath(), 'utf8')).toBe(indexText);
    await expect(
      readFile(path.join(singleRepoPath, 'canopy.json'), 'utf8'),
    ).rejects.toThrow(/ENOENT/);
  });

  it('refuses while the worktree list cannot be read', async () => {
    await writeAllSidebarItems([single()]);
    const manifestText = await readFile(
      getWorkspaceConfigPath('single'),
      'utf8',
    );
    await writeFile(
      getWorkspaceWorktreesFilePath('single'),
      '{"version":1,"work',
    );

    await expectRefusal(
      convertWorkspaceType({
        workspaceId: 'single',
        targetType: 'multi-repo',
        claudeMdMode: 'unchanged',
        source: 'workspace_settings',
      }),
      'worktrees-unavailable',
      "Couldn't read this project's worktrees, so it wasn't converted. Try again.",
    );
    expect(await readFile(getWorkspaceConfigPath('single'), 'utf8')).toBe(
      manifestText,
    );
    await expect(
      readFile(path.join(singleRepoPath, 'canopy.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('converts a multi-repo project back and keeps its ownership', async () => {
    await writeAllSidebarItems([multi()]);
    const manifest = await readJson(getWorkspaceConfigPath('multi'));
    await writeFile(
      getWorkspaceConfigPath('multi'),
      JSON.stringify({ ...manifest, owner: OWNER }),
    );

    await convertWorkspaceType({
      workspaceId: 'multi',
      targetType: 'single-repo',
      source: 'workspace_settings',
    });

    const converted = await readJson(getWorkspaceConfigPath('multi'));
    expect(converted).toMatchObject({
      type: 'single-repo',
      repoPath: sourceRepoPath,
      owner: OWNER,
    });
    expect(converted.sourceRepoPath).toBeUndefined();
    expect(await indexEntry('multi')).toMatchObject({ type: 'single-repo' });
    const sourceManifest = await readJson(
      path.join(sourceRepoPath, 'canopy.json'),
    );
    expect(sourceManifest).toEqual({
      version: 1,
      scripts: { dev: 'npm run dev' },
    });
  });

  it('refuses before writing anything', async () => {
    await writeAllSidebarItems([
      single({ owner: OWNER }),
      multi({ sourceRepoPath: undefined }),
      other(),
    ]);
    const indexText = await readFile(getWorkspaceIndexFilePath(), 'utf8');

    await expectRefusal(
      convertWorkspaceType({
        workspaceId: 'single',
        targetType: 'multi-repo',
        source: 'workspace_settings',
      }),
      'organization-owned',
      "Organization projects can't be converted. Create a Multi-Repo project and add this repository instead.",
    );
    await expectRefusal(
      convertWorkspaceType({
        workspaceId: 'other',
        targetType: 'multi-repo',
        source: 'workspace_settings',
      }),
      'has-worktrees',
      'Remove all worktrees before converting this project',
    );
    await expectRefusal(
      convertWorkspaceType({
        workspaceId: 'multi',
        targetType: 'single-repo',
        source: 'workspace_settings',
      }),
      'no-source-repository',
      'Project does not have a source repository',
    );
    await expectRefusal(
      convertWorkspaceType({
        workspaceId: 'multi',
        targetType: 'multi-repo',
        source: 'workspace_settings',
      }),
      'not-found',
      'Project multi not found',
    );

    expect(await readFile(getWorkspaceIndexFilePath(), 'utf8')).toBe(indexText);
    await expect(
      readFile(path.join(singleRepoPath, 'canopy.json'), 'utf8'),
    ).rejects.toThrow(/ENOENT/);
  });
});

import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CoworkSidebarItem,
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import type * as W5Storage from '../w5-storage';
import { withStorageAdmission } from '../w5-storage';
import { recordWorkspaceCrudTelemetry } from '../desktop-telemetry';
import {
  addWorkspaceFromRemote,
  createAndPersistNewMultiRepoWorkspace,
  createNewSingleRepoWorkspace,
  importMultiRepoWorkspaceManifestFromRepo,
  importWorkspaceFromRepoPath,
  registerSingleRepoWorkspaceWithoutManifest,
} from '../workspace-service';
import { createWorkspace } from '../workspace-creation';
import { WorkspaceCreationRefusedError } from '../workspace-creation-refusal';

jest.mock('../w5-storage', () => ({
  ...jest.requireActual<typeof W5Storage>('../w5-storage'),
  withStorageAdmission: jest.fn(),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
}));
jest.mock('../workspace-service', () => ({
  addWorkspaceFromRemote: jest.fn(),
  createAndPersistNewMultiRepoWorkspace: jest.fn(),
  createNewSingleRepoWorkspace: jest.fn(),
  importMultiRepoWorkspaceManifestFromRepo: jest.fn(),
  importWorkspaceFromRepoPath: jest.fn(),
  registerSingleRepoWorkspaceWithoutManifest: jest.fn(),
}));

const mockedAdmission = jest.mocked(withStorageAdmission);
const mockedTelemetry = jest.mocked(recordWorkspaceCrudTelemetry);
const mockedNewSingle = jest.mocked(createNewSingleRepoWorkspace);
const mockedNewMulti = jest.mocked(createAndPersistNewMultiRepoWorkspace);
const mockedImportFolder = jest.mocked(importWorkspaceFromRepoPath);
const mockedImportManifest = jest.mocked(
  importMultiRepoWorkspaceManifestFromRepo,
);
const mockedRegister = jest.mocked(registerSingleRepoWorkspaceWithoutManifest);
const mockedRemote = jest.mocked(addWorkspaceFromRemote);

function singleRepo(
  id: string,
  repoPath = `/repos/${id}`,
): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id,
    name: id,
    repoPath,
    color: '#fff',
    worktrees: [],
    collapsed: false,
    order: 0,
  };
}

function multiRepo(id: string): MultiRepoSidebarItem {
  return {
    type: 'multi-repo',
    id,
    name: id,
    color: '#fff',
    repos: [],
    worktrees: [],
    collapsed: false,
    order: 0,
    sourceRepoPath: `/data/repos/${id}`,
  };
}

function cowork(id: string, externalPath: string): CoworkSidebarItem {
  return {
    type: 'cowork',
    id,
    name: id,
    color: '#fff',
    collapsed: false,
    order: 0,
    externalPath,
  };
}

let folder: string;

beforeEach(async () => {
  jest.clearAllMocks();
  mockedAdmission.mockImplementation((_targets, operation) => operation());
  folder = await mkdtemp(join(tmpdir(), 'canopy-workspace-create-'));
});

const serviceMocks = [
  mockedNewSingle,
  mockedNewMulti,
  mockedImportFolder,
  mockedImportManifest,
  mockedRegister,
  mockedRemote,
];

function expectNoEffect(): void {
  for (const service of serviceMocks) expect(service).not.toHaveBeenCalled();
  expect(mockedTelemetry).not.toHaveBeenCalled();
}

const operationIdMatcher: unknown = expect.any(String);

describe('workspace creation boundary (CAN-3806)', () => {
  describe('runs each supported variant through its desktop service', () => {
    it('creates a new single-repository project', async () => {
      mockedNewSingle.mockResolvedValue(singleRepo('app'));

      await expect(
        createWorkspace({
          source: 'new_single_repo',
          variant: { kind: 'new-single-repo', name: '  App  ' },
        }),
      ).resolves.toEqual({
        workspace: singleRepo('app'),
        clonedRepoIds: [],
        scriptActionsOperationId: operationIdMatcher,
      });

      expect(mockedNewSingle).toHaveBeenCalledWith('  App  ');
      expect(mockedTelemetry).toHaveBeenCalledWith({
        action: 'create',
        workspaceId: 'app',
        source: 'new_single_repo',
      });
    });

    it('creates a new multi-repository project and indexes it in the same call', async () => {
      mockedNewMulti.mockResolvedValue(multiRepo('suite'));

      await expect(
        createWorkspace({
          source: 'new_multi_repo',
          variant: { kind: 'new-multi-repo', name: 'Suite' },
        }),
      ).resolves.toEqual({
        workspace: multiRepo('suite'),
        clonedRepoIds: [],
        scriptActionsOperationId: operationIdMatcher,
      });

      expect(mockedNewMulti).toHaveBeenCalledWith('Suite');
    });

    it.each([
      ['a repository', singleRepo('app')],
      ['a plain folder', cowork('notes', '/folders/notes')],
    ])('imports %s from a local folder', async (_label, workspace) => {
      mockedImportFolder.mockResolvedValue(workspace);

      await expect(
        createWorkspace({
          source: 'folder',
          variant: { kind: 'local-folder', folderPath: folder },
        }),
      ).resolves.toEqual({
        workspace,
        clonedRepoIds: [],
        ...(workspace.type === 'cowork'
          ? {}
          : { scriptActionsOperationId: operationIdMatcher }),
      });

      expect(mockedImportFolder).toHaveBeenCalledWith(folder);
    });

    it('imports a multi-repository manifest and reports the clones', async () => {
      mockedImportManifest.mockResolvedValue({
        workspace: multiRepo('suite'),
        clonedRepoIds: ['api'],
      });

      await expect(
        createWorkspace({
          source: 'import_from_repo',
          variant: { kind: 'repository-manifest', repoPath: folder },
        }),
      ).resolves.toEqual({
        workspace: multiRepo('suite'),
        clonedRepoIds: ['api'],
        scriptActionsOperationId: operationIdMatcher,
      });

      expect(mockedImportManifest).toHaveBeenCalledWith(folder);
    });

    it('registers a repository without writing a manifest into it', async () => {
      mockedRegister.mockResolvedValue(singleRepo('app', folder));

      await createWorkspace({
        source: 'external_projects_import',
        variant: {
          kind: 'repository-without-manifest',
          repoPath: folder,
          name: 'App',
        },
      });

      expect(mockedRegister).toHaveBeenCalledWith(folder, 'App');
    });

    it('clones a remote repository with the caller’s progress hooks', async () => {
      mockedRemote.mockResolvedValue(singleRepo('app'));
      const progress = {
        signal: new AbortController().signal,
        onDestination: jest.fn(),
        onProgress: jest.fn(),
        onCloned: jest.fn(),
      };

      await createWorkspace({
        source: 'remote',
        variant: {
          kind: 'remote-clone',
          remoteUrl: 'https://example.com/org/app.git',
          destinationDir: folder,
          progress,
        },
      });

      expect(mockedRemote).toHaveBeenCalledWith(
        'https://example.com/org/app.git',
        folder,
        progress,
      );
    });
  });

  describe('admission refuses before any effect', () => {
    it('refuses every variant while the W5 namespaces are not writable here', async () => {
      mockedAdmission.mockRejectedValue(
        new Error('workspace_index is owned by another writer'),
      );

      await expect(
        createWorkspace({
          source: 'portal',
          variant: {
            kind: 'remote-clone',
            remoteUrl: 'https://example.com/org/app.git',
            destinationDir: folder,
          },
        }),
      ).rejects.toThrow('workspace_index is owned by another writer');
      expectNoEffect();
    });

    it.each(['new-single-repo', 'new-multi-repo'] as const)(
      'refuses a blank name for %s',
      async (kind) => {
        const result = createWorkspace({
          source: 'new_single_repo',
          variant: { kind, name: '   ' },
        });

        await expect(result).rejects.toBeInstanceOf(
          WorkspaceCreationRefusedError,
        );
        await expect(result).rejects.toMatchObject({
          reason: 'name-required',
          message: 'Project name is required',
        });
        expectNoEffect();
      },
    );

    it.each([
      ['local-folder', { kind: 'local-folder', folderPath: 'relative/app' }],
      [
        'repository-manifest',
        { kind: 'repository-manifest', repoPath: 'relative/app' },
      ],
      [
        'repository-without-manifest',
        { kind: 'repository-without-manifest', repoPath: 'relative/app' },
      ],
    ] as const)('refuses a relative path for %s', async (_label, variant) => {
      await expect(
        createWorkspace({ source: 'folder', variant }),
      ).rejects.toMatchObject({
        reason: 'invalid-path',
        message: 'repoPath must be an absolute path',
      });
      expectNoEffect();
    });

    it('refuses a relative clone destination', async () => {
      await expect(
        createWorkspace({
          source: 'remote',
          variant: {
            kind: 'remote-clone',
            remoteUrl: 'https://example.com/org/app.git',
            destinationDir: 'repos',
          },
        }),
      ).rejects.toMatchObject({
        reason: 'invalid-path',
        message: 'Destination directory must be an absolute path',
      });
      expectNoEffect();
    });

    it('refuses a blank remote URL', async () => {
      await expect(
        createWorkspace({
          source: 'remote',
          variant: {
            kind: 'remote-clone',
            remoteUrl: '  ',
            destinationDir: folder,
          },
        }),
      ).rejects.toMatchObject({
        reason: 'invalid-remote',
        message: 'Remote URL is required',
      });
      expectNoEffect();
    });

    it.each(['local-folder', 'repository-manifest'] as const)(
      'refuses a %s import of a folder that does not exist, creating nothing',
      async (kind) => {
        const missing = join(folder, 'missing');
        const variant =
          kind === 'local-folder'
            ? { kind, folderPath: missing }
            : { kind, repoPath: missing };

        await expect(
          createWorkspace({ source: 'folder', variant }),
        ).rejects.toMatchObject({
          reason: 'missing-folder',
          message: `Couldn't add the folder because it doesn't exist: ${missing}. Choose an existing folder.`,
        });
        expectNoEffect();
        expect(existsSync(missing)).toBe(false);
      },
    );

    it('refuses a path that is not a folder', async () => {
      const file = join(folder, 'notes.txt');
      await writeFile(file, 'notes');

      await expect(
        createWorkspace({
          source: 'folder',
          variant: { kind: 'local-folder', folderPath: file },
        }),
      ).rejects.toMatchObject({ reason: 'missing-folder' });
      expectNoEffect();
    });
  });

  it('records no telemetry when the service refuses', async () => {
    mockedImportFolder.mockRejectedValue(
      new WorkspaceCreationRefusedError(
        'already-tracked',
        'This repository is already tracked as project "App"',
      ),
    );

    await expect(
      createWorkspace({
        source: 'folder',
        variant: { kind: 'local-folder', folderPath: folder },
      }),
    ).rejects.toMatchObject({ reason: 'already-tracked' });
    expect(mockedTelemetry).not.toHaveBeenCalled();
  });
});

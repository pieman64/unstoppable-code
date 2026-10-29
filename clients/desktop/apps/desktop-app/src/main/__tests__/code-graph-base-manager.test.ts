import type {
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import type * as NodeCrypto from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import {
  CODE_GRAPH_CUSTOM_WASM_MAX_BYTES,
  fingerprintCustomLanguageInputs,
} from '@canopy/desktop-shared/node/code-graph/languages/custom-config';

jest.mock('../code-graph/build-runner', () => ({
  cancelBuild: jest.fn().mockResolvedValue(undefined),
  beginCodeGraphWorkerBuild: jest.fn(() => ({
    attemptId: 'base-attempt',
    promise: Promise.resolve({
      ok: false,
      message: 'mock base worker response',
    }),
  })),
  CodeGraphWorkerBuildError: class CodeGraphWorkerBuildError extends Error {
    public constructor(
      public readonly reason: string,
      message: string,
    ) {
      super(message);
    }
  },
  runCodeGraphWorkerBuild: jest.fn(),
  updateCodeGraphBuildOwners: jest.fn(),
}));
jest.mock('../lib/git', () => ({ getHeadCommitSha: jest.fn() }));
jest.mock('../lib/paths', () => {
  const nodePath = jest.requireActual<typeof path>('node:path');
  const nodeOs = jest.requireActual<{ tmpdir: typeof tmpdir }>('node:os');
  return {
    getDataDir: (): string =>
      nodePath.join(nodeOs.tmpdir(), 'canopy-code-graph-base-manager-jest'),
    getRepoShadowsRootDir: (): string => '/data/repo-shadows',
  };
});
const mockIsCodeGraphAvailableForWorkspace = jest.fn<boolean, [string]>(
  () => true,
);
jest.mock('../lib/code-graph-availability', () => ({
  CODE_GRAPH_UNAVAILABLE_MESSAGE:
    'Code graph tools are not available for this project.',
  isCodeGraphAvailableForWorkspace: (workspaceId: string): boolean =>
    mockIsCodeGraphAvailableForWorkspace(workspaceId),
}));
jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: jest.fn(
    (repoPath: string): Promise<string> => Promise.resolve(repoPath),
  ),
}));
jest.mock('../lib/repo-shadow', () => {
  const { createHash } = jest.requireActual<typeof NodeCrypto>('node:crypto');
  return {
    RepoShadowEnsureCanceledError: class RepoShadowEnsureCanceledError extends Error {},
    getRepoShadowDir: (repoRoot: string): string =>
      `/data/repo-shadows/${createHash('sha256')
        .update(repoRoot)
        .digest('hex')
        .slice(0, 16)}`,
    setRepoShadowRetirementHandler: jest.fn(),
    withEnsuredRepoShadow: jest.fn(),
  };
});

import {
  codeGraphBaseManagerTestExports,
  getCodeGraphBaseWorkspaceDescriptor,
  reconcileCodeGraphBaseAvailability,
  resolveCodeGraphBaseWorkspaceFingerprint,
  retireCodeGraphBasesForRepo,
  shutdownCodeGraphBaseManager,
  syncCodeGraphBaseRepositories,
} from '../lib/code-graph-base-manager';
import {
  allowCodeGraphBaseVariants,
  codeGraphBaseRunnerKey,
  codeGraphBaseVariantDir,
  retireCodeGraphBaseVariants,
  withCodeGraphBaseVariantLock,
  withCodeGraphBaseVariantLeases,
} from '../lib/code-graph-base-store';
import { withEnsuredRepoShadow } from '../lib/repo-shadow';
import { resolveWorkspaceReferenceRepoPath } from '../lib/workspace-reference-repo';

const single: SingleRepoSidebarItem = {
  type: 'single-repo',
  id: 'single',
  name: 'Single',
  color: '#000000',
  collapsed: false,
  order: 0,
  repoPath: '/repos/single',
  worktrees: [],
};

const multi: MultiRepoSidebarItem = {
  type: 'multi-repo',
  id: 'multi',
  name: 'Multi',
  color: '#000000',
  collapsed: false,
  order: 1,
  sourceRepoPath: '/repos/source',
  repos: [
    {
      id: 'app',
      name: 'App',
      repoPath: '/repos/app',
      source: 'local',
    },
  ],
  worktrees: [],
};

describe('code graph base manager descriptors', () => {
  beforeEach(() => {
    mockIsCodeGraphAvailableForWorkspace.mockReset();
    mockIsCodeGraphAvailableForWorkspace.mockReturnValue(true);
  });

  it('maps single, source-backed multi, and local-only multi projects', () => {
    expect(codeGraphBaseManagerTestExports.workspaceDescriptor(single)).toEqual(
      {
        workspaceId: 'single',
        customLanguageRepoPath: '/repos/single',
        repositories: [
          { repoId: WORKSPACE_ROOT_REPO_ID, repoPath: '/repos/single' },
        ],
      },
    );

    expect(codeGraphBaseManagerTestExports.workspaceDescriptor(multi)).toEqual({
      workspaceId: 'multi',
      customLanguageRepoPath: '/repos/source',
      repositories: [
        { repoId: WORKSPACE_ROOT_REPO_ID, repoPath: '/repos/source' },
        { repoId: 'app', repoPath: '/repos/app' },
      ],
    });

    expect(
      codeGraphBaseManagerTestExports.workspaceDescriptor({
        ...multi,
        sourceRepoPath: undefined,
      }),
    ).toEqual({
      workspaceId: 'multi',
      customLanguageRepoPath: null,
      repositories: [{ repoId: 'app', repoPath: '/repos/app' }],
    });
  });

  it('retains descriptors for projects preserved after a partial load', () => {
    syncCodeGraphBaseRepositories([single]);

    syncCodeGraphBaseRepositories([], new Set(['single']));

    expect(getCodeGraphBaseWorkspaceDescriptor('single')).toEqual({
      workspaceId: 'single',
      customLanguageRepoPath: '/repos/single',
      repositories: [
        { repoId: WORKSPACE_ROOT_REPO_ID, repoPath: '/repos/single' },
      ],
    });

    syncCodeGraphBaseRepositories([]);
  });

  it('retains the prepared fingerprint across restart when generation is disabled', async () => {
    const workspaceId = `retained-${process.pid}-${Date.now()}`;
    const workspace = {
      workspaceId,
      customLanguageRepoPath: null,
      repositories: [
        { repoId: WORKSPACE_ROOT_REPO_ID, repoPath: '/repos/retained' },
      ],
    };
    const prepared =
      await codeGraphBaseManagerTestExports.prepareWorkspaceCustomLanguages(
        workspace,
      );
    expect(prepared?.fingerprint).toBeDefined();

    codeGraphBaseManagerTestExports.clearPreparedCustomLanguageFingerprints();
    mockIsCodeGraphAvailableForWorkspace.mockReturnValue(false);

    await expect(
      resolveCodeGraphBaseWorkspaceFingerprint(workspace),
    ).resolves.toBe(prepared?.fingerprint);

    await rm(
      path.join(
        tmpdir(),
        'canopy-code-graph-base-manager-jest',
        'code-graph-workspace-fingerprints',
        createHash('sha256').update(workspaceId).digest('hex'),
      ),
      { force: true },
    );
  });

  it('uses globally distinct slash-free worker keys for equal variants in different shadows', () => {
    const identity = {
      repoId: WORKSPACE_ROOT_REPO_ID,
      customLanguagesFingerprint: 'same-fingerprint',
    };
    const first = codeGraphBaseRunnerKey('/repos/first', identity);
    const second = codeGraphBaseRunnerKey('/repos/second', identity);

    expect(first).not.toBe(second);
    expect(first).toMatch(/^base:[a-f0-9]+$/);
    expect(second).toMatch(/^base:[a-f0-9]+$/);
    expect(first).not.toContain('/');
    expect(second).not.toContain('/');
  });

  it('admits forced manual base refreshes to the foreground build lane', () => {
    expect(
      codeGraphBaseManagerTestExports.codeGraphBaseBuildPriority(true),
    ).toBe('agent');
    expect(
      codeGraphBaseManagerTestExports.codeGraphBaseBuildPriority(false),
    ).toBe('maintenance');
  });

  it('keeps an enabled parent multi-repo owner when an aliasing child project is disabled', async () => {
    const childWorkspace: MultiRepoSidebarItem = {
      ...multi,
      id: 'child-workspace',
      sourceRepoPath: undefined,
      repos: [
        {
          id: 'app',
          name: 'App alias',
          repoPath: '/repos/app-alias',
          source: 'local',
        },
      ],
    };
    syncCodeGraphBaseRepositories([multi, childWorkspace]);
    codeGraphBaseManagerTestExports.setPreparedCustomLanguageFingerprint(
      'multi',
      'shared-fingerprint',
    );
    codeGraphBaseManagerTestExports.setPreparedCustomLanguageFingerprint(
      'child-workspace',
      'shared-fingerprint',
    );
    jest
      .mocked(resolveWorkspaceReferenceRepoPath)
      .mockImplementation((repoPath: string) =>
        Promise.resolve(
          repoPath === '/repos/app-alias' ? '/repos/app' : repoPath,
        ),
      );
    mockIsCodeGraphAvailableForWorkspace.mockImplementation(
      (workspaceId) => workspaceId === 'multi',
    );

    await expect(
      codeGraphBaseManagerTestExports.workspaceOwnersForRepositoryVariant(
        { repoId: 'app', repoPath: '/repos/app' },
        'shared-fingerprint',
        '/repos/app',
      ),
    ).resolves.toEqual(['multi']);
    syncCodeGraphBaseRepositories([]);
  });

  it('allows equal variants from distinct canonical repositories to run concurrently', async () => {
    const identity = {
      repoId: WORKSPACE_ROOT_REPO_ID,
      customLanguagesFingerprint: 'same-fingerprint',
    };
    const firstDir = codeGraphBaseVariantDir('/repos/first', identity);
    const secondDir = codeGraphBaseVariantDir('/repos/second', identity);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const first = withCodeGraphBaseVariantLock(firstDir, async () => {
      started.push('first');
      await gate;
    });
    const second = withCodeGraphBaseVariantLock(secondDir, async () => {
      started.push('second');
      await gate;
    });
    await Promise.resolve();

    expect(started.sort()).toEqual(['first', 'second']);
    release();
    await Promise.all([first, second]);
  });

  it('drains an in-progress variant lease before shadow retirement completes', async () => {
    const repoRoot = '/repos/retiring';
    const identity = {
      repoId: WORKSPACE_ROOT_REPO_ID,
      customLanguagesFingerprint: 'fingerprint',
    };
    const variantDir = codeGraphBaseVariantDir(repoRoot, identity);
    let releaseLease!: () => void;
    const lease = withCodeGraphBaseVariantLock(
      variantDir,
      () =>
        new Promise<void>((resolve) => {
          releaseLease = resolve;
        }),
    );
    await Promise.resolve();

    let retired = false;
    const retirement = retireCodeGraphBaseVariants(repoRoot).then(() => {
      retired = true;
    });
    await Promise.resolve();
    expect(retired).toBe(false);

    releaseLease();
    await lease;
    await retirement;
    expect(retired).toBe(true);
    allowCodeGraphBaseVariants(repoRoot);
  });

  it('holds resolved eager-seed leases until the utility callback settles', async () => {
    const repoRoot = '/repos/eager-seed';
    let releaseWorker!: () => void;
    let workerStarted = false;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const seed = withCodeGraphBaseVariantLeases(
      [
        {
          canonicalRepoPath: repoRoot,
          repoId: WORKSPACE_ROOT_REPO_ID,
          customLanguagesFingerprint: 'fingerprint',
          destinationRootPath: '/worktrees/new',
        },
      ],
      async (leases) => {
        workerStarted = true;
        expect(leases).toHaveLength(1);
        expect(leases[0]?.identity.canonicalRepoRoot).toBe(repoRoot);
        expect(leases[0]?.destinationRootPath).toBe('/worktrees/new');
        await workerGate;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(workerStarted).toBe(true);

    let retired = false;
    const retirement = retireCodeGraphBaseVariants(repoRoot).then(() => {
      retired = true;
    });
    await Promise.resolve();
    expect(retired).toBe(false);

    releaseWorker();
    await seed;
    await retirement;
    expect(retired).toBe(true);
    allowCodeGraphBaseVariants(repoRoot);
  });

  it('does not let maintenance resolving its canonical path escape retirement', async () => {
    jest.mocked(withEnsuredRepoShadow).mockClear();
    let finishResolution!: (repoRoot: string) => void;
    jest.mocked(resolveWorkspaceReferenceRepoPath).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishResolution = resolve;
        }),
    );
    syncCodeGraphBaseRepositories([single]);
    const maintenance = codeGraphBaseManagerTestExports.maintainBase(
      { repoId: WORKSPACE_ROOT_REPO_ID, repoPath: single.repoPath },
      { fingerprint: 'fingerprint', snapshotPath: '/snapshot' },
    );
    await Promise.resolve();

    const releaseRetirement = await retireCodeGraphBasesForRepo(
      single.repoPath,
    );
    finishResolution(single.repoPath);
    await maintenance;

    expect(withEnsuredRepoShadow).not.toHaveBeenCalled();
    releaseRetirement();
    syncCodeGraphBaseRepositories([]);
  });

  it('aborts in-flight shadow preparation when its final owner becomes unavailable', async () => {
    syncCodeGraphBaseRepositories([single]);
    let preparationSignal: AbortSignal | undefined;
    jest.mocked(withEnsuredRepoShadow).mockImplementationOnce(
      (_repoPath, options) =>
        new Promise((_resolve, reject) => {
          preparationSignal = options.signal;
          options.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        }),
    );

    const maintenance = codeGraphBaseManagerTestExports.maintainBase(
      { repoId: WORKSPACE_ROOT_REPO_ID, repoPath: single.repoPath },
      { fingerprint: 'fingerprint', snapshotPath: '/snapshot' },
      { ownerWorkspaceIds: [single.id] },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(preparationSignal?.aborted).toBe(false);

    mockIsCodeGraphAvailableForWorkspace.mockReturnValue(false);
    await reconcileCodeGraphBaseAvailability();
    expect(preparationSignal?.aborted).toBe(true);
    await expect(maintenance).resolves.toMatchObject({ ok: false });
    syncCodeGraphBaseRepositories([]);
  });

  it('materializes immutable custom-language bytes before a child base build uses them', async () => {
    const sourceRoot = await mkdtemp(
      path.join(tmpdir(), 'code-graph-language-source-'),
    );
    try {
      const configDir = path.join(sourceRoot, '.canopy', 'code-graph');
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(configDir, 'grammar.wasm'), 'wasm-v1');
      await writeFile(path.join(configDir, 'tags.scm'), 'tags-v1');
      await writeFile(
        path.join(configDir, 'languages.json'),
        JSON.stringify({
          version: 1,
          languages: [
            {
              id: 'fixture',
              extensions: ['.fixture'],
              wasmFile: 'grammar.wasm',
              tagsFiles: ['tags.scm'],
            },
          ],
        }),
      );
      const fingerprint = await fingerprintCustomLanguageInputs(sourceRoot);
      const snapshotPath = path.join(
        tmpdir(),
        'canopy-code-graph-base-manager-jest',
        'code-graph-language-snapshots',
        fingerprint.value,
      );
      await rm(snapshotPath, { recursive: true, force: true });
      await mkdir(snapshotPath, { recursive: true });
      await writeFile(path.join(snapshotPath, 'partial'), 'interrupted-copy');
      const snapshot =
        await codeGraphBaseManagerTestExports.materializeCustomLanguageSnapshot(
          sourceRoot,
          fingerprint.value,
        );

      await rm(sourceRoot, { recursive: true, force: true });
      expect((await fingerprintCustomLanguageInputs(snapshot)).value).toBe(
        fingerprint.value,
      );
      await expect(
        readFile(
          path.join(snapshot, '.canopy', 'code-graph', 'grammar.wasm'),
          'utf8',
        ),
      ).resolves.toBe('wasm-v1');
      await expect(
        readFile(
          path.join(snapshot, '.canopy', 'code-graph', 'tags.scm'),
          'utf8',
        ),
      ).resolves.toBe('tags-v1');
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('shares concurrent custom-language snapshot materialization by fingerprint', async () => {
    const sourceRoot = await mkdtemp(
      path.join(tmpdir(), 'code-graph-language-concurrent-'),
    );
    try {
      const configDir = path.join(sourceRoot, '.canopy', 'code-graph');
      await mkdir(configDir, { recursive: true });
      await writeFile(
        path.join(configDir, 'languages.json'),
        JSON.stringify({ version: 1, languages: [] }),
      );
      const fingerprint = await fingerprintCustomLanguageInputs(sourceRoot);
      const snapshotPath = path.join(
        tmpdir(),
        'canopy-code-graph-base-manager-jest',
        'code-graph-language-snapshots',
        fingerprint.value,
      );
      await rm(snapshotPath, { recursive: true, force: true });

      const first =
        codeGraphBaseManagerTestExports.materializeCustomLanguageSnapshot(
          sourceRoot,
          fingerprint.value,
        );
      const second =
        codeGraphBaseManagerTestExports.materializeCustomLanguageSnapshot(
          sourceRoot,
          fingerprint.value,
        );

      expect(second).toBe(first);
      await expect(Promise.all([first, second])).resolves.toEqual([
        snapshotPath,
        snapshotPath,
      ]);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('refuses to snapshot an oversized custom grammar', async () => {
    const sourceRoot = await mkdtemp(
      path.join(tmpdir(), 'code-graph-language-oversize-'),
    );
    try {
      const configDir = path.join(sourceRoot, '.canopy', 'code-graph');
      await mkdir(configDir, { recursive: true });
      const wasmPath = path.join(configDir, 'grammar.wasm');
      await writeFile(wasmPath, 'x');
      await truncate(wasmPath, CODE_GRAPH_CUSTOM_WASM_MAX_BYTES + 1);
      await writeFile(path.join(configDir, 'tags.scm'), 'tags-v1');
      await writeFile(
        path.join(configDir, 'languages.json'),
        JSON.stringify({
          version: 1,
          languages: [
            {
              id: 'fixture',
              extensions: ['.fixture'],
              wasmFile: 'grammar.wasm',
              tagsFiles: ['tags.scm'],
            },
          ],
        }),
      );
      const fingerprint = await fingerprintCustomLanguageInputs(sourceRoot);

      await expect(
        codeGraphBaseManagerTestExports.materializeCustomLanguageSnapshot(
          sourceRoot,
          fingerprint.value,
        ),
      ).rejects.toThrow(/fingerprint changed/i);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('aborts shadow preparation before shutdown waits for maintenance', async () => {
    syncCodeGraphBaseRepositories([single]);
    let preparationSignal: AbortSignal | undefined;
    jest.mocked(withEnsuredRepoShadow).mockImplementationOnce(
      (_repoPath, options) =>
        new Promise((_resolve, reject) => {
          preparationSignal = options.signal;
          options.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted for shutdown')),
            { once: true },
          );
        }),
    );
    const maintenance = codeGraphBaseManagerTestExports.maintainBase(
      { repoId: WORKSPACE_ROOT_REPO_ID, repoPath: single.repoPath },
      { fingerprint: 'fingerprint', snapshotPath: '/snapshot' },
      { ownerWorkspaceIds: [single.id] },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(preparationSignal?.aborted).toBe(false);

    await expect(shutdownCodeGraphBaseManager()).resolves.toBeUndefined();
    expect(preparationSignal?.aborted).toBe(true);
    await expect(maintenance).resolves.toMatchObject({ ok: false });
  });
});

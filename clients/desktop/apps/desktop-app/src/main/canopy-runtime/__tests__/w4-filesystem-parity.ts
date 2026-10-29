import {
  acquireW4Within,
  settleW4LateReleases,
  W4Resources,
} from './w4-acquisition';
import {
  WorkerFilesystemDirectoryListResultSchema,
  WorkerFilesystemRootsListResultSchema,
  type CanopyWorkspaceScope,
} from '@canopy/protocol/canopy-core';
import {
  WORKSPACE_ROOT_REPO_ID,
  type FileTreeDirectoryResponse,
  type FileTreeEntry,
  type FileTreeRoot,
  type FileTreeRootsResponse,
} from '@canopy/desktop-shared/types';
import type { PortalServiceErrorCode } from '../../services/portal-service-error';
import { createWorkerFilesystemAdapter } from '../worker-filesystem-adapter';
import {
  assertW4Parity,
  createW4FilesystemFixtureServices,
  createW4ParitySession,
  type W4FilesystemFixture,
  type W4FilesystemServiceInputs,
  type W4FixtureError,
  type W4ParityBackend,
  type W4ParityBinding,
  type W4ParitySession,
  type W4ParitySessionOptions,
} from './w4-parity-harness';

jest.mock('../../services/files-service', () => ({
  listFileTreeRoots: jest.fn(),
  listFileTreeDirectory: jest.fn(),
}));

const ROOTS = 'worker.filesystem.roots.list';
const DIRECTORY = 'worker.filesystem.directory.list';
export type Operation = typeof ROOTS | typeof DIRECTORY;
const SCOPE = { workspaceId: 'workspace-1', worktreeId: 'worktree-1' };

const root = (
  repoId: string,
  repoName: string,
  rootKind: FileTreeRoot['rootKind'],
): FileTreeRoot => ({
  repoId,
  repoName,
  absolutePath: `/h/${repoId}`,
  rootKind,
});
// Service order is deliberately unsorted; parity must preserve it.
const RICH_ROOTS: FileTreeRootsResponse = {
  roots: [
    root('zeta-repo', 'Zeta', 'git-repo'),
    root(WORKSPACE_ROOT_REPO_ID, 'Workspace “root” ✓', 'workspace-root'),
    root('attachments', 'Attachments', 'attachments'),
    root('alpha', '', 'standalone'),
  ],
};

const entry = (
  name: string,
  flags: Partial<FileTreeEntry> = {},
): FileTreeEntry => ({
  name,
  relativePath: `src/${name}`,
  absolutePath: `/h/repo/src/${name}`,
  kind: 'file',
  isIgnored: false,
  isIndexExcluded: false,
  isSymlink: false,
  hasChildren: false,
  ...flags,
});
const RICH_ENTRIES: FileTreeDirectoryResponse = {
  entries: [
    entry('zz-last', { kind: 'directory', hasChildren: true }),
    entry('.env', { isIgnored: true, isIndexExcluded: true }),
    entry('naïve 文件.ts'),
    entry('link', { isSymlink: true, kind: 'directory' }),
    entry('Alpha.md', { isIndexExcluded: true }),
    entry('empty-dir', { kind: 'directory' }),
  ],
};

function queryDaemon(
  session: W4ParitySession,
  operation: Operation,
  scope: CanopyWorkspaceScope,
  relativePath = 'src',
): Promise<unknown> {
  return operation === ROOTS
    ? session.client.query(ROOTS, { scope })
    : session.client.query(DIRECTORY, {
        scope,
        fileRootId: 'repo-1',
        relativePath,
      });
}

export interface W4FilesystemCase {
  name: string;
  operation: Operation;
  fixture: W4FilesystemFixture;
  scope?: CanopyWorkspaceScope;
  relativePath?: string;
}

/**
 * Runs one case against an independent direct adapter and the selected
 * backend, each provisioned with the same fixture. Returns the backend's
 * service inputs, which must equal the direct side's.
 */
export async function runW4FilesystemCase(
  session: W4ParitySession,
  backend: W4ParityBackend,
  {
    name,
    operation,
    fixture,
    scope = SCOPE,
    relativePath = 'src',
  }: W4FilesystemCase,
): Promise<W4FilesystemServiceInputs> {
  const direct = createW4FilesystemFixtureServices();
  await direct.driver.serve(fixture);
  await backend.filesystem.serve(fixture);
  const adapter = createWorkerFilesystemAdapter(direct.services);
  await assertW4Parity(
    name,
    async () =>
      operation === ROOTS
        ? adapter[ROOTS]({ scope }, undefined)
        : adapter[DIRECTORY](
            { scope, fileRootId: 'repo-1', relativePath },
            undefined,
          ),
    () => queryDaemon(session, operation, scope, relativePath),
  );
  const inputs = await backend.filesystem.serviceInputs();
  expect(inputs).toEqual(await direct.driver.serviceInputs());
  return inputs;
}

export const W4_FILESYSTEM_SUCCESS_CASES: readonly W4FilesystemCase[] = [
  {
    name: 'roots: every kind in service order',
    operation: ROOTS,
    fixture: { roots: RICH_ROOTS },
  },
  { name: 'roots: empty', operation: ROOTS, fixture: { roots: { roots: [] } } },
  {
    name: 'roots: explicit local authority',
    operation: ROOTS,
    fixture: { roots: RICH_ROOTS },
    scope: { ...SCOPE, authorityId: 'local-desktop' },
  },
  {
    name: 'directory: rich entries in service order',
    operation: DIRECTORY,
    fixture: { entries: RICH_ENTRIES },
  },
  {
    name: 'directory: empty listing',
    operation: DIRECTORY,
    fixture: { entries: { entries: [] } },
  },
  {
    name: 'directory: repository root path',
    operation: DIRECTORY,
    fixture: { entries: RICH_ENTRIES },
    relativePath: '',
  },
];

const portal = (code: PortalServiceErrorCode): W4FixtureError => ({
  type: 'portal',
  code,
});
const ERROR_CASES: ReadonlyArray<[string, string, W4FixtureError]> = [
  ['invalid_payload', 'invalid_argument', portal('invalid_payload')],
  ['invalid_target', 'invalid_argument', portal('invalid_target')],
  ['not_found', 'not_found', portal('not_found')],
  ['execution_failed', 'internal', portal('execution_failed')],
  [
    'identifier validation',
    'invalid_argument',
    {
      type: 'identifier-validation',
      message: 'Invalid projectId: must be lowercase',
    },
  ],
  [
    'unexpected error',
    'internal',
    { type: 'unexpected', message: 'sensitive failure' },
  ],
];

const PLACEMENT_CASES: ReadonlyArray<[string, string, CanopyWorkspaceScope]> = [
  ['remote target', 'capability_unavailable', { ...SCOPE, targetId: 'w' }],
  [
    'foreign authority',
    'capability_unavailable',
    { ...SCOPE, authorityId: 'foreign' },
  ],
  ['missing workspaceId', 'invalid_argument', { worktreeId: 'worktree-1' }],
  ['missing worktreeId', 'invalid_argument', { workspaceId: 'workspace-1' }],
];

// Rewrites one valid field so the client still accepts the wire result.
const plantDivergence: W4ParitySessionOptions['mutateResult'] = (
  method,
  result,
) => {
  if (method === ROOTS)
    return {
      roots: WorkerFilesystemRootsListResultSchema.parse(result).roots.map(
        (item, index) => ({
          fileRootId: item.fileRootId,
          name: index === 1 ? 'Diverged' : item.name,
          kind: item.kind,
        }),
      ),
    };
  if (method !== DIRECTORY) return result;
  const { entries } = WorkerFilesystemDirectoryListResultSchema.parse(result);
  return {
    entries: entries.map((item, index) => ({
      name: item.name,
      relativePath: item.relativePath,
      kind: item.kind,
      isIgnored: index === 0 ? !item.isIgnored : item.isIgnored,
      isIndexExcluded: item.isIndexExcluded,
      isSymlink: item.isSymlink,
      hasChildren: item.hasChildren,
    })),
  };
};

const PLANTED: Record<Operation, [W4FilesystemFixture, RegExp]> = {
  [ROOTS]: [{ roots: RICH_ROOTS }, /but daemon result .*"Diverged"/],
  [DIRECTORY]: [
    { entries: RICH_ENTRIES },
    /but daemon result \{"entries":\[\{"name":"zz-last",[^}]*"isIgnored":true/,
  ],
};
export const W4_PLANTED_DIVERGENCES: ReadonlyArray<[Operation]> = [
  [ROOTS],
  [DIRECTORY],
];

/** A schema-valid planted divergence must make parity fail. */
export async function assertW4PlantedDivergence(
  backend: W4ParityBackend,
  operation: Operation,
): Promise<void> {
  const [fixture, rx] = PLANTED[operation];
  const planted = await createW4ParitySession(backend, {
    mutateResult: plantDivergence,
  });
  try {
    await expect(
      runW4FilesystemCase(planted, backend, {
        name: 'planted',
        operation,
        fixture,
      }),
    ).rejects.toThrow(rx);
  } finally {
    await planted.disconnect();
  }
}

export function runW4FilesystemParity(binding: W4ParityBinding): void {
  describe(`W4 filesystem parity over ${binding.name} binding`, () => {
    let backend: W4ParityBackend;
    let shutdown: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      shutdown = undefined;
      backend = await acquireW4Within(
        binding.start(),
        (value) => value.shutdown(),
        'filesystem backend',
      );
      shutdown = (): Promise<void> => backend.shutdown();
    });
    afterAll(() => shutdown?.());
    afterAll(() => settleW4LateReleases());

    let session: W4ParitySession;
    let disconnect: (() => Promise<void>) | undefined;
    beforeEach(async () => {
      disconnect = undefined;
      session = await createW4ParitySession(backend);
      disconnect = (): Promise<void> => session.disconnect();
    });
    afterEach(() => disconnect?.());
    afterEach(() => settleW4LateReleases());

    it('advertises the backend operations at handshake', () => {
      const required = ['core.chat.snapshot.get', DIRECTORY, ROOTS];
      expect([...backend.expected.operations]).toEqual(
        expect.arrayContaining(required),
      );
      expect([...session.client.manifest.operations].sort()).toEqual(
        [...backend.expected.operations].sort(),
      );
      expect([...backend.expected.streams]).toContain('core.chat.events');
      expect([...session.client.manifest.streams].sort()).toEqual(
        [...backend.expected.streams].sort(),
      );
      expect(session.client.identity.authorityId).toBe('local-desktop');
    });

    it.each(W4_FILESYSTEM_SUCCESS_CASES)('$name', async (testCase) => {
      const inputs = await runW4FilesystemCase(session, backend, testCase);
      const called = testCase.operation === ROOTS ? 'roots' : 'directory';
      expect(inputs[called]).toHaveLength(1);
      expect(inputs[called === 'roots' ? 'directory' : 'roots']).toEqual([]);
    });

    describe.each<[Operation]>([[ROOTS], [DIRECTORY]])(
      '%s errors',
      (operation) => {
        it.each(ERROR_CASES)('%s maps to %s', async (name, kind, error) => {
          const label = `${operation}: ${name}`;
          await runW4FilesystemCase(session, backend, {
            name: label,
            operation,
            fixture: { error },
          });
          await expect(
            queryDaemon(session, operation, SCOPE),
          ).rejects.toMatchObject({ payload: { kind } });
        });

        it.each(PLACEMENT_CASES)(
          'unsupported placement: %s maps to %s',
          async (name, kind, scope) => {
            const inputs = await runW4FilesystemCase(session, backend, {
              name: `${operation}: ${name}`,
              operation,
              scope,
              fixture: { roots: RICH_ROOTS, entries: RICH_ENTRIES },
            });
            await expect(
              queryDaemon(session, operation, scope),
            ).rejects.toMatchObject({ payload: { kind } });
            expect(inputs).toEqual({ roots: [], directory: [] });
          },
        );
      },
    );

    it.each(W4_PLANTED_DIVERGENCES)(
      'planted divergence fails %s parity',
      (operation) => assertW4PlantedDivergence(backend, operation),
    );
    it('rejects untyped failures, missing results, and outcome mismatches', async () => {
      const typed = (kind: 'not_found' | 'internal'): Promise<never> =>
        Promise.reject(
          Object.assign(new Error(kind), {
            payload: { kind, message: kind, retry: { kind: 'never' } },
          }),
        );
      const plain = (): Promise<never> => Promise.reject(new Error('plain'));
      const empty = (): Promise<undefined> => Promise.resolve(undefined);
      const object = (): Promise<object> => Promise.resolve({});
      await expect(
        assertW4Parity('untyped', () => typed('internal'), plain),
      ).rejects.toThrow('daemon failed without a typed error payload');
      await expect(assertW4Parity('missing', empty, object)).rejects.toThrow(
        'direct returned no result',
      );
      await expect(
        assertW4Parity(
          'kind',
          () => typed('not_found'),
          () => typed('internal'),
        ),
      ).rejects.toThrow(/direct error kind not_found .* but daemon error kind/);
      await expect(
        assertW4Parity('outcome', object, () => typed('internal')),
      ).rejects.toThrow(/direct result \{\} but daemon error kind internal/);
    });
  });
}

export async function runW4FilesystemCaseOverBinding(
  binding: W4ParityBinding,
  caseName: string,
  options: W4ParitySessionOptions = {},
): Promise<W4FilesystemServiceInputs> {
  const testCase = W4_FILESYSTEM_SUCCESS_CASES.find(
    (value) => value.name === caseName,
  );
  if (!testCase) throw new Error(`Unknown case ${caseName}.`);
  const resources = new W4Resources();
  try {
    const backend = await resources.own(
      await acquireW4Within(
        binding.start(),
        (value) => value.shutdown(),
        'filesystem backend',
      ),
      (value) => value.shutdown(),
    );
    const session = await resources.own(
      await createW4ParitySession(backend, options),
      (value) => value.disconnect(),
    );
    const result = await runW4FilesystemCase(session, backend, testCase);
    await resources.close();
    return result;
  } catch (error) {
    return resources.fail(error, 'W4 case and cleanup failed');
  }
}

export type W4FilesystemFault = 'fixture' | 'service inputs';

export function runW4FilesystemControlChecks(
  binding: W4ParityBinding,
  hooks: {
    /** Called when the targeted fault runs, so callers can order it. */
    reached?: (fault: W4FilesystemFault) => void;
    assertReady?: (fault: W4FilesystemFault) => void;
  } = {},
): void {
  describe(`W4 filesystem negative controls: ${binding.name}`, () => {
    afterEach(() => settleW4LateReleases());
    it.each<W4FilesystemFault>(['fixture', 'service inputs'])(
      'fails when the backend ignores %s',
      async (fault) => {
        let reached = false;
        const reach = (): void => {
          reached = true;
          hooks.reached?.(fault);
        };
        const faulty: W4ParityBinding = {
          name: `ignore ${fault}`,
          async start() {
            const backend = await binding.start();
            const filesystem = { ...backend.filesystem };
            if (fault === 'fixture')
              filesystem.serve = (): Promise<void> => {
                reach();
                return Promise.resolve();
              };
            else
              filesystem.serviceInputs =
                (): Promise<W4FilesystemServiceInputs> => {
                  reach();
                  return Promise.resolve({ roots: [], directory: [] });
                };
            return { ...backend, filesystem };
          },
        };
        await expect(
          runW4FilesystemCaseOverBinding(
            faulty,
            fault === 'fixture'
              ? 'roots: every kind in service order'
              : 'directory: rich entries in service order',
          ),
        ).rejects.toThrow(
          fault === 'fixture'
            ? /but daemon result \{"roots":\[\]\}/
            : /toEqual/,
        );
        expect(reached).toBe(true);
        hooks.assertReady?.(fault);
      },
    );
  });
}

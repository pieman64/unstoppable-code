import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import * as coreLocks from '@canopy/core-runtime/node/w5/repository-locks';
import * as coreScope from '@canopy/core-runtime/node/w5/commit-scope';
import * as coreFileStore from '@canopy/core-runtime/node/w5/file-store';
import * as coreRevisionDiff from '@canopy/core-runtime/node/w5/revision-diff';
import * as coreCommitLogFileStore from '@canopy/core-runtime/node/w5/commit-log-file-store';
import {
  admitLifecycleJournals as coreAdmitLifecycleJournals,
  type W5ReceiptStore,
} from '@canopy/core-runtime/node/w5/keyed-operation';
import type { W5ReceiptLookup } from '@canopy/core-runtime/node/w5/commit-log';
import { bindW5Storage } from '@canopy/core-runtime/node/w5/storage-binding';
import type { W5StorageTarget } from '@canopy/core-runtime/node/w5/storage-target';
import { W5CommitRefusedError } from '@canopy/core-runtime/node/w5/commit-log/errors';
import * as storageAdmission from '@canopy/desktop-shared/node/lib/storage-admission';
import { W5CommitRefusedError as DesktopCommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import * as atomicFile from '../atomic-file';
import type { AtomicFileStorage } from '../atomic-file';
import * as desktopLocks from '../w5-repository-locks';
import * as desktopScope from '../w5-commit-scope';
import * as desktopFileStore from '../w5-file-store';
import * as desktopRevisionDiff from '../w5-revision-diff';
import * as desktopStorage from '../w5-storage';
import * as desktopCommitLogFileStore from '../w5-commit-log-file-store';
import * as mainProcessLogging from '../main-process-logging';
import {
  admitLifecycleJournals,
  runKeyedW5Operation,
} from '../w5-keyed-operation';
import { createW5SingleDecisionOperation } from '../w5-single-decision-operation';
import { w5ExpectedRevision as coreW5ExpectedRevision } from '@canopy/core-runtime/node/w5/boundary-operation';
import {
  checkW5ExpectedRevision,
  runW5BoundaryOperation,
  w5ExpectedRevision,
} from '../w5-boundary-operation';
import { IdentifierValidationError } from '../validation';
import * as coreComposition from '@canopy/core-runtime/node/w5/composition-operation';
import * as coreCompositionOutcome from '@canopy/core-runtime/node/w5/composition-outcome';
import * as desktopComposition from '../w5-composition-operation';
import * as coreIndexRepository from '@canopy/core-runtime/node/w5/workspace-index-repository';
import * as coreManifestRepository from '@canopy/core-runtime/node/w5/workspace-manifest-repository';
import * as coreListRepository from '@canopy/core-runtime/node/w5/worktree-list-repository';
import * as coreReplicaCodec from '@canopy/core-runtime/node/w5/worktree-replica-codec';
import * as coreReplicaRecord from '@canopy/core-runtime/node/w5/worktree-replica-record';
import * as desktopIndexRepository from '../workspace-index-repository';
import * as desktopManifestRepository from '../workspace-manifest-repository';
import * as desktopListRepository from '../worktree-list-repository';
import * as desktopReplicaCodec from '../worktree-replica-codec';
import * as desktopReplicaRecord from '../worktree-replica-record';
import * as paths from '../paths';
import type { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';

function barrier(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const lock: coreLocks.W5RepositoryLock = { kind: 'manifest', path: '/w5/a' };
const operation = { operation: 'test.mixed-imports', locks: [lock] };
const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
const corePackageRoot = resolve(
  __dirname,
  '../../../../../../packages/core-runtime',
);

it('re-exports the same functions and existing error constructors', () => {
  expect(desktopLocks).toEqual(coreLocks);
  expect(desktopScope).toEqual(coreScope);
  expect(DesktopCommitRefusedError).toBe(W5CommitRefusedError);
  const { nodeW5FileStore, ...fileStore } = desktopFileStore;
  expect(fileStore).toEqual(coreFileStore);
  expect(Object.keys(nodeW5FileStore).sort()).toEqual(['read', 'replace']);
  expect(desktopRevisionDiff).toEqual(coreRevisionDiff);
  expect(desktopCommitLogFileStore.W5FileWriteRefusedError).toBe(
    coreCommitLogFileStore.W5FileWriteRefusedError,
  );
  expect(desktopCommitLogFileStore.W5RevisionConflictError).toBe(
    coreCommitLogFileStore.W5RevisionConflictError,
  );
  expect(desktopCommitLogFileStore.w5ResourceKey).toBe(
    coreCommitLogFileStore.w5ResourceKey,
  );
  expect(admitLifecycleJournals).toBe(coreAdmitLifecycleJournals);
  expect(w5ExpectedRevision).toBe(coreW5ExpectedRevision);
});

it('binds the desktop commit-log store to the caller host lookup and desktop services', async () => {
  const create = jest.spyOn(
    coreCommitLogFileStore,
    'createW5CommitLogFileStore',
  );
  const read = jest
    .spyOn(desktopFileStore.nodeW5FileStore, 'read')
    .mockResolvedValue({ state: 'absent' });
  const admit = jest
    .spyOn(desktopStorage, 'admitW5Storage')
    .mockImplementation((_targets, run) => run());
  const admitWrite = jest
    .spyOn(storageAdmission, 'admitStorageWrite')
    .mockImplementation((_target, run) => run());
  const warn = jest
    .spyOn(mainProcessLogging, 'logMainProcessWarn')
    .mockImplementation(() => {});
  const getHost = (): Promise<W5CommitLogHost> =>
    Promise.reject(new Error('unused'));
  try {
    desktopCommitLogFileStore.createW5CommitLogFileStore(getHost);
    const bindings = create.mock.calls[0]?.[0];
    if (!bindings) throw new Error('Missing core store bindings');
    // The lookup itself, so the shared queue keys on the host it returns.
    expect(bindings.getHost).toBe(getHost);
    bindings.warn('W5 commit requires recovery', { commitId: 1 });
    expect(warn).toHaveBeenCalledWith('W5 commit requires recovery', {
      commitId: 1,
    });
    await expect(bindings.readFile('/w5/a')).resolves.toEqual({
      state: 'absent',
    });
    expect(read).toHaveBeenCalledWith('/w5/a');
    const targets = [desktopStorage.WORKSPACE_INDEX_STORAGE];
    await bindings.admit(targets, () => Promise.resolve());
    expect(admit).toHaveBeenCalledWith(targets, expect.any(Function));
    await bindings.admitWrite(targets[0], () => Promise.resolve());
    expect(admitWrite).toHaveBeenCalledWith(targets[0], expect.any(Function));
  } finally {
    create.mockRestore();
    read.mockRestore();
    admit.mockRestore();
    admitWrite.mockRestore();
    warn.mockRestore();
  }
});

function receiptStore(...lookups: W5ReceiptLookup[]): W5ReceiptStore & {
  calls: string[];
  receipts: unknown[];
} {
  const calls: string[] = [];
  const receipts: unknown[] = [];
  return {
    calls,
    receipts,
    lookupReceipt: (receipt): Promise<W5ReceiptLookup> => {
      calls.push('lookup');
      receipts.push(receipt);
      return Promise.resolve(lookups.shift() ?? { status: 'none' });
    },
    reserve: (): Promise<void> => {
      calls.push('reserve');
      return Promise.resolve();
    },
    releaseReservation: (): Promise<void> => {
      calls.push('release');
      return Promise.resolve();
    },
    markReservationRecoveryRequired: (): Promise<void> => {
      calls.push('recovery');
      return Promise.resolve();
    },
  };
}

const decodeId = (outcome: unknown): { id: string } => {
  if (
    typeof outcome === 'object' &&
    outcome !== null &&
    'id' in outcome &&
    typeof outcome.id === 'string'
  )
    return { id: outcome.id };
  throw new Error('Unexpected outcome');
};

it('binds the desktop keyed runner to the receipt store at call time', async () => {
  const first = receiptStore();
  const second = receiptStore(
    { status: 'none' },
    { status: 'replay', commitId: 1, outcome: { id: 'winner' } },
  );
  const lookup = jest
    .spyOn(desktopCommitLogFileStore, 'getW5ReceiptStore')
    .mockReturnValueOnce(first)
    .mockReturnValueOnce({
      ...second,
      // The core runner reclassifies the desktop-shared refusal constructor.
      reserve: (): Promise<void> =>
        Promise.reject(
          new DesktopCommitRefusedError('in-progress', 'Reserved.'),
        ),
    });
  const input = {
    caller: 'desktop-host:test',
    operation: 'test.keyed',
    idempotencyKey: 'key-1',
    parameters: {},
    isPreEffectRefusal: (): boolean => false,
  };
  try {
    await expect(
      runKeyedW5Operation(input, decodeId, () => Promise.resolve({ id: 'a' })),
    ).resolves.toEqual({ id: 'a' });
    await expect(
      runKeyedW5Operation(input, decodeId, () => Promise.resolve({ id: 'b' })),
    ).resolves.toEqual({ id: 'winner' });
    expect(first.calls).toEqual(['lookup', 'reserve']);
    expect(second.calls).toEqual(['lookup', 'lookup']);
    expect(lookup).toHaveBeenCalledTimes(2);
  } finally {
    lookup.mockRestore();
  }
});

it('binds desktop single decisions to desktop-host callers, desktop admission and refusals', async () => {
  const run = createW5SingleDecisionOperation<'settings'>(() => false);
  const stores: Array<ReturnType<typeof receiptStore>> = [];
  const lookup = jest
    .spyOn(desktopCommitLogFileStore, 'getW5ReceiptStore')
    .mockImplementation(() => {
      const store = receiptStore();
      stores.push(store);
      return store;
    });
  const admit = jest
    .spyOn(storageAdmission, 'withStorageAdmission')
    .mockImplementation((_targets, operation) => operation());
  const storage = [desktopStorage.WORKSPACE_INDEX_STORAGE];
  const attempt = (failure: Error): Promise<{ id: string }> =>
    run(
      {
        operation: 'test.single-decision',
        source: 'settings',
        idempotencyKey: 'key-1',
        parameters: () => ({ value: 1 }),
        storage,
      },
      () => Promise.resolve('admitted'),
      decodeId,
      () => Promise.reject(failure),
    );
  try {
    const refusals = [
      new IdentifierValidationError('Invalid workspace ID'),
      new desktopCommitLogFileStore.W5FileWriteRefusedError('/w5/a'),
      new desktopCommitLogFileStore.W5RevisionConflictError('w', 1, 2),
    ];
    for (const refusal of refusals)
      await expect(attempt(refusal)).rejects.toBe(refusal);
    const failure = new Error('uncertain');
    await expect(attempt(failure)).rejects.toBe(failure);
    expect(stores.map((store) => store.calls.at(-1))).toEqual([
      'release',
      'release',
      'release',
      'recovery',
    ]);
    expect(stores[0]?.receipts[0]).toMatchObject({
      caller: 'desktop-host:settings',
      operation: 'test.single-decision',
      idempotencyKey: 'key-1',
    });
    expect(admit).toHaveBeenCalledTimes(4);
    expect(admit).toHaveBeenCalledWith(storage, expect.any(Function));
  } finally {
    lookup.mockRestore();
    admit.mockRestore();
  }
});

it('binds the desktop boundary runner to the keyed runner, commit and refusals at call time', async () => {
  const stores: Array<ReturnType<typeof receiptStore>> = [];
  const lookup = jest
    .spyOn(desktopCommitLogFileStore, 'getW5ReceiptStore')
    .mockImplementation(() => {
      const store = receiptStore();
      stores.push(store);
      return store;
    });
  const commit = jest
    .spyOn(desktopCommitLogFileStore, 'withW5Commit')
    .mockImplementation((_options, work) => work());
  const input = (
    idempotencyKey: string,
  ): Parameters<typeof runW5BoundaryOperation>[0] => ({
    operation: 'test.boundary',
    caller: 'desktop-host:test',
    idempotencyKey,
    parameters: {},
    isPreEffectRefusal: (): boolean => false,
  });
  const refusal = new IdentifierValidationError('Invalid worktree ID');
  try {
    await expect(
      runW5BoundaryOperation(input('key-1'), decodeId, () =>
        Promise.resolve({ id: 'a', hostOnly: '/w5' }),
      ),
    ).resolves.toEqual({ id: 'a' });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[0]).toMatchObject({
      operation: 'test.boundary',
      outcome: { id: 'a' },
      expectedRevisions: undefined,
    });
    await expect(
      runW5BoundaryOperation(input('key-2'), decodeId, () =>
        Promise.reject(refusal),
      ),
    ).rejects.toBe(refusal);
    expect(stores.map((store) => store.calls.at(-1))).toEqual([
      'reserve',
      'release',
    ]);
  } finally {
    lookup.mockRestore();
    commit.mockRestore();
  }
});

it('checks desktop expected revisions through the desktop revision reads at call time', async () => {
  const resource = {
    kind: 'worktree',
    workspaceId: 'ws',
    worktreeId: 'wt',
  } as const;
  const read = jest
    .spyOn(desktopCommitLogFileStore, 'readW5Revisions')
    .mockResolvedValue([{ resource, revision: 2 }]);
  try {
    await expect(checkW5ExpectedRevision(resource, 2)).resolves.toBeUndefined();
    await expect(checkW5ExpectedRevision(resource, 1)).rejects.toBeInstanceOf(
      desktopCommitLogFileStore.W5RevisionConflictError,
    );
    expect(read).toHaveBeenCalledWith([resource]);
  } finally {
    read.mockRestore();
  }
});

it('re-exports core composition decoding and binds its helpers to desktop paths, commit and revision reads at call time', async () => {
  expect(desktopComposition.admitW5Composition).toBe(
    coreComposition.admitW5Composition,
  );
  expect(desktopComposition.decodeW5CompositionOutcome).toBe(
    coreCompositionOutcome.decodeW5CompositionOutcome,
  );
  expect(desktopComposition.w5PromoteOutcomeParser).toBe(
    coreCompositionOutcome.w5PromoteOutcomeParser,
  );
  expect(desktopComposition.w5CombineOutcomeParser).toBe(
    coreCompositionOutcome.w5CombineOutcomeParser,
  );
  expect(desktopComposition.w5ExistingCombineOutcomeParser).toBe(
    coreCompositionOutcome.w5ExistingCombineOutcomeParser,
  );
  const resource = { kind: 'workspace', workspaceId: 'ws' } as const;
  const index = jest
    .spyOn(paths, 'getWorkspaceIndexFilePath')
    .mockReturnValue('/host/index.json');
  const manifest = jest
    .spyOn(paths, 'getWorkspaceConfigPath')
    .mockImplementation((id) => `/host/${id}/workspace.json`);
  const list = jest
    .spyOn(paths, 'getWorkspaceWorktreesFilePath')
    .mockImplementation((id) => `/host/${id}/worktrees.json`);
  const read = jest
    .spyOn(desktopCommitLogFileStore, 'readW5Revisions')
    .mockResolvedValue([{ resource, revision: 2 }]);
  const commit = jest
    .spyOn(desktopCommitLogFileStore, 'withW5Commit')
    .mockImplementation((_options, work) => work());
  try {
    const locks = desktopComposition.w5CompositionLocks({
      index: true,
      manifests: ['ws'],
      lists: ['ws'],
    });
    expect(locks).toEqual([
      { kind: 'index', path: '/host/index.json' },
      { kind: 'manifest', path: '/host/ws/workspace.json' },
      { kind: 'list', path: '/host/ws/worktrees.json' },
    ]);
    await expect(
      desktopComposition.checkW5CompositionRevisions({
        operation: 'test.composition',
        expectedRevisions: [{ resource, revision: 1 }],
      }),
    ).rejects.toBeInstanceOf(desktopCommitLogFileStore.W5RevisionConflictError);
    expect(read).toHaveBeenCalledWith([resource]);
    const options = {
      operation: 'test.composition',
      expectedRevisions: [{ resource, revision: 2 }],
    };
    await expect(
      desktopComposition.commitW5BoundaryStep(options, locks, () =>
        Promise.resolve('recorded'),
      ),
    ).resolves.toBe('recorded');
    expect(commit).toHaveBeenCalledWith(
      { ...options, locks },
      expect.any(Function),
    );
    // A spied commit opens no scope, so nothing was staged to advance.
    expect(options.expectedRevisions).toEqual([{ resource, revision: 2 }]);
  } finally {
    index.mockRestore();
    manifest.mockRestore();
    list.mockRestore();
    read.mockRestore();
    commit.mockRestore();
  }
});

it('re-exports the core repositories and replica codec and binds the desktop sections and rows', async () => {
  expect(desktopReplicaCodec).toEqual(coreReplicaCodec);
  expect(desktopReplicaRecord).toEqual(coreReplicaRecord);
  expect(desktopIndexRepository.WorkspaceIndexUnreadableError).toBe(
    coreIndexRepository.WorkspaceIndexUnreadableError,
  );
  expect(desktopManifestRepository.WorkspaceConfigUnreadableError).toBe(
    coreManifestRepository.WorkspaceConfigUnreadableError,
  );
  expect(desktopListRepository.WorktreeRegistryUnreadableError).toBe(
    coreListRepository.WorktreeRegistryUnreadableError,
  );
  const createIndex = jest.spyOn(
    coreIndexRepository,
    'createWorkspaceIndexRepository',
  );
  const createManifest = jest.spyOn(
    coreManifestRepository,
    'createWorkspaceManifestRepository',
  );
  const createList = jest.spyOn(
    coreListRepository,
    'createWorktreeListRepository',
  );
  const files = new Map([
    [
      '/w5/index.json',
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'ws',
            name: 'Project',
            type: 'single-repo',
            color: 'blue',
            collapsed: false,
            order: 0,
            activitySectionOrder: ['pull-request', 'unknown', 'summary'],
          },
        ],
      }),
    ],
    [
      '/w5/ws/worktrees.json',
      JSON.stringify({
        version: 1,
        worktrees: [
          { id: 'tree', branchName: 'main', createdAt: 'now', future: 1 },
        ],
      }),
    ],
  ]);
  const store: desktopFileStore.W5FileStore = {
    read: (filePath) => {
      const raw = files.get(filePath);
      return Promise.resolve(
        raw === undefined ? { state: 'absent' } : { state: 'present', raw },
      );
    },
    replace: () => Promise.reject(new Error('unused')),
  };
  try {
    const index = desktopIndexRepository.createWorkspaceIndexRepository({
      store,
      filePath: () => '/w5/index.json',
      storage: desktopStorage.WORKSPACE_INDEX_STORAGE,
      onCommitted: () => {},
      onRefused: () => {},
    });
    expect(createIndex.mock.calls[0]?.[0].normalizeActivitySectionOrder).toBe(
      desktopIndexRepository.normalizeActivitySectionOrder,
    );
    await expect(index.read()).resolves.toMatchObject({
      authority: 'ok',
      entries: [
        { id: 'ws', activitySectionOrder: ['pull-request', 'summary'] },
      ],
    });
    desktopManifestRepository.createWorkspaceManifestRepository({
      store,
      filePath: (id) => `/w5/${id}/workspace.json`,
      storage: desktopStorage.WORKSPACE_MANIFEST_STORAGE,
      knownFields: new Set(),
      knownRepoFields: new Set(),
    });
    expect(createManifest).toHaveBeenCalledTimes(1);
    const list = desktopListRepository.createWorktreeListRepository({
      store,
      filePath: (id) => `/w5/${id}/worktrees.json`,
      storage: desktopStorage.WORKTREE_LIST_STORAGE,
      knownRowFields: new Set(),
    });
    expect(createList).toHaveBeenCalledTimes(1);
    // Desktop rows keep every stored field, as the list reader always has.
    await expect(list.read('ws')).resolves.toMatchObject({
      authority: 'ok',
      worktrees: [
        {
          id: 'tree',
          future: 1,
          replica: { state: 'never-recorded' },
        },
      ],
    });
  } finally {
    createIndex.mockRestore();
    createManifest.mockRestore();
    createList.mockRestore();
  }
});

it('binds desktop storage to electron_main and the shared admission', () => {
  expect(desktopStorage.withStorageAdmission).toBe(
    storageAdmission.withStorageAdmission,
  );
  const { admit, ...targets } = bindW5Storage(
    'electron_main',
    storageAdmission.withStorageAdmission,
  );
  expect(admit).toBe(desktopStorage.withStorageAdmission);
  expect(desktopStorage.admitW5Storage).toBe(admit);
  const desktopTargets = [
    desktopStorage.WORKSPACE_INDEX_STORAGE,
    desktopStorage.WORKSPACE_MANIFEST_STORAGE,
    desktopStorage.WORKTREE_LIST_STORAGE,
  ];
  expect(desktopTargets).toEqual([
    targets.workspaceIndex,
    targets.workspaceManifest,
    targets.worktreeList,
  ]);
  expect(desktopStorage.PROJECT_W5_STORAGE).toEqual(targets.project);
  desktopStorage.PROJECT_W5_STORAGE.forEach((target, index) =>
    expect(target).toBe(desktopTargets[index]),
  );
});

it('writes direct-store files through the desktop atomic writer without durability', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'w5-direct-store-'));
  const write = atomicFile.writeFileAtomically;
  const spy = jest
    .spyOn(atomicFile, 'writeFileAtomically')
    .mockImplementation((...args) => write(...args));
  const target = resolve(root, 'nested', 'workspace-index.json');
  const backup = resolve(root, 'nested', 'workspace-index.json.bak');
  const storage = desktopStorage.WORKSPACE_INDEX_STORAGE;
  try {
    await desktopStorage.withStorageAdmission([storage], () =>
      desktopFileStore.nodeW5FileStore.replace(target, 'next', storage, {
        operation: 'test.direct-store',
        advance: [],
        previousRaw: null,
        backup: { path: backup, contents: 'previous', previousRaw: null },
      }),
    );
    expect(spy.mock.calls).toEqual([
      [backup, 'previous', { encoding: 'utf8', storage }],
      [target, 'next', { encoding: 'utf8', storage }],
    ]);
    expect(await readFile(backup, 'utf8')).toBe('previous');
    expect(await readFile(target, 'utf8')).toBe('next');
  } finally {
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('observes desktop lock calls from a canonical export spy', async () => {
  const acquire = coreLocks.withW5RepositoryLock;
  const spy = jest
    .spyOn(coreLocks, 'withW5RepositoryLock')
    .mockImplementation((...args) => acquire(...args));
  try {
    await desktopLocks.withW5RepositoryLock(lock, () => Promise.resolve());
    expect(spy).toHaveBeenCalledWith(lock, expect.any(Function));
  } finally {
    spy.mockRestore();
  }
});

it('observes desktop storage admission from a shared export spy', async () => {
  const admit = storageAdmission.withStorageAdmission;
  const spy = jest
    .spyOn(storageAdmission, 'withStorageAdmission')
    .mockImplementation((...args) => admit(...args));
  const targets = [desktopStorage.WORKSPACE_INDEX_STORAGE];
  try {
    await desktopStorage.withStorageAdmission(targets, () => Promise.resolve());
    expect(spy).toHaveBeenCalledWith(targets, expect.any(Function));
  } finally {
    spy.mockRestore();
  }
});

// The W5 file repositories and the replica codec they write through.
const W5_FILE_ENTRIES: readonly string[] = [
  'worktree-replica-codec',
  'worktree-replica-record',
  'workspace-index-repository',
  'workspace-manifest-repository',
  'worktree-list-repository',
];

it.each([
  'repository-locks',
  'commit-scope',
  'storage-target',
  'file-store',
  'revision-diff',
  'storage-binding',
  'commit-log-file-store',
  'keyed-operation',
  'single-decision-operation',
  'boundary-operation',
  'worktree-outcome',
  'composition-operation',
  'composition-outcome',
  'stored-outcome-projection',
  'host-path-fingerprint',
  ...W5_FILE_ENTRIES,
])(
  'exports the canonical %s module through Node package resolution',
  (name) => {
    // Jest's moduleNameMapper bypasses package exports; use Node's resolver.
    const requireFromCore = createRequire(
      resolve(corePackageRoot, 'package.json'),
    );
    expect(
      requireFromCore.resolve(`@canopy/core-runtime/node/w5/${name}`),
    ).toBe(resolve(corePackageRoot, `src/node/w5/${name}.ts`));
  },
);

const bundledResolverCases: ReadonlyArray<{
  label: string;
  alias?: Record<string, string>;
}> = [
  { label: 'package exports' },
  {
    label: 'desktop main source alias',
    alias: { '@canopy/core-runtime': resolve(corePackageRoot, 'src') },
  },
];

it.each(bundledResolverCases)(
  'bundles $label into one lock, scope, helper and admission instance',
  async ({ alias }) => {
    const result = await build({
      stdin: {
        resolveDir: __dirname,
        contents: `
        import * as desktopLocks from '../w5-repository-locks';
        import * as coreLocks from '@canopy/core-runtime/node/w5/repository-locks';
        import * as desktopScope from '../w5-commit-scope';
        import * as coreScope from '@canopy/core-runtime/node/w5/commit-scope';
        import * as desktopFileStore from '../w5-file-store';
        import * as coreFileStore from '@canopy/core-runtime/node/w5/file-store';
        import * as desktopRevisionDiff from '../w5-revision-diff';
        import * as coreRevisionDiff from '@canopy/core-runtime/node/w5/revision-diff';
        import { withStorageAdmission as desktopAdmission } from '../w5-storage';
        import { withStorageAdmission as sharedAdmission } from '@canopy/desktop-shared/node/lib/storage-admission';
        import { createW5CommitLogFileStore } from '@canopy/core-runtime/node/w5/commit-log-file-store';
        import { W5CommitRefusedError as sharedRefusal } from '@canopy/desktop-shared/node/w5-commit-log/errors';
        import { W5FileWriteRefusedError } from '@canopy/core-runtime/node/w5/commit-log-file-store';
        import { createW5KeyedOperationRunner } from '@canopy/core-runtime/node/w5/keyed-operation';
        import { createW5SingleDecisionOperation } from '@canopy/core-runtime/node/w5/single-decision-operation';
        if (desktopLocks.withW5RepositoryLock !== coreLocks.withW5RepositoryLock ||
            desktopScope.runW5Commit !== coreScope.runW5Commit ||
            desktopScope.w5CommitsSettling !== coreScope.w5CommitsSettling) {
          throw new Error('Duplicate W5 runtime in bundled imports');
        }
        if (desktopFileStore.isJsonObject !== coreFileStore.isJsonObject ||
            desktopFileStore.createSerialQueue !== coreFileStore.createSerialQueue ||
            desktopRevisionDiff.diffW5Rows !== coreRevisionDiff.diffW5Rows ||
            desktopAdmission !== sharedAdmission) {
          throw new Error('Duplicate W5 helpers in bundled imports');
        }
        // The core store's refusal must match the desktop-shared constructor.
        const host = {
          root: '/w5',
          recoveryReport: async () => ({ applied: [], recoveryRequired: [], interruptedReservations: 0 }),
          commit: async () => ({ status: 'recovery-required', commitId: 1, revisions: {} }),
        };
        const store = createW5CommitLogFileStore({
          getHost: () => host,
          warn: () => {},
          readFile: async () => ({ state: 'absent' }),
          admit: (_targets, run) => run(),
          admitWrite: (_target, run) => run(),
        });
        module.exports.refusal = store
          .replace('/w5/index.json', 'next', { namespace: 'workspace_index', writer: 'electron_main' }, { operation: 'test', advance: [], previousRaw: null })
          .then(
            () => { throw new Error('Expected a recovery-required refusal'); },
            (error) => {
              if (!(error instanceof sharedRefusal)) throw new Error('Duplicate W5 commit-log errors in bundled imports');
            },
          );
        // The keyed runner reclassifies the desktop-shared refusal, and the
        // single-decision runner releases the store's own conflict.
        const calls = [];
        const lookups = [{ status: 'none' }, { status: 'replay', commitId: 1, outcome: 'winner' }, { status: 'none' }];
        const runKeyed = createW5KeyedOperationRunner({
          getReceiptStore: () => ({
            lookupReceipt: async () => lookups.shift(),
            reserve: async () => {
              calls.push('reserve');
              if (calls.length === 1) throw new sharedRefusal('in-progress', 'Reserved.');
            },
            releaseReservation: async () => { calls.push('release'); },
            markReservationRecoveryRequired: async () => { calls.push('recovery'); },
          }),
        });
        const runSingle = createW5SingleDecisionOperation({
          runKeyed,
          admitStorage: (_targets, run) => run(),
          caller: (source) => 'bundle:' + source,
          isHostRefusal: () => false,
        }, () => false);
        const single = (failure) => runSingle(
          { operation: 'test', source: 'bundle', idempotencyKey: 'key', parameters: () => ({}) },
          async () => undefined,
          (outcome) => outcome,
          async () => { throw failure; },
        );
        const conflict = new W5FileWriteRefusedError('/w5/a');
        module.exports.keyed = single(new Error('unused')).then(async (winner) => {
          if (winner !== 'winner') throw new Error('Duplicate W5 refusal in bundled keyed runner');
          await single(conflict).then(
            () => { throw new Error('Expected the conflict'); },
            (error) => { if (error !== conflict) throw error; },
          );
          if (calls.join() !== 'reserve,reserve,release')
            throw new Error('Duplicate W5 conflict in bundled single decision: ' + calls.join());
        });
      `,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      alias,
      write: false,
      logLevel: 'silent',
    });
    const bundled = result.outputFiles?.[0]?.text;
    if (!bundled) throw new Error('Missing W5 identity bundle');
    const module: {
      exports: { refusal?: Promise<void>; keyed?: Promise<void> };
    } = { exports: {} };
    expect((): void => {
      // A Node main bundle has `process`; the W5 host cohort reads it at load.
      runInNewContext(bundled, {
        process,
        require: createRequire(resolve(__dirname, '../w5-commit-scope.ts')),
        module,
        exports: module.exports,
      });
    }).not.toThrow();
    await expect(module.exports.refusal).resolves.toBeUndefined();
    await expect(module.exports.keyed).resolves.toBeUndefined();
  },
);

it.each(
  [
    'commit-log-file-store',
    'keyed-operation',
    'single-decision-operation',
    'boundary-operation',
    'worktree-outcome',
    'composition-operation',
    'composition-outcome',
    ...W5_FILE_ENTRIES,
  ].flatMap((entry) =>
    bundledResolverCases.map((resolver) => ({ ...resolver, entry })),
  ),
)(
  'bundles the $label $entry entrypoint without node:sqlite',
  async ({ alias, entry }) => {
    const result = await build({
      entryPoints: [`@canopy/core-runtime/node/w5/${entry}`],
      absWorkingDir: __dirname,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      alias,
      metafile: true,
      write: false,
      logLevel: 'silent',
    });
    const inputs = Object.entries(result.metafile.inputs);
    expect(inputs.map(([path]) => path)).toContainEqual(
      expect.stringMatching(new RegExp(`w5/${entry}\\.ts$`)),
    );
    const imports = inputs.flatMap(([, input]) =>
      input.imports.map((entry) => entry.path),
    );
    // The outcome decoders are pure; the runners' and replica minting's
    // graphs reach node:crypto.
    if (entry === 'worktree-outcome' || entry === 'composition-outcome')
      expect(imports.filter((path) => path.startsWith('node:'))).toEqual([]);
    else if (
      !W5_FILE_ENTRIES.includes(entry) ||
      entry === 'worktree-replica-record' ||
      entry === 'worktree-list-repository'
    )
      expect(imports).toContain('node:crypto');
    expect(imports).not.toContain('node:sqlite');
  },
);

it('carries structural storage targets through both scope entrypoints', () => {
  const target: W5StorageTarget = {
    namespace: 'workspace_index',
    writer: 'electron_main',
  };
  const atomic: AtomicFileStorage = target;
  const roundTrip: W5StorageTarget = atomic;
  const scopeStorage: coreScope.W5CommitScope['storage'] = new Map([
    [lock.path, roundTrip],
  ]);
  const desktopStorage: desktopScope.W5CommitScope['storage'] = scopeStorage;
  expect(desktopStorage.get(lock.path)).toBe(target);
});

describe.each([
  ['desktop to core', desktopScope, coreScope, desktopLocks, coreLocks],
  ['core to desktop', coreScope, desktopScope, coreLocks, desktopLocks],
] as const)('%s', (_name, outerScope, innerScope, outerLocks, innerLocks) => {
  it('serializes same-file writers while unrelated files proceed', async () => {
    const entered = barrier();
    const release = barrier();
    const events: string[] = [];
    const first = outerLocks.withW5RepositoryLock(lock, async () => {
      expect(innerLocks.ownsW5RepositoryLock()).toBe(true);
      entered.open();
      await release.promise;
      events.push('first');
    });
    await entered.promise;
    const second = innerLocks.withW5RepositoryLock(
      { ...lock, kind: 'list' },
      () => {
        events.push('second');
        return Promise.resolve();
      },
    );
    try {
      await innerLocks.withW5RepositoryLock({ ...lock, path: '/w5/b' }, () => {
        events.push('unrelated');
        return Promise.resolve();
      });
      await tick();
      expect(events).toEqual(['unrelated']);
    } finally {
      release.open();
      await Promise.all([first, second]);
    }
    expect(events).toEqual(['unrelated', 'first', 'second']);
    expect(innerLocks.ownsW5RepositoryLock()).toBe(false);
  });

  it('shares reservations, joins reentrant tasks and serializes sibling tasks', async () => {
    await outerLocks.withW5RepositoryLocks([lock, lock], async () => {
      await innerLocks.withW5RepositoryLocks([lock], async () => {
        const events: number[] = [];
        await Promise.all(
          [1, 2].map((value) =>
            innerLocks.withW5RepositoryLock(lock, async () => {
              events.push(value);
              await outerLocks.withW5RepositoryLock(
                lock,
                async () => {
                  await tick();
                },
                { join: true },
              );
              events.push(value);
            }),
          ),
        );
        expect(events).toEqual([1, 1, 2, 2]);
      });
    });
  });

  it('sorts initial locks, allows empty sets and refuses inverse kind and path ordering', async () => {
    const index: coreLocks.W5RepositoryLock = {
      kind: 'index',
      path: '/w5/index',
    };
    const list: coreLocks.W5RepositoryLock = { kind: 'list', path: '/w5/list' };
    const earlier: coreLocks.W5RepositoryLock = { ...lock, path: '/w5/0' };
    await outerLocks.withW5CommitLocks(
      [list, lock, earlier, index],
      async () => {
        await innerLocks.acquireW5RepositoryLocks([index, earlier, lock, list]);
      },
    );
    await expect(
      outerLocks.withW5CommitLocks([], () => Promise.resolve(7)),
    ).resolves.toBe(7);
    for (const inverse of [index, earlier]) {
      await expect(
        outerLocks.withW5CommitLocks([lock], () =>
          innerLocks.withW5RepositoryLock(inverse, () => Promise.resolve()),
        ),
      ).rejects.toThrow('W5 commit lock order');
      await innerLocks.withW5RepositoryLock(lock, () => Promise.resolve());
    }
  });

  it('joins same-store scopes and rejects cross-store and nested keyed decisions', async () => {
    const store = {};
    const commit = jest.fn(() => Promise.resolve());
    const nestedCommit = jest.fn(() => Promise.resolve());
    const expected = { resource: { kind: 'workspaces' as const }, revision: 2 };
    await outerScope.runW5Commit(
      store,
      operation,
      async () => {
        const outer = outerScope.currentW5CommitScope();
        expect(innerScope.currentW5CommitScope()).toBe(outer);
        await innerScope.runW5Commit(
          store,
          { operation: 'nested', expectedRevisions: [expected] },
          () => {
            innerScope.setW5CommitOutcome('joined');
            return Promise.resolve();
          },
          nestedCommit,
        );
        expect(outer?.options.expectedRevisions).toEqual([expected]);
        expect(outer?.options.outcome).toBe('joined');
        await expect(
          innerScope.runW5Commit(
            {},
            operation,
            () => Promise.resolve(),
            nestedCommit,
          ),
        ).rejects.toThrow('cannot span stores');
        for (const keyed of [
          { reservationId: 'key' },
          {
            receipt: {
              caller: 'test',
              operation: 'nested',
              idempotencyKey: 'key',
              fingerprint: 'fingerprint',
            },
          },
        ]) {
          await expect(
            innerScope.runW5Commit(
              store,
              { ...operation, ...keyed },
              () => Promise.resolve(),
              nestedCommit,
            ),
          ).rejects.toThrow('keyed W5 decision');
        }
      },
      commit,
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(nestedCommit).not.toHaveBeenCalled();
    expect(innerScope.currentW5CommitScope()).toBeUndefined();
    expect(() => innerScope.setW5CommitOutcome(null)).toThrow(
      'requires a commit scope',
    );
  });

  it('exits both scope and lock contexts through either import', async () => {
    const callbacks: string[] = [];
    await outerScope.runW5Commit(
      {},
      operation,
      async () => {
        const enclosing = innerScope.currentW5CommitScope();
        await innerScope.outsideW5CommitScope(async () => {
          expect(outerScope.currentW5CommitScope()).toBeUndefined();
          expect(outerLocks.ownsW5RepositoryLock()).toBe(false);
          await outerScope.afterW5Apply(() => {
            callbacks.push('apply immediately');
          });
          await outerScope.afterW5Commit(() => {
            callbacks.push('commit immediately');
          });
        });
        expect(innerScope.currentW5CommitScope()).toBe(enclosing);
        expect(callbacks).toEqual(['apply immediately', 'commit immediately']);
      },
      () => Promise.resolve(),
    );
  });

  it('refuses detached descendants after their scope closes', async () => {
    const gate = barrier();
    const store = {};
    let descendant: Promise<void> = Promise.resolve();
    await outerScope.runW5Commit(
      store,
      operation,
      () => {
        descendant = gate.promise.then(async () => {
          expect(() => innerScope.currentW5CommitScope()).toThrow(
            'has finished',
          );
          const work = jest.fn(() => Promise.resolve());
          const undo = jest.fn(() => {});
          await expect(
            innerScope.runW5Commit(store, operation, work, work),
          ).rejects.toThrow('has finished');
          await expect(innerScope.afterW5Apply(work)).rejects.toThrow(
            'has finished',
          );
          await expect(innerScope.afterW5Commit(work)).rejects.toThrow(
            'has finished',
          );
          expect(() => innerScope.onW5Abort(undo)).toThrow('has finished');
          await expect(
            innerLocks.withW5RepositoryLock(lock, work),
          ).rejects.toThrow('have finished');
          expect(work).not.toHaveBeenCalled();
          expect(undo).not.toHaveBeenCalled();
        });
        return Promise.resolve();
      },
      () => Promise.resolve(),
    );
    gate.open();
    await descendant;
  });

  it('shares staging, application locks and settling until post-commit work ends', async () => {
    const staged = barrier();
    const apply = barrier();
    const releaseApply = barrier();
    const releasePost = barrier();
    const post = barrier();
    const events: string[] = [];
    const committing = outerScope.runW5Commit(
      {},
      operation,
      async () => {
        const scope = innerScope.currentW5CommitScope();
        if (!scope) throw new Error('Missing shared scope');
        scope.files.set(lock.path, {
          path: lock.path,
          contents: 'new',
          previousRaw: null,
        });
        await innerScope.afterW5Apply(async () => {
          expect(innerLocks.ownsW5RepositoryLock()).toBe(true);
          events.push('apply');
          apply.open();
          await releaseApply.promise;
        });
        await innerScope.afterW5Commit(async () => {
          expect(innerLocks.ownsW5RepositoryLock()).toBe(false);
          events.push('post');
          post.open();
          await releasePost.promise;
        });
        events.push('staged');
        staged.open();
      },
      () => {
        events.push('commit');
        return Promise.resolve();
      },
    );
    let waiter: Promise<void> = Promise.resolve();
    let waiterSettling: Promise<void>[] = [];
    try {
      await staged.promise;
      waiter = innerLocks.withW5RepositoryLock(lock, () => {
        events.push('waiter');
        waiterSettling = innerScope.w5CommitsSettling(lock.path);
        return Promise.resolve();
      });
      await apply.promise;
      await tick();
      expect(events).toEqual(['staged', 'commit', 'apply']);
      expect(innerScope.w5CommitsSettling(lock.path)).toEqual([]);
      releaseApply.open();
      await post.promise;
      const settling = innerScope.w5CommitsSettling(lock.path);
      expect(settling).toEqual(outerScope.w5CommitsSettling(lock.path));
      expect(settling).toHaveLength(1);
      await waiter;
      expect(waiterSettling).toEqual(settling);
      releasePost.open();
      await committing;
      await Promise.all(settling);
      expect(innerScope.w5CommitsSettling(lock.path)).toEqual([]);
    } finally {
      releaseApply.open();
      releasePost.open();
      await Promise.all([committing, waiter]);
    }
  });

  it('retains overlapping settling entries when one post-commit callback fails', async () => {
    const firstPost = barrier();
    const secondPost = barrier();
    const releaseFirst = barrier();
    const releaseSecond = barrier();
    const failure = new Error('second post-commit failed');
    const otherPath = '/w5/other';
    const stage = (api: typeof coreScope, paths: string[]): void => {
      const scope = api.currentW5CommitScope();
      if (!scope) throw new Error('Missing shared scope');
      for (const path of paths) {
        scope.files.set(path, { path, contents: 'new', previousRaw: null });
      }
    };
    const first = outerScope.runW5Commit(
      {},
      operation,
      async () => {
        stage(innerScope, [lock.path, otherPath]);
        await innerScope.afterW5Commit(async () => {
          firstPost.open();
          await releaseFirst.promise;
        });
      },
      () => Promise.resolve(),
    );
    let second: Promise<void> = Promise.resolve();
    try {
      await firstPost.promise;
      const firstSettling = innerScope.w5CommitsSettling(lock.path);
      expect(firstSettling).toHaveLength(1);
      expect(innerScope.w5CommitsSettling(otherPath)).toEqual(firstSettling);
      second = expect(
        innerScope.runW5Commit(
          {},
          operation,
          async () => {
            stage(outerScope, [lock.path]);
            await outerScope.afterW5Commit(async () => {
              secondPost.open();
              await releaseSecond.promise;
              throw failure;
            });
          },
          () => Promise.resolve(),
        ),
      ).rejects.toBe(failure);
      await secondPost.promise;
      const overlapping = outerScope.w5CommitsSettling(lock.path);
      expect(overlapping).toHaveLength(2);
      expect(innerScope.w5CommitsSettling(lock.path)).toEqual(overlapping);
      expect(new Set(overlapping).size).toBe(2);
      expect(firstSettling).toHaveLength(1);
      const secondSettling = overlapping.filter(
        (entry) => !firstSettling.includes(entry),
      );
      releaseSecond.open();
      await second;
      await Promise.all(secondSettling);
      expect(innerScope.w5CommitsSettling(lock.path)).toEqual(firstSettling);
      expect(innerScope.w5CommitsSettling(otherPath)).toEqual(firstSettling);
      releaseFirst.open();
      await first;
      await Promise.all(firstSettling);
      expect(innerScope.w5CommitsSettling(lock.path)).toEqual([]);
      expect(innerScope.w5CommitsSettling(otherPath)).toEqual([]);
    } finally {
      releaseFirst.open();
      releaseSecond.open();
      await Promise.all([first, second]);
    }
  });

  it.each(['work', 'commit', 'undo', 'apply', 'post'] as const)(
    'preserves cleanup and callback short-circuiting after %s failure',
    async (phase) => {
      const failure = new Error(phase);
      const events: string[] = [];
      const run = outerScope.runW5Commit(
        {},
        operation,
        async () => {
          const scope = innerScope.currentW5CommitScope();
          if (!scope) throw new Error('Missing shared scope');
          scope.files.set(lock.path, {
            path: lock.path,
            contents: 'new',
            previousRaw: null,
          });
          innerScope.onW5Abort(() => {
            events.push('undo-first');
          });
          innerScope.onW5Abort(() => {
            expect(innerLocks.ownsW5RepositoryLock()).toBe(true);
            events.push('undo-last');
            if (phase === 'undo') throw failure;
          });
          await innerScope.afterW5Apply(() => {
            events.push('apply');
            if (phase === 'apply') throw failure;
          });
          await innerScope.afterW5Commit(() => {
            events.push('post');
            if (phase === 'post') throw failure;
          });
          await innerScope.afterW5Commit(() => {
            events.push('later');
          });
          if (phase === 'work' || phase === 'undo') throw failure;
        },
        () => {
          events.push('commit');
          if (phase === 'commit') throw failure;
          return Promise.resolve();
        },
      );
      await expect(run).rejects.toBe(failure);
      const expected =
        phase === 'work'
          ? ['undo-last', 'undo-first']
          : phase === 'undo'
            ? ['undo-last']
            : phase === 'commit'
              ? ['commit', 'undo-last', 'undo-first']
              : phase === 'apply'
                ? ['commit', 'apply']
                : ['commit', 'apply', 'post'];
      expect(events).toEqual(expected);
      expect(innerScope.w5CommitsSettling(lock.path)).toEqual([]);
      await innerLocks.withW5RepositoryLock(lock, () => Promise.resolve());
    },
  );
});

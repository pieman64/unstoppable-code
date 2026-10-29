import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
// Same real worker/filesystem harness as part 4, with production command callers.
import { W5CommitLog } from '@canopy/desktop-shared/node/w5-commit-log';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
}));

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { withStorageAdmission, PROJECT_W5_STORAGE } from '../w5-storage';

import {
  createWorkspace,
  type WorkspaceCreationRequest,
} from '../workspace-creation';

import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
} from '../sidebar-items';
import { createCoworkWorkspace } from '../cowork-workspace-crud';
import { workspaceCreationDiagnosticsSchema } from '../w5-workspace-creation-diagnostics';
import * as git from '../git';

import { setBeforeProjectPluginDefaultsChangeHandler } from '../workspace-persistence';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture());
  execFileSync('git', ['clone', '-q', repo, join(dir, 'import-repo')]);
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  mkdirSync(join(dir, 'notes'));
  writeFileSync(join(dir, 'notes', 'sentinel.txt'), 'user-owned');
  jest.clearAllMocks();
});
afterEach(async () => {
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function restartHost(): void {
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
}

it('keeps the original folder-link identity across keyed replay and rejects changed raw input', async () => {
  const remoteUrl = 'https://github.com/cursor/plugins/tree/linked/pstack';
  const clone = jest
    .spyOn(git, 'cloneRepo')
    .mockImplementation((remote, destination) => {
      expect(remote).toBe('https://github.com/cursor/plugins');
      execFileSync('git', ['clone', '-q', repo, destination]);
      return Promise.resolve();
    });
  const input = {
    source: 'remote',
    variant: {
      kind: 'remote-clone',
      remoteUrl,
      destinationDir: join(dir, 'clones'),
    },
    idempotencyKey: 'folder-link-replay',
  } satisfies WorkspaceCreationRequest & { idempotencyKey: string };
  const first = await createWorkspace(input);
  await host.shutdown();
  restartHost();
  expect(await createWorkspace(input)).toEqual(first);
  expect(clone).toHaveBeenCalledTimes(1);
  await expect(
    createWorkspace({
      ...input,
      variant: {
        ...input.variant,
        remoteUrl: 'https://github.com/cursor/plugins',
      },
    }),
  ).rejects.toMatchObject({ reason: 'key-reused' });
  expect(clone).toHaveBeenCalledTimes(1);
});

it('retains a pending folder-link request after restart without recloning or changing its identity', async () => {
  const clone = jest
    .spyOn(git, 'cloneRepo')
    .mockImplementation((remote, destination) => {
      expect(remote).toBe('https://github.com/cursor/plugins');
      execFileSync('git', ['clone', '-q', repo, destination]);
      return Promise.reject(new Error('lost clone result'));
    });
  const input = {
    source: 'remote',
    variant: {
      kind: 'remote-clone',
      remoteUrl:
        'https://github.com/cursor/plugins/blob/linked/pstack/README.md',
      destinationDir: join(dir, 'clones'),
    },
    idempotencyKey: 'folder-link-pending',
  } satisfies WorkspaceCreationRequest & { idempotencyKey: string };
  await expect(createWorkspace(input)).rejects.toThrow('lost clone result');
  expect(existsSync(join(dir, 'clones', 'plugins', '.git'))).toBe(true);
  await host.shutdown();
  restartHost();
  const before = snapshot();
  await expect(createWorkspace(input)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  expect(clone).toHaveBeenCalledTimes(1);
  expect(snapshot()).toEqual(before);
});
function snapshot(path = join(dir, 'data')): unknown {
  return readdirSync(path, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => [
      entry.name,
      entry.isDirectory()
        ? snapshot(join(path, entry.name))
        : readFileSync(join(path, entry.name), 'utf8'),
    ]);
}
it('retains an unkeyed local identity and its owned effects through restart', async () => {
  jest.spyOn(host, 'commit').mockImplementationOnce(async () => {
    await host.shutdown();
    throw new Error('interrupted before canonical commit');
  });
  await expect(
    createWorkspace({
      source: 'new_multi_repo',
      variant: { kind: 'new-multi-repo', name: 'Interrupted' },
    }),
  ).rejects.toThrow('interrupted before canonical commit');
  restartHost();
  expect(
    (await host.recoveryReport()).recoveryRequiredReservations,
  ).toHaveLength(1);
  expect(existsSync(join(root, 'interrupted'))).toBe(true);
  expect(existsSync(join(dir, 'data', 'repos', 'interrupted', '.git'))).toBe(
    true,
  );
});

const variants = [
  'single',
  'multi',
  'cowork',
  'folder',
  'repo',
  'registration',
] as const;
type Variant = (typeof variants)[number];
function request(
  kind: Exclude<Variant, 'cowork'>,
  key?: string,
): WorkspaceCreationRequest {
  return {
    source: 'folder',
    variant:
      kind === 'single'
        ? { kind: 'new-single-repo', name: 'Created' }
        : kind === 'multi'
          ? { kind: 'new-multi-repo', name: 'Created' }
          : kind === 'folder'
            ? { kind: 'local-folder', folderPath: join(dir, 'notes') }
            : kind === 'repo'
              ? { kind: 'local-folder', folderPath: join(dir, 'import-repo') }
              : {
                  kind: 'repository-without-manifest',
                  repoPath: join(dir, 'import-repo'),
                  name: 'Created',
                },
    ...(key ? { idempotencyKey: key } : {}),
  };
}
function invoke(kind: Variant, key?: string): Promise<unknown> {
  return kind === 'cowork'
    ? withStorageAdmission(PROJECT_W5_STORAGE, () =>
        createCoworkWorkspace('Created'),
      )
    : createWorkspace(request(kind, key));
}
async function localReservations(): Promise<
  Array<{ workspaceId: string; ownedPaths: string[]; phase: string }>
> {
  const report = await host.recoveryReport();
  return (report.reservations ?? []).flatMap((entry) => {
    const parsed = workspaceCreationDiagnosticsSchema.safeParse(
      entry.diagnostics,
    );
    return parsed.success ? [parsed.data] : [];
  });
}
it.each(variants)(
  '%s: failure before reservation creates no artifact or recovery item',
  async (kind) => {
    const before = snapshot();
    jest
      .spyOn(host, 'reserve')
      .mockRejectedValueOnce(new Error('before reservation'));
    await expect(invoke(kind)).rejects.toThrow('before reservation');
    await host.shutdown();
    restartHost();
    expect(await localReservations()).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(readFileSync(join(dir, 'notes', 'sentinel.txt'), 'utf8')).toBe(
      'user-owned',
    );
  },
);
it.each(variants)(
  '%s: interruption after reservation preserves identity before any owned effect',
  async (kind) => {
    const before = snapshot();
    const reserve = host.reserve.bind(host);
    jest.spyOn(host, 'reserve').mockImplementationOnce(async (input) => {
      await reserve(input);
      await host.shutdown();
      throw new Error('after reservation');
    });
    await expect(invoke(kind)).rejects.toThrow('after reservation');
    restartHost();
    const [identity] = await localReservations();
    expect(typeof identity?.workspaceId).toBe('string');
    expect(identity?.phase).toBe('before-canonical-commit');
    expect(identity?.ownedPaths).toContain(
      join(root, identity?.workspaceId ?? 'missing'),
    );
    expect(snapshot()).toEqual(before);
    // A later unkeyed create must not reuse a pending identity, even with no files.
    await invoke(kind);
    const { items } = await readAllSidebarItems();
    expect(items.some((item) => item.id === identity?.workspaceId)).toBe(false);
    expect(await localReservations()).toEqual([identity]);
  },
);
it.each(variants)(
  '%s: uncommitted effects are retained and never automatically adopted on restart',
  async (kind) => {
    jest.spyOn(host, 'commit').mockImplementationOnce(async () => {
      await host.shutdown();
      throw new Error('after effects');
    });
    await expect(
      invoke(kind, kind === 'cowork' ? undefined : 'retry'),
    ).rejects.toThrow('after effects');
    restartHost();
    const identities = await localReservations();
    expect(identities).toHaveLength(1);
    const before = snapshot();
    expect(
      (await host.recoveryReport()).recoveryRequiredReservations?.length,
    ).toBeGreaterThan(0);
    expect((await readAllSidebarItems()).items.map((item) => item.id)).toEqual([
      'a',
    ]);
    if (kind !== 'cowork') {
      await expect(invoke(kind, 'retry')).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      expect(snapshot()).toEqual(before);
    }
    await host.shutdown();
    restartHost();
    expect(await localReservations()).toEqual(identities);
    expect(snapshot()).toEqual(before);
    expect(readFileSync(join(dir, 'notes', 'sentinel.txt'), 'utf8')).toBe(
      'user-owned',
    );
  },
);
it.each(variants)(
  '%s: launch applies a committed canonical create without repeating provisioning',
  async (kind) => {
    jest.spyOn(host, 'commit').mockImplementationOnce(async (input) => {
      await host.shutdown();
      const log = W5CommitLog.open(join(dir, 'w5', 'commit-log.sqlite'));
      try {
        log.commit(input);
      } finally {
        log.close();
      }
      throw new Error('after canonical decision');
    });
    await expect(invoke(kind)).rejects.toThrow('after canonical decision');
    restartHost();
    expect((await host.recoveryReport()).applied).toHaveLength(1);
    expect(await localReservations()).toEqual([]);
    const { items } = await readAllSidebarItems();
    expect(items).toHaveLength(2);
    const created = items.find((item) => item.id !== 'a');
    expect(created).toBeDefined();
    expect(
      existsSync(join(root, created?.id ?? 'missing', 'workspace.json')),
    ).toBe(true);
    if (created?.type === 'multi-repo') {
      expect(created.repos).toEqual([]);
      expect(
        execFileSync(
          'git',
          ['-C', created.sourceRepoPath ?? '', 'rev-parse', 'HEAD'],
          { encoding: 'utf8' },
        ).trim(),
      ).toMatch(/^[a-f0-9]{40}$/);
    }
  },
);
it.each(['single', 'multi', 'folder', 'repo', 'registration'] as const)(
  '%s: a lost final response replays the committed receipt after restart',
  async (kind) => {
    const commit = host.commit.bind(host);
    let saved: unknown;
    jest.spyOn(host, 'commit').mockImplementation(async (input) => {
      const result = await commit(input);
      if (input.receipt) {
        saved = input.outcome;
        await host.shutdown();
        throw new Error('lost final response');
      }
      return result;
    });
    await expect(invoke(kind, 'response')).rejects.toThrow(
      'lost final response',
    );
    restartHost();
    const before = snapshot();
    const commits = jest.spyOn(host, 'commit');
    expect(await invoke(kind, 'response')).toEqual(saved);
    expect(commits).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  },
);
it.each(['before', 'after'] as const)(
  'single: interruption %s Git initialization keeps the owned repository for recovery',
  async (point) => {
    const init = git.initLocalRepo;
    jest.spyOn(git, 'initLocalRepo').mockImplementationOnce(async (...args) => {
      if (point === 'after') await init(...args);
      await host.shutdown();
      throw new Error('Git interruption');
    });
    await expect(invoke('single')).rejects.toThrow('Git interruption');
    restartHost();
    const [identity] = await localReservations();
    expect(identity?.ownedPaths).toContain(
      join(dir, 'data', 'repos', 'created'),
    );
    expect(existsSync(join(dir, 'data', 'repos', 'created'))).toBe(true);
    expect(existsSync(join(dir, 'data', 'repos', 'created', '.git'))).toBe(
      point === 'after',
    );
  },
);
it('concurrent creates and imports retain every acknowledged workspace and resolve ids before effects', async () => {
  mkdirSync(join(root, 'created'));
  writeFileSync(join(root, 'created', 'unrelated.txt'), 'unowned metadata');
  mkdirSync(join(dir, 'data', 'repos', 'created'), { recursive: true });
  writeFileSync(
    join(dir, 'data', 'repos', 'created', 'sentinel.txt'),
    'unowned repository',
  );
  const reserve = host.reserve.bind(host);
  let release: () => void = () => {};
  let reached: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  jest.spyOn(host, 'reserve').mockImplementationOnce(async (input) => {
    await reserve(input);
    reached();
    await blocked;
  });
  const first = invoke('single');
  await ready;
  const rest = [
    invoke('multi'),
    invoke('cowork'),
    invoke('folder'),
    invoke('registration'),
  ];
  expect(existsSync(join(dir, 'data', 'repos', 'created-2'))).toBe(false);
  release();
  await Promise.all([first, ...rest]);
  const { items } = await readAllSidebarItems();
  expect(items).toHaveLength(6);
  expect(new Set(items.map((item) => item.id)).size).toBe(6);
  expect(
    items
      .filter((item) => item.id.startsWith('created'))
      .map((item) => item.id),
  ).toEqual(['created-2', 'created-3', 'created-4', 'created-5']);
  expect(readFileSync(join(root, 'created', 'unrelated.txt'), 'utf8')).toBe(
    'unowned metadata',
  );
  expect(
    readFileSync(join(dir, 'data', 'repos', 'created', 'sentinel.txt'), 'utf8'),
  ).toBe('unowned repository');
  expect(await localReservations()).toEqual([]);
  await host.shutdown();
  restartHost();
  expect((await readAllSidebarItems()).items.map((item) => item.id)).toEqual(
    items.map((item) => item.id),
  );
});
it('a dangling symlink at the planned repository path selects the next free suffix', async () => {
  const repos = join(dir, 'data', 'repos');
  mkdirSync(repos, { recursive: true });
  symlinkSync(join(dir, 'gone'), join(repos, 'created'));
  await invoke('single');
  const { items } = await readAllSidebarItems();
  const created = items.find((item) => item.id === 'created');
  expect(created?.type === 'single-repo' && created.repoPath).toBe(
    join(repos, 'created-2'),
  );
  expect(await localReservations()).toEqual([]);
});
it('keeps the existing-folder requirement and never creates a missing Cowork import folder', async () => {
  const missing = join(dir, 'missing');
  const reserve = jest.spyOn(host, 'reserve');
  await expect(
    createWorkspace({
      source: 'folder',
      variant: { kind: 'local-folder', folderPath: missing },
    }),
  ).rejects.toMatchObject({ reason: 'missing-folder' });
  expect(reserve).not.toHaveBeenCalled();
  expect(existsSync(missing)).toBe(false);
});

it.each(['single', 'multi'] as const)(
  '%s refuses a repository path replaced after durable reservation',
  async (kind) => {
    const reserve = host.reserve.bind(host);
    const target = join(dir, 'data', 'repos', 'created');
    jest.spyOn(host, 'reserve').mockImplementationOnce(async (input) => {
      await reserve(input);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'sentinel.txt'), 'replacement identity');
    });
    await expect(invoke(kind)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(join(target, 'sentinel.txt'), 'utf8')).toBe(
      'replacement identity',
    );
    expect(existsSync(join(target, '.git'))).toBe(false);
    await host.shutdown();
    restartHost();
    expect(await localReservations()).toHaveLength(1);
    expect((await readAllSidebarItems()).items.map((item) => item.id)).toEqual([
      'a',
    ]);
  },
);

it('keeps empty multi-repo source initialization for a name without an ASCII slug', async () => {
  const outcome = await createWorkspace({
    source: 'new_multi_repo',
    variant: { kind: 'new-multi-repo', name: '项目' },
  });
  expect(outcome.workspace.type).toBe('multi-repo');
  if (outcome.workspace.type !== 'multi-repo')
    throw new Error('Expected multi-repo');
  expect(outcome.workspace.repos).toEqual([]);
  expect(
    execFileSync(
      'git',
      ['-C', outcome.workspace.sourceRepoPath ?? '', 'rev-parse', 'HEAD'],
      { encoding: 'utf8' },
    ).trim(),
  ).toMatch(/^[a-f0-9]{40}$/);
});
it.each(['single', 'multi', 'cowork'] as const)(
  '%s resolves a dangling metadata symlink collision before effects',
  async (kind) => {
    const unownedTarget = join(dir, 'unowned-target');
    symlinkSync(unownedTarget, join(root, 'created'), 'dir');
    await invoke(kind);
    const ids = (await readAllSidebarItems()).items.map((item) => item.id);
    expect(ids).toEqual(['a', 'created-2']);
    expect(existsSync(unownedTarget)).toBe(false);
  },
);

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  WorkspaceIndexEntry,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type { W5Resource } from '@canopy/desktop-shared/node/w5-commit-log';
import {
  classifyW5FileProvenance,
  classifyW5RevisionEligibility,
} from '@canopy/core-runtime/node/w5/commit-log/eligibility';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import { createW5CommitLogFileStore } from '../w5-commit-log-file-store';
import { createWorkspaceIndexRepository } from '../workspace-index-repository';
import { createWorkspaceManifestRepository } from '../workspace-manifest-repository';
import { createWorktreeListRepository } from '../worktree-list-repository';
import {
  WORKSPACE_INDEX_STORAGE,
  WORKSPACE_MANIFEST_STORAGE,
  WORKTREE_LIST_STORAGE,
  withStorageAdmission,
  PROJECT_W5_STORAGE,
} from '../w5-storage';

// CAN-5317: real repositories commit through the worker; the CLI replaces
// whole files directly, as desktop-shared workspace-service does.

jest.setTimeout(60_000);
let dir: string;
let root: string;
let host: W5CommitLogHost;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-eligibility-'));
  root = join(dir, 'workspaces');
  mkdirSync(root);
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
});
afterEach(async () => {
  await host.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const entry: WorkspaceIndexEntry = {
  id: 'a',
  name: 'a',
  type: 'cowork',
  color: '#fff',
  collapsed: false,
  order: 0,
};
function row(id: string, label?: string): WorktreeData {
  return {
    id,
    branchName: id,
    createdAt: '2026-10-28T00:00:00Z',
    ...(label === undefined ? {} : { label }),
  };
}
const listPath = (): string => join(root, 'a', 'worktrees.json');
const manifestPath = (): string => join(root, 'a', 'workspace.json');
const workspaces: W5Resource = { kind: 'workspaces' };
const workspace: W5Resource = { kind: 'workspace', workspaceId: 'a' };
const worktrees: W5Resource = { kind: 'worktrees', workspaceId: 'a' };
const worktree = (worktreeId: string): W5Resource => ({
  kind: 'worktree',
  workspaceId: 'a',
  worktreeId,
});

function repositories(): {
  store: ReturnType<typeof createW5CommitLogFileStore>;
  index: ReturnType<typeof createWorkspaceIndexRepository>;
  manifest: ReturnType<typeof createWorkspaceManifestRepository>;
  list: ReturnType<typeof createWorktreeListRepository>;
} {
  const store = createW5CommitLogFileStore(() => host);
  return {
    store,
    index: createWorkspaceIndexRepository({
      store,
      filePath: () => join(root, 'index.json'),
      storage: WORKSPACE_INDEX_STORAGE,
      onCommitted: () => {},
      onRefused: () => {},
    }),
    manifest: createWorkspaceManifestRepository({
      store,
      filePath: () => manifestPath(),
      storage: WORKSPACE_MANIFEST_STORAGE,
      knownFields: new Set(['version', 'type', 'repos']),
      knownRepoFields: new Set(['id', 'name', 'repoPath']),
    }),
    list: createWorktreeListRepository({
      store,
      filePath: () => listPath(),
      storage: WORKTREE_LIST_STORAGE,
      knownRowFields: new Set(['id', 'branchName', 'createdAt', 'label']),
    }),
  };
}

type Repositories = ReturnType<typeof repositories>;

async function baseline(repos: Repositories): Promise<void> {
  await withStorageAdmission(PROJECT_W5_STORAGE, async () => {
    await repos.index.update(() => ({ result: null, entries: [entry] }));
    await repos.manifest.serialize('a', async () =>
      repos.manifest.replace(
        'a',
        { version: 1, type: 'cowork', repos: [] },
        await repos.manifest.read('a'),
      ),
    );
    await repos.list.replace(
      'a',
      [row('one'), row('two')],
      await repos.list.read('a'),
    );
  });
}

/** The CLI's direct atomic replacement, outside the log. */
function cli(path: string, contents: string): void {
  writeFileSync(`${path}.cli.tmp`, contents);
  renameSync(`${path}.cli.tmp`, path);
}

async function labels(): Promise<Record<string, number | string>> {
  const capture = await host.capture({ files: [], discoverWorkspaces: true });
  expect(capture.discovery).toBe('complete');
  const label = (resource: W5Resource): number | string => {
    const eligibility = classifyW5RevisionEligibility(
      capture,
      resource,
      'complete',
    );
    return eligibility.status === 'eligible'
      ? eligibility.revision
      : eligibility.reason;
  };
  return {
    workspaces: label(workspaces),
    workspace: label(workspace),
    worktrees: label(worktrees),
    one: label(worktree('one')),
    two: label(worktree('two')),
  };
}

it('labels the canonical images real repositories write, across writes and fences', async () => {
  const repos = repositories();
  await baseline(repos);
  expect(await labels()).toEqual({
    workspaces: 1,
    workspace: 2,
    worktrees: 1,
    one: 1,
    two: 1,
  });
  await withStorageAdmission(PROJECT_W5_STORAGE, async () => {
    await repos.list.replace(
      'a',
      [row('one', 'Edited'), row('two')],
      await repos.list.read('a'),
    );
    await repos.index.update(({ entries }) => ({
      result: null,
      entries: entries.map((item) => ({ ...item, name: 'Renamed' })),
    }));
    await repos.store.withCommit(
      {
        operation: 'test.fence',
        fenceLockedFiles: true,
        locks: [
          { kind: 'manifest', path: manifestPath() },
          { kind: 'list', path: listPath() },
        ],
      },
      async () => {},
    );
  });
  expect(await labels()).toEqual({
    workspaces: 1,
    workspace: 3,
    worktrees: 1,
    one: 2,
    two: 1,
  });
  const capture = await host.capture({
    files: [{ kind: 'index-backup' }],
    discoverWorkspaces: false,
  });
  // The rolling backup is file evidence only; it backs no label.
  expect(
    classifyW5FileProvenance(capture, { kind: 'index-backup' }).status,
  ).toBe('canonical');
});

it.each(['write', 'fence'] as const)(
  'keeps a CLI membership change ineligible after a desktop %s retains it',
  async (sequel) => {
    const repos = repositories();
    await baseline(repos);
    const read = await repos.list.read('a');
    if (read.authority !== 'ok') throw new Error('Expected a list');
    cli(
      listPath(),
      JSON.stringify(
        { version: 1, worktrees: [...read.worktrees, row('cli')] },
        null,
        2,
      ),
    );
    const affected = {
      worktrees: 'diverged',
      one: 'diverged',
      two: 'diverged',
    };
    expect(await labels()).toEqual({
      workspaces: 1,
      workspace: 2,
      ...affected,
    });
    await withStorageAdmission(PROJECT_W5_STORAGE, async () => {
      if (sequel === 'write') {
        const current = await repos.list.read('a');
        if (current.authority !== 'ok') throw new Error('Expected a list');
        await repos.list.replace(
          'a',
          current.worktrees.map((item) =>
            item.id === 'two' ? { ...item, label: 'desktop' } : item,
          ),
          current,
        );
      } else {
        await repos.store.withCommit(
          {
            operation: 'test.fence',
            fenceLockedFiles: true,
            locks: [{ kind: 'list', path: listPath() }],
          },
          async () => {},
        );
      }
    });
    // Membership changed without its collection revision advancing.
    expect(await host.revision(worktrees)).toBe(1);
    expect(readFileSync(listPath(), 'utf8')).toContain('"cli"');
    expect(await labels()).toEqual({
      workspaces: 1,
      workspace: 2,
      worktrees: 'foreign-preimage',
      one: 'foreign-preimage',
      two: 'foreign-preimage',
    });
  },
);

it('keeps a CLI single-row change ineligible after the desktop writes another row', async () => {
  const repos = repositories();
  await baseline(repos);
  cli(
    listPath(),
    JSON.stringify(
      { version: 1, worktrees: [row('one', 'cli'), row('two')] },
      null,
      2,
    ),
  );
  expect((await labels()).one).toBe('diverged');
  await withStorageAdmission(PROJECT_W5_STORAGE, async () => {
    const current = await repos.list.read('a');
    if (current.authority !== 'ok') throw new Error('Expected a list');
    await repos.list.replace(
      'a',
      current.worktrees.map((item) =>
        item.id === 'two' ? { ...item, label: 'desktop' } : item,
      ),
      current,
    );
  });
  expect(await host.revision(worktree('one'))).toBe(1);
  expect(await labels()).toMatchObject({
    worktrees: 'foreign-preimage',
    one: 'foreign-preimage',
  });
});

it('keeps a formatting-only CLI rewrite ineligible when the desktop write is a semantic no-op', async () => {
  const repos = repositories();
  await baseline(repos);
  cli(manifestPath(), '{"version":1,"type":"cowork","repos":[]}\n');
  const commit = jest.spyOn(host, 'commit');
  await withStorageAdmission(PROJECT_W5_STORAGE, async () =>
    repos.manifest.serialize('a', async () =>
      repos.manifest.replace(
        'a',
        { version: 1, type: 'cowork', repos: [] },
        await repos.manifest.read('a'),
      ),
    ),
  );
  expect(commit).not.toHaveBeenCalled();
  expect(await labels()).toMatchObject({
    workspaces: 1,
    workspace: 'diverged',
    worktrees: 1,
  });
});

it('withholds a row label whose ID repeats, since an earlier duplicate changes without an advance', async () => {
  const repos = repositories();
  await baseline(repos);
  const write = (first: string): Promise<string> =>
    withStorageAdmission(PROJECT_W5_STORAGE, async () =>
      repos.list.replace(
        'a',
        [row('one', first), row('one', 'second'), row('two')],
        await repos.list.read('a'),
      ),
    );
  await write('first');
  const before = await host.revision(worktree('one'));
  await write('changed');
  expect(readFileSync(listPath(), 'utf8')).toContain('"changed"');
  expect(await host.revision(worktree('one'))).toBe(before);
  expect(await labels()).toMatchObject({
    worktrees: 2,
    one: 'duplicate-row',
    two: 1,
  });
});

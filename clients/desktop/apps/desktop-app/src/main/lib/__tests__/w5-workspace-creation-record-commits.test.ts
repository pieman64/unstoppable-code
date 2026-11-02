// W6a1 (CAN-4815): the W5 commits of workspace-service staging through the
// record decision port, on the real commit log worker: a create's or an
// import's publication (`stageNewWorkspaceCreation`,
// `persistImportedWorkspaceArtifacts`) and a find-or-create addition
// (`stageAddedWorkspace`).
//
// One log interleaves each port decision (as JSON, so it is plain data), each
// reservation and commit the worker receives and the post-commit hooks. A
// create or import commits once in its reserved creation boundary step; a
// scoped addition commits once in its caller's boundary step; an unscoped
// addition writes the whole sidebar, each file committing on its own. A
// refusal before the decision commits nothing. Without the decision entries,
// each expected log is the one the code before the port produced.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  W5CommitRequest,
  W5Resource,
} from '@canopy/desktop-shared/node/w5-commit-log';
import type { WorkspaceOwnerBinding } from '@canopy/desktop-shared/types';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as RepoShadow from '../repo-shadow';
import type * as CreationPort from '../workspace-creation-decision-port';
import type {
  WorkspaceAdditionDecision,
  WorkspaceCreationDecision,
} from '../worktree-record-decisions';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';

const mockEvents: unknown[] = [];

/** Logs a decision and passes on its JSON copy. */
function mockDecision<T extends { kind: string }>(decision: T): T {
  mockEvents.push(`decision:${decision.kind}`);
  return JSON.parse(JSON.stringify(decision)) as T;
}

jest.mock('../repo-shadow', () => ({
  ...jest.requireActual<typeof RepoShadow>('../repo-shadow'),
  getBaselineReadPath: (sourceRepoPath: string): Promise<string> =>
    Promise.resolve(sourceRepoPath),
}));
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn((diagnostic: { kind?: string }) =>
      mockEvents.push(`diagnostic:${diagnostic.kind ?? 'unknown'}`),
    ),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(() => mockEvents.push('sync')),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(() => mockEvents.push('notify')),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
}));
jest.mock('../../services/script-actions-lifecycle', () => ({
  notifyScriptActionsRepositoryAdd: jest.fn(),
}));
jest.mock('../workspace-creation-decision-port', () => {
  const actual = jest.requireActual<typeof CreationPort>(
    '../workspace-creation-decision-port',
  );
  return {
    ...actual,
    applyWorkspaceAdditionDecision: (
      decision: WorkspaceAdditionDecision,
    ): Promise<unknown> =>
      actual.applyWorkspaceAdditionDecision(mockDecision(decision)),
    applyWorkspaceCreationDecision: (
      decision: WorkspaceCreationDecision,
      beforeEffects: () => void,
    ): Promise<unknown> =>
      actual.applyWorkspaceCreationDecision(
        mockDecision(decision),
        beforeEffects,
      ),
  };
});

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  w5ResourceKey,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { workspaceCreationDiagnosticsSchema } from '../w5-workspace-creation-diagnostics';
import * as canopyJson from '../canopy-json';
import * as git from '../git';
import {
  createWorkspace,
  type WorkspaceCreationRequest,
} from '../workspace-creation';
import {
  findOrCreateSingleRepoWorkspaceForRepo,
  WorkspaceIdentityInUseError,
} from '../workspace-service';
import { setBeforeProjectPluginDefaultsChangeHandler } from '../workspace-persistence';

jest.setTimeout(60_000);

const OWNER: Extract<WorkspaceOwnerBinding, { type: 'organization' }> = {
  type: 'organization',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  bindingGeneration: 2,
};

let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
/** Runs before the worker receives a commit, as a writer outside the locks. */
let beforeWorkerCommit: (() => void) | undefined;

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  const commit = host.commit.bind(host);
  jest
    .spyOn(host, 'commit')
    .mockImplementation(async (request: W5CommitRequest) => {
      mockEvents.push(commitEvent(request));
      beforeWorkerCommit?.();
      return commit(request);
    });
  const reserve = host.reserve.bind(host);
  jest.spyOn(host, 'reserve').mockImplementation(async (input) => {
    mockEvents.push(`reserve:${input.operation}`);
    return reserve(input);
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
}

beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture());
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  beforeWorkerCommit = undefined;
  startHost();
  mockEvents.length = 0;
});
afterEach(async () => {
  await settleDetachedWork();
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

async function restartHost(): Promise<void> {
  await host.shutdown();
  startHost();
  __resetSidebarItemsStateForTests();
}

interface CommitEvent {
  commit: string;
  advance: string[];
  files: string[];
  reservation?: true;
  receipt?: true;
}
function commitEvent(request: W5CommitRequest): CommitEvent {
  return {
    commit: request.operation,
    advance: request.advance.map(w5ResourceKey),
    files: request.files.map((file) => relative(root, file.path)),
    ...(request.reservationId ? { reservation: true } : {}),
    ...(request.receipt ? { receipt: true } : {}),
  };
}
function isCommitEvent(event: unknown): event is CommitEvent {
  return typeof event === 'object' && event !== null && 'files' in event;
}
/**
 * A publication of several projects stages their manifests and lists
 * concurrently: its index files lead, and the order of the rest is not part
 * of the contract, so it is sorted.
 */
function sortedProjectFiles(events: unknown[]): unknown[] {
  return events.map((event) =>
    isCommitEvent(event)
      ? {
          ...event,
          files: [
            ...event.files.slice(0, INDEX_FILES.length),
            ...event.files.slice(INDEX_FILES.length).sort(),
          ],
        }
      : event,
  );
}

function read(file: string): string | undefined {
  const path = join(root, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}
function json(file: string): unknown {
  const contents = read(file);
  return contents === undefined ? undefined : JSON.parse(contents);
}
/** The bytes a W5 writer produces for `value`. */
function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Every file under the workspaces root, by path, with its bytes. */
function images(): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      if (lstatSync(child).isDirectory()) visit(child);
      else files[relative(root, child)] = readFileSync(child, 'utf8');
    }
  };
  visit(root);
  return files;
}
const IDS = [
  'a',
  'b',
  'fresh',
  'import-repo',
  'claimed',
  'source',
  'first',
  'second',
];
const RESOURCES: W5Resource[] = [
  { kind: 'workspaces' },
  ...IDS.map((workspaceId): W5Resource => ({ kind: 'workspace', workspaceId })),
];
async function revisions(): Promise<Record<string, number>> {
  const entries = await Promise.all(
    RESOURCES.map(
      async (resource): Promise<[string, number]> => [
        w5ResourceKey(resource),
        await host.revision(resource),
      ],
    ),
  );
  return Object.fromEntries(entries);
}

interface Observed<T> {
  result: T;
  events: unknown[];
  /** The resources whose revision moved, by how much. */
  advanced: Record<string, number>;
  /** The files under the workspaces root whose bytes changed, appeared or disappeared. */
  changed: string[];
}
async function observe<T>(work: () => Promise<T>): Promise<Observed<T>> {
  const beforeRevisions = await revisions();
  const beforeImages = images();
  mockEvents.length = 0;
  const result = await work();
  await settleDetachedWork();
  const events = [...mockEvents];
  const afterRevisions = await revisions();
  const afterImages = images();
  const advanced: Record<string, number> = {};
  for (const [key, value] of Object.entries(afterRevisions))
    if (value !== beforeRevisions[key])
      advanced[key] = value - (beforeRevisions[key] ?? 0);
  return {
    result,
    events,
    advanced,
    changed: Array.from(
      new Set<string>([
        ...Object.keys(beforeImages),
        ...Object.keys(afterImages),
      ]),
    )
      .filter((file) => afterImages[file] !== beforeImages[file])
      .sort(),
  };
}
function observeRefusal(
  work: () => Promise<unknown>,
): Promise<Observed<unknown>> {
  return observe(() =>
    work().then(
      () => {
        throw new Error('Expected a refusal');
      },
      (error: unknown) => error,
    ),
  );
}
function withoutResult<T>(observed: Observed<T>): Omit<Observed<T>, 'result'> {
  const { events, advanced, changed } = observed;
  return { events, advanced, changed };
}
async function localReservations(): Promise<
  Array<{ workspaceId: string; ownedPaths: string[] }>
> {
  const report = await host.recoveryReport();
  return (report.reservations ?? []).flatMap((entry) => {
    const parsed = workspaceCreationDiagnosticsSchema.safeParse(
      entry.diagnostics,
    );
    return parsed.success ? [parsed.data] : [];
  });
}

const INDEX_FILES = ['index.json', 'index.json.bak'];
/** The index commit's Portal sync, the sidebar write's, then their notifications. */
const CREATE_HOOKS = ['sync', 'sync', 'notify', 'notify'];
const ORIGINAL_ENTRY = {
  id: 'a',
  name: 'Original',
  type: 'single-repo',
  color: '#7C3AED',
  collapsed: false,
  order: 0,
};

function cloneRepository(name: string): string {
  const path = join(dir, name);
  execFileSync('git', ['clone', '-q', repo, path]);
  return path;
}
function folderImport(
  folderPath: string,
  fields: Partial<WorkspaceCreationRequest> = {},
): WorkspaceCreationRequest {
  return {
    source: 'folder',
    variant: { kind: 'local-folder', folderPath },
    ...fields,
  };
}

describe('create publication (stageNewWorkspaceCreation)', () => {
  it('imports a folder: canopy.json, then index, manifest and list in one reserved commit', async () => {
    const importRepo = cloneRepository('import-repo');
    const created = await observe(() =>
      createWorkspace(folderImport(importRepo)),
    );
    expect(created.result.workspace).toEqual({
      type: 'single-repo',
      id: 'import-repo',
      name: 'import-repo',
      repoPath: importRepo,
      color: '#0EA5E9',
      worktrees: [],
      collapsed: false,
      order: 1,
    });
    expect(withoutResult(created)).toEqual({
      events: [
        'reserve:core.workspace.create',
        'decision:workspace.create.publish',
        {
          commit: 'core.workspace.create',
          advance: ['workspaces', 'workspace:import-repo'],
          files: [
            ...INDEX_FILES,
            'import-repo/workspace.json',
            'import-repo/worktrees.json',
          ],
          reservation: true,
        },
        ...CREATE_HOOKS,
      ],
      advanced: { workspaces: 1, 'workspace:import-repo': 1 },
      changed: [
        'import-repo/workspace.json',
        'import-repo/worktrees.json',
        'index.json',
        'index.json.bak',
      ],
    });
    expect(json('index.json')).toEqual({
      version: 1,
      workspaces: [
        ORIGINAL_ENTRY,
        {
          id: 'import-repo',
          name: 'import-repo',
          type: 'single-repo',
          color: '#0EA5E9',
          collapsed: false,
          order: 1,
        },
      ],
    });
    expect(read('import-repo/workspace.json')).toBe(
      pretty({
        version: 1,
        type: 'single-repo',
        repoPath: importRepo,
        repos: [],
      }),
    );
    expect(read('import-repo/worktrees.json')).toBe(
      pretty({ version: 1, worktrees: [] }),
    );
    expect(readFileSync(join(importRepo, 'canopy.json'), 'utf8')).toContain(
      '"version": 1',
    );
    expect(await localReservations()).toEqual([]);
  });

  it('publishes a cloned remote in one reserved commit after the clone', async () => {
    jest.spyOn(git, 'cloneRepo').mockImplementation((_remote, destination) => {
      execFileSync('git', ['clone', '-q', repo, destination]);
      return Promise.resolve();
    });
    const created = await observe(() =>
      createWorkspace({
        source: 'remote',
        variant: {
          kind: 'remote-clone',
          remoteUrl: 'https://example.com/team/fresh.git',
          destinationDir: join(dir, 'clones'),
        },
      }),
    );
    expect(created.result.workspace).toMatchObject({
      type: 'single-repo',
      id: 'fresh',
      repoPath: join(dir, 'clones', 'fresh'),
      order: 1,
    });
    expect(withoutResult(created)).toEqual({
      events: [
        'reserve:core.workspace.create',
        'decision:workspace.create.publish',
        {
          commit: 'core.workspace.create',
          advance: ['workspaces', 'workspace:fresh'],
          files: [
            ...INDEX_FILES,
            'fresh/workspace.json',
            'fresh/worktrees.json',
          ],
          reservation: true,
        },
        ...CREATE_HOOKS,
      ],
      advanced: { workspaces: 1, 'workspace:fresh': 1 },
      changed: [
        'fresh/workspace.json',
        'fresh/worktrees.json',
        'index.json',
        'index.json.bak',
      ],
    });
  });

  /** The one reserved commit that publishes `id` with its manifest and list. */
  function publication(id: string, label = 'core.workspace.create'): unknown {
    return {
      commit: label,
      advance: ['workspaces', `workspace:${id}`],
      files: [...INDEX_FILES, `${id}/workspace.json`, `${id}/worktrees.json`],
      reservation: true,
    };
  }

  it.each([
    ['new single-repo', 'new_single_repo', 'new-single-repo', []],
    ['new multi-repo', 'new_multi_repo', 'new-multi-repo', ['fresh/CLAUDE.md']],
  ] as const)(
    'creates a %s project, then publishes it in one reserved commit',
    async (_label, source, kind, scaffold) => {
      const created = await observe(() =>
        createWorkspace({ source, variant: { kind, name: 'Fresh' } }),
      );
      expect(created.result.workspace).toMatchObject({ id: 'fresh', order: 1 });
      expect(withoutResult(created)).toEqual({
        events: [
          'reserve:core.workspace.create',
          'decision:workspace.create.publish',
          publication('fresh'),
          ...CREATE_HOOKS,
        ],
        advanced: { workspaces: 1, 'workspace:fresh': 1 },
        changed: [
          ...scaffold,
          'fresh/workspace.json',
          'fresh/worktrees.json',
          'index.json',
          'index.json.bak',
        ],
      });
      expect(await localReservations()).toEqual([]);
    },
  );

  it('registers a repository without writing canopy.json into it', async () => {
    const importRepo = cloneRepository('import-repo');
    const registered = await observe(() =>
      createWorkspace({
        source: 'external_projects_import',
        variant: {
          kind: 'repository-without-manifest',
          repoPath: importRepo,
          name: 'Claimed',
        },
      }),
    );
    expect(registered.result.workspace).toMatchObject({
      id: 'claimed',
      repoPath: importRepo,
      order: 1,
    });
    expect(withoutResult(registered)).toEqual({
      events: [
        'reserve:core.workspace.create',
        'decision:workspace.create.publish',
        publication('claimed'),
        ...CREATE_HOOKS,
      ],
      advanced: { workspaces: 1, 'workspace:claimed': 1 },
      changed: [
        'claimed/workspace.json',
        'claimed/worktrees.json',
        'index.json',
        'index.json.bak',
      ],
    });
    expect(existsSync(join(importRepo, 'canopy.json'))).toBe(false);
  });

  it('releases the key on a refusal before effects; the keyed import then publishes once and records its receipt last', async () => {
    const importRepo = cloneRepository('import-repo');
    const key = { idempotencyKey: 'folder-import' };
    const refused = await observeRefusal(() =>
      createWorkspace(folderImport(repo, key)),
    );
    expect(refused.result).toMatchObject({ reason: 'already-tracked' });
    expect(withoutResult(refused)).toEqual({
      events: ['reserve:core.workspace.import'],
      advanced: {},
      changed: [],
    });
    // Different parameters under the released key are a new request.
    const imported = await observe(() =>
      createWorkspace(folderImport(importRepo, key)),
    );
    expect(imported.result.workspace).toMatchObject({
      id: 'import-repo',
      order: 1,
    });
    expect(withoutResult(imported)).toEqual({
      events: [
        // The key, then the creation identity.
        'reserve:core.workspace.import',
        'reserve:core.workspace.import',
        'decision:workspace.create.publish',
        publication('import-repo', 'core.workspace.import'),
        ...CREATE_HOOKS,
        {
          commit: 'core.workspace.import',
          advance: [],
          files: [],
          reservation: true,
          receipt: true,
        },
      ],
      advanced: { workspaces: 1, 'workspace:import-repo': 1 },
      changed: [
        'import-repo/workspace.json',
        'import-repo/worktrees.json',
        'index.json',
        'index.json.bak',
      ],
    });
    expect(await host.recoveryReport()).toMatchObject({
      recoveryRequired: [],
      interruptedReservations: 0,
    });
  });

  it('replays a keyed import after a restart without a decision or a write; changed parameters refuse', async () => {
    const importRepo = cloneRepository('import-repo');
    const key = { idempotencyKey: 'folder-import' };
    const first = await createWorkspace(folderImport(importRepo, key));
    await restartHost();
    const replay = await observe(() =>
      createWorkspace(folderImport(importRepo, key)),
    );
    expect(replay.result).toEqual(first);
    expect(withoutResult(replay)).toEqual({
      events: [],
      advanced: {},
      changed: [],
    });
    const reused = await observeRefusal(() =>
      createWorkspace(folderImport(join(dir, 'notes-missing'), key)),
    );
    expect(reused.result).toMatchObject({ reason: 'key-reused' });
    expect(withoutResult(reused)).toEqual({
      events: [],
      advanced: {},
      changed: [],
    });
  });

  it('refuses a stale collection revision after canopy.json, keeping it and the identity for recovery', async () => {
    const importRepo = cloneRepository('import-repo');
    const stale = await observeRefusal(() =>
      createWorkspace(folderImport(importRepo, { expectedRevision: 7 })),
    );
    expect(stale.result).toMatchObject({ reason: 'revision-conflict' });
    expect(withoutResult(stale)).toEqual({
      events: [
        'reserve:core.workspace.create',
        'decision:workspace.create.publish',
        {
          commit: 'core.workspace.create',
          advance: ['workspaces', 'workspace:import-repo'],
          files: [
            ...INDEX_FILES,
            'import-repo/workspace.json',
            'import-repo/worktrees.json',
          ],
          reservation: true,
        },
      ],
      advanced: {},
      changed: [],
    });
    expect(existsSync(join(importRepo, 'canopy.json'))).toBe(true);
    await restartHost();
    expect(
      (await host.recoveryReport()).recoveryRequiredReservations,
    ).toHaveLength(1);
    expect((await localReservations())[0]?.workspaceId).toBe('import-repo');
  });

  it('keeps canopy.json and the identity for recovery when the index changes after the publication read it', async () => {
    const importRepo = cloneRepository('import-repo');
    const foreign = JSON.stringify({
      version: 1,
      workspaces: [ORIGINAL_ENTRY, { ...ORIGINAL_ENTRY, id: 'b', order: 1 }],
    });
    const write = jest.spyOn(canopyJson, 'writeCanopyJson');
    beforeWorkerCommit = (): void => {
      // A writer outside the locks changes the index the decision read.
      writeFileSync(join(root, 'index.json'), foreign);
    };
    const conflicted = await observeRefusal(() =>
      createWorkspace(folderImport(importRepo)),
    );
    expect(conflicted.result).toMatchObject({ reason: 'recovery-required' });
    // The worker records the decision but cannot apply it over the foreign
    // index: the revisions move, no canonical file is written.
    expect(withoutResult(conflicted)).toEqual({
      events: [
        'reserve:core.workspace.create',
        'decision:workspace.create.publish',
        {
          commit: 'core.workspace.create',
          advance: ['workspaces', 'workspace:import-repo'],
          files: [
            ...INDEX_FILES,
            'import-repo/workspace.json',
            'import-repo/worktrees.json',
          ],
          reservation: true,
        },
      ],
      advanced: { workspaces: 1, 'workspace:import-repo': 1 },
      changed: ['index.json'],
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(read('index.json')).toBe(foreign);
    expect(read('import-repo/workspace.json')).toBeUndefined();
    expect(existsSync(join(importRepo, 'canopy.json'))).toBe(true);
    // The decision consumed the identity; its unapplied commit stays for
    // recovery across a restart, never applied over the foreign index.
    await restartHost();
    expect((await host.recoveryReport()).recoveryRequired).toHaveLength(1);
    expect(await localReservations()).toEqual([]);
    expect(read('index.json')).toBe(foreign);
    expect(read('import-repo/workspace.json')).toBeUndefined();
  });

  it('refuses a tracked repository before any reservation or decision', async () => {
    const tracked = await observeRefusal(() =>
      createWorkspace(folderImport(repo)),
    );
    expect(tracked.result).toMatchObject({ reason: 'already-tracked' });
    expect(withoutResult(tracked)).toEqual({
      events: [],
      advanced: {},
      changed: [],
    });
  });
});

describe('import publication (persistImportedWorkspaceArtifacts)', () => {
  function makeManifestSource(): string {
    const source = cloneRepository('source');
    const repos = ['first', 'second'].map((id) => {
      const remote = join(dir, `${id}.git`);
      execFileSync('git', ['clone', '-q', '--bare', repo, remote]);
      return { id, name: id, url: pathToFileURL(remote).href };
    });
    writeFileSync(
      join(source, 'canopy.json'),
      JSON.stringify({ version: 1, repos }),
    );
    return source;
  }
  const manifestImport = (source: string): WorkspaceCreationRequest => ({
    source: 'import_from_repo',
    variant: { kind: 'repository-manifest', repoPath: source },
  });

  it('publishes and locks only the new member projects when a member is already tracked', async () => {
    const source = makeManifestSource();
    const claimed = join(dir, 'claimed');
    execFileSync('git', [
      'clone',
      '-q',
      pathToFileURL(join(dir, 'first.git')).href,
      claimed,
    ]);
    await createWorkspace(folderImport(claimed));
    const imported = await observe(() =>
      createWorkspace(manifestImport(source)),
    );
    expect(imported.result).toMatchObject({
      workspace: {
        type: 'multi-repo',
        id: 'source',
        order: 2,
        repos: [
          { id: 'first', repoPath: claimed },
          { id: 'second', repoPath: join(dir, 'data', 'repos', 'second') },
        ],
      },
      clonedRepoIds: ['second'],
    });
    expect({
      ...withoutResult(imported),
      events: sortedProjectFiles(imported.events),
    }).toEqual({
      events: [
        'reserve:core.workspace.create',
        'decision:workspace.import.publish',
        {
          commit: 'core.workspace.create',
          advance: ['workspaces', 'workspace:source', 'workspace:second'],
          files: [
            ...INDEX_FILES,
            'second/workspace.json',
            'second/worktrees.json',
            'source/workspace.json',
            'source/worktrees.json',
          ],
          reservation: true,
        },
        'sync',
        'sync',
        'notify',
        'sync',
        'notify',
        'notify',
      ],
      advanced: {
        workspaces: 1,
        'workspace:source': 1,
        'workspace:second': 1,
      },
      changed: [
        ...INDEX_FILES,
        'second/workspace.json',
        'second/worktrees.json',
        'source/workspace.json',
        'source/worktrees.json',
      ],
    });
    expect(json('index.json')).toMatchObject({
      workspaces: [
        { id: 'a', order: 0 },
        { id: 'claimed', order: 1 },
        { id: 'source', order: 2 },
        { id: 'second', order: 3 },
      ],
    });
  });

  it('publishes the project and its member children in one reserved commit after the clones', async () => {
    const source = makeManifestSource();
    const imported = await observe(() =>
      createWorkspace(manifestImport(source)),
    );
    expect(imported.result).toMatchObject({
      workspace: { type: 'multi-repo', id: 'source', order: 1 },
      clonedRepoIds: ['first', 'second'],
    });
    const projects = ['source', 'first', 'second'];
    const manifests = projects.map((id) => `${id}/workspace.json`);
    const lists = projects.map((id) => `${id}/worktrees.json`);
    expect({
      ...withoutResult(imported),
      events: sortedProjectFiles(imported.events),
    }).toEqual({
      events: [
        'reserve:core.workspace.create',
        'decision:workspace.import.publish',
        {
          commit: 'core.workspace.create',
          advance: [
            'workspaces',
            'workspace:source',
            'workspace:first',
            'workspace:second',
          ],
          files: [...INDEX_FILES, ...[...manifests, ...lists].sort()],
          reservation: true,
        },
        // The index commit's sync, then the sidebar write's and each
        // project's settled hooks, as before the port.
        'sync',
        'sync',
        'notify',
        'sync',
        'notify',
        'sync',
        'notify',
        'notify',
      ],
      advanced: {
        workspaces: 1,
        'workspace:source': 1,
        'workspace:first': 1,
        'workspace:second': 1,
      },
      changed: [...INDEX_FILES, ...manifests, ...lists].sort(),
    });
    expect(json('index.json')).toEqual({
      version: 1,
      workspaces: [
        ORIGINAL_ENTRY,
        {
          id: 'source',
          name: 'source',
          type: 'multi-repo',
          color: '#0EA5E9',
          collapsed: false,
          order: 1,
        },
        {
          id: 'first',
          name: 'first',
          type: 'single-repo',
          color: '#22C55E',
          collapsed: false,
          order: 2,
        },
        {
          id: 'second',
          name: 'second',
          type: 'single-repo',
          color: '#F59E0B',
          collapsed: false,
          order: 3,
        },
      ],
    });
    expect(json('source/workspace.json')).toEqual({
      version: 1,
      type: 'multi-repo',
      repos: ['first', 'second'].map((id) => ({
        id,
        name: id,
        repoPath: join(dir, 'data', 'repos', id),
        source: 'manifest',
        manifestUrl: pathToFileURL(join(dir, `${id}.git`)).href,
      })),
      sourceRepoPath: source,
    });
    expect(await localReservations()).toEqual([]);
  });

  it('refuses a rival import of the same source after the clones, keeping them and the identity for recovery', async () => {
    const source = makeManifestSource();
    const clone = git.cloneRepo;
    let rivalSeeded = false;
    jest.spyOn(git, 'cloneRepo').mockImplementation(async (...args) => {
      await clone(...args);
      if (rivalSeeded) return;
      rivalSeeded = true;
      // Another import of this source is published meanwhile.
      mkdirSync(join(root, 'rival'));
      writeFileSync(
        join(root, 'rival', 'workspace.json'),
        JSON.stringify({
          version: 1,
          type: 'multi-repo',
          repos: [],
          sourceRepoPath: source,
        }),
      );
      writeFileSync(
        join(root, 'index.json'),
        JSON.stringify({
          version: 1,
          workspaces: [
            ORIGINAL_ENTRY,
            {
              ...ORIGINAL_ENTRY,
              id: 'rival',
              name: 'Rival',
              type: 'multi-repo',
              order: 1,
            },
          ],
        }),
      );
    });
    const refused = await observeRefusal(() =>
      createWorkspace(manifestImport(source)),
    );
    expect(refused.result).toMatchObject({
      reason: 'already-tracked',
      message: 'This source repo is already attached to project "Rival"',
    });
    expect(withoutResult(refused)).toEqual({
      events: ['reserve:core.workspace.create'],
      advanced: {},
      changed: ['index.json', 'rival/workspace.json'],
    });
    expect(existsSync(join(dir, 'data', 'repos', 'first', '.git'))).toBe(true);
    await restartHost();
    expect(
      (await host.recoveryReport()).recoveryRequiredReservations,
    ).toHaveLength(1);
    expect((await localReservations())[0]?.workspaceId).toBe('source');
  });
});

describe('find-or-create addition (stageAddedWorkspace)', () => {
  it('writes the whole sidebar unscoped, each file committing on its own, with the new binding', async () => {
    const claimedRepo = cloneRepository('claimed-repo');
    const added = await observe(() =>
      findOrCreateSingleRepoWorkspaceForRepo(claimedRepo, 'Claimed', {
        owner: OWNER,
        localWorkspaceId: 'claimed',
      }),
    );
    expect(added.result).toEqual({
      created: true,
      workspace: {
        type: 'single-repo',
        id: 'claimed',
        name: 'Claimed',
        repoPath: claimedRepo,
        color: '#0EA5E9',
        worktrees: [],
        collapsed: false,
        order: 1,
        owner: OWNER,
      },
    });
    const { events, ...effects } = withoutResult(added);
    // The index commits first; the manifests and lists of every item follow
    // concurrently, so their order is not part of the contract.
    expect(events.slice(0, 2)).toEqual([
      'decision:workspace.add',
      {
        commit: 'w5.workspace_index.write',
        advance: ['workspaces', 'workspace:claimed'],
        files: INDEX_FILES,
      },
    ]);
    const fileCommits = events.slice(2).filter(isCommitEvent);
    expect(fileCommits).toHaveLength(3);
    expect(fileCommits).toEqual(
      expect.arrayContaining([
        {
          commit: 'w5.workspace_manifest.write',
          advance: ['workspace:claimed'],
          files: ['claimed/workspace.json'],
        },
        {
          commit: 'w5.workspace_manifest.write',
          advance: ['workspace:a'],
          files: ['a/workspace.json'],
        },
        {
          commit: 'w5.worktree_list.write',
          advance: [],
          files: ['claimed/worktrees.json'],
        },
      ]),
    );
    expect(events.filter((event) => event === 'sync')).toHaveLength(3);
    expect(events.filter((event) => event === 'notify')).toHaveLength(3);
    expect(events).toHaveLength(11);
    // `a`'s unchanged list is not rewritten.
    expect(effects).toEqual({
      advanced: { workspaces: 1, 'workspace:a': 1, 'workspace:claimed': 2 },
      changed: [
        'a/workspace.json',
        'claimed/workspace.json',
        'claimed/worktrees.json',
        'index.json',
        'index.json.bak',
      ],
    });
    expect(json('index.json')).toEqual({
      version: 1,
      workspaces: [
        ORIGINAL_ENTRY,
        {
          id: 'claimed',
          name: 'Claimed',
          type: 'single-repo',
          color: '#0EA5E9',
          collapsed: false,
          order: 1,
        },
      ],
    });
    expect(json('claimed/workspace.json')).toEqual({
      version: 1,
      type: 'single-repo',
      repoPath: claimedRepo,
      repos: [],
      owner: OWNER,
    });
    // An owned destination never writes the user's repository.
    expect(existsSync(join(claimedRepo, 'canopy.json'))).toBe(false);
  });

  it('commits a scoped addition once in its caller step, writing only its own files', async () => {
    const freshRepo = cloneRepository('fresh-repo');
    const added = await observe(() =>
      findOrCreateSingleRepoWorkspaceForRepo(freshRepo, 'Fresh', {
        commit: { operation: 'core.sharedContainer.fork' },
      }),
    );
    expect(added.result).toMatchObject({
      created: true,
      workspace: { id: 'fresh', order: 1 },
    });
    expect(withoutResult(added)).toEqual({
      events: [
        'decision:workspace.add',
        {
          commit: 'core.sharedContainer.fork',
          advance: ['workspaces', 'workspace:fresh'],
          files: [
            ...INDEX_FILES,
            'fresh/workspace.json',
            'fresh/worktrees.json',
          ],
        },
        ...CREATE_HOOKS,
      ],
      advanced: { workspaces: 1, 'workspace:fresh': 1 },
      changed: [
        'fresh/workspace.json',
        'fresh/worktrees.json',
        'index.json',
        'index.json.bak',
      ],
    });
    expect(existsSync(join(freshRepo, 'canopy.json'))).toBe(true);
  });

  it('refuses an identity in use before any decision', async () => {
    const claimedRepo = cloneRepository('claimed-repo');
    const refused = await observeRefusal(() =>
      findOrCreateSingleRepoWorkspaceForRepo(claimedRepo, 'Claimed', {
        owner: OWNER,
        localWorkspaceId: 'a',
      }),
    );
    expect(refused.result).toBeInstanceOf(WorkspaceIdentityInUseError);
    expect(withoutResult(refused)).toEqual({
      events: [],
      advanced: {},
      changed: [],
    });
  });
});

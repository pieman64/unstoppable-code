// W6a2 (CAN-4814): the W5 commits of the Cowork create, stage, publish,
// import/install/blueprint metadata and discard records through the record
// decision port, on the real commit log worker.
//
// One log interleaves each port decision (as JSON, so it is plain data), each
// reservation and commit the worker receives and the post-commit hooks. A
// create commits once in its reserved boundary step; every other record is
// unkeyed and runs outside a boundary step, so each write commits on its own
// under its plain label. A declined, refused or unchanged record commits
// nothing and leaves every byte and revision as it was. Without the decision
// entries, each expected log is the one the code before the port produced.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type {
  W5CommitRequest,
  W5Resource,
} from '@canopy/desktop-shared/node/w5-commit-log';
import type {
  CoworkSidebarItem,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as CoworkPort from '../cowork-record-decision-port';
import type {
  CoworkCreationAllocationDecision,
  CoworkCreationDecision,
  CoworkCreationManifestDecision,
  CoworkDiscardDecision,
  CoworkMetadataDecision,
  CoworkPublishDecision,
  CoworkStageDecision,
} from '../worktree-record-decisions';

const mockEvents: unknown[] = [];
let mockRmFailPath: string | undefined;

/** Logs a decision and passes on its JSON copy. */
function mockDecision<T extends { kind: string }>(decision: T): T {
  mockEvents.push(`decision:${decision.kind}`);
  return JSON.parse(JSON.stringify(decision)) as T;
}

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>): Promise<void> =>
      args[0] === mockRmFailPath
        ? Promise.reject(
            Object.assign(new Error('EBUSY: resource busy'), {
              code: 'EBUSY',
            }),
          )
        : actual.rm(...args),
  };
});
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn((diagnostic: { kind?: string }) =>
      mockEvents.push(`diagnostic:${diagnostic.kind ?? 'unknown'}`),
    ),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(() => mockEvents.push('sync')),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(() => mockEvents.push('notify')),
}));
jest.mock('../cowork-record-decision-port', () => {
  const actual = jest.requireActual<typeof CoworkPort>(
    '../cowork-record-decision-port',
  );
  return {
    ...actual,
    applyCoworkCreationAllocation: (
      decision: CoworkCreationAllocationDecision,
      admit: (id: string) => void,
    ): Promise<unknown> =>
      actual.applyCoworkCreationAllocation(mockDecision(decision), admit),
    applyCoworkCreationDecision: (
      decision: CoworkCreationDecision,
      beforeScaffold: () => void,
    ): Promise<unknown> =>
      actual.applyCoworkCreationDecision(
        mockDecision(decision),
        beforeScaffold,
      ),
    applyCoworkCreationManifestDecision: (
      workspaceId: string,
      decision: CoworkCreationManifestDecision,
    ): Promise<unknown> =>
      actual.applyCoworkCreationManifestDecision(
        workspaceId,
        mockDecision(decision),
      ),
    applyCoworkStageDecision: (
      decision: CoworkStageDecision,
    ): Promise<unknown> =>
      actual.applyCoworkStageDecision(mockDecision(decision)),
    applyCoworkPublishDecision: (
      decision: CoworkPublishDecision,
      precheck?: () => Promise<void>,
    ): Promise<unknown> =>
      actual.applyCoworkPublishDecision(mockDecision(decision), precheck),
    applyCoworkMetadataDecision: (
      decision: CoworkMetadataDecision,
    ): Promise<unknown> =>
      actual.applyCoworkMetadataDecision(mockDecision(decision)),
    applyCoworkDiscardDecision: (
      decision: CoworkDiscardDecision,
    ): Promise<unknown> =>
      actual.applyCoworkDiscardDecision(mockDecision(decision)),
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
import * as chatProjectUtils from '../chat-project-utils';
import { workspaceCreationDiagnosticsSchema } from '../w5-workspace-creation-diagnostics';
import {
  CoworkWorkspaceRecordRefusedError,
  discardCoworkWorkspaceRecord,
  publishCoworkWorkspaceRecord,
  recordCoworkWorkspaceMetadata,
  recordNewCoworkWorkspace,
  recordStagedCoworkWorkspace,
} from '../cowork-workspace-records';

jest.setTimeout(60_000);

type OrganizationOwner = Extract<
  WorkspaceOwnerBinding,
  { type: 'organization' }
>;
const OWNER: OrganizationOwner = {
  type: 'organization',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  bindingGeneration: 2,
};
const OTHER_PROJECT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_INSTANCE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CREATED_AT = '2026-10-01T00:00:00.000Z';

let dir: string;
let root: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
/** Runs after each commit the worker accepts, as a writer outside the locks. */
let afterWorkerCommit: ((request: W5CommitRequest) => void) | undefined;

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
      const committed = await commit(request);
      afterWorkerCommit?.(request);
      return committed;
    });
  const reserve = host.reserve.bind(host);
  jest.spyOn(host, 'reserve').mockImplementation(async (input) => {
    mockEvents.push(`reserve:${input.operation}`);
    return reserve(input);
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
}

beforeEach(() => {
  // Recovery and path tests use the canonical TMPDIR.
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'w5-cowork-commits-'));
  root = join(dir, 'data', 'workspaces');
  mkdirSync(root, { recursive: true });
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  afterWorkerCommit = undefined;
  mockRmFailPath = undefined;
  startHost();
  mockEvents.length = 0;
});
afterEach(async () => {
  await settleDetachedWork();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

interface CommitEvent {
  commit: string;
  advance: string[];
  files: string[];
  reservation?: true;
}
function commitEvent(request: W5CommitRequest): CommitEvent {
  return {
    commit: request.operation,
    advance: request.advance.map(w5ResourceKey),
    files: request.files.map((file) => relative(root, file.path)),
    ...(request.reservationId ? { reservation: true } : {}),
  };
}
const MANIFEST_WRITE = 'w5.workspace_manifest.write';
const INDEX_WRITE = 'w5.workspace_index.write';
function manifestCommit(workspaceId: string): CommitEvent {
  return {
    commit: MANIFEST_WRITE,
    advance: [`workspace:${workspaceId}`],
    files: [join(workspaceId, 'workspace.json')],
  };
}
function indexCommit(advance: string[]): CommitEvent {
  // The index writer keeps a backup of the replaced file.
  return {
    commit: INDEX_WRITE,
    advance,
    files: ['index.json', 'index.json.bak'],
  };
}

function seed(file: string, value: unknown): void {
  const path = join(root, file);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}
function indexEntry(
  id: string,
  order: number,
  fields: { type?: string; name?: string } = {},
): Record<string, unknown> {
  return {
    id,
    name: fields.name ?? id,
    type: fields.type ?? 'cowork',
    color: '#123456',
    collapsed: false,
    order,
  };
}
function seedIndex(
  entries: Array<{ id: string; type?: string; name?: string }>,
): void {
  seed('index.json', {
    version: 1,
    workspaces: entries.map((entry, order) =>
      indexEntry(entry.id, order, entry),
    ),
  });
}
function coworkManifest(fields: object = {}): Record<string, unknown> {
  return { version: 1, type: 'cowork', repos: [], ...fields };
}
function seedManifest(workspaceId: string, fields: object = {}): void {
  seed(join(workspaceId, 'workspace.json'), coworkManifest(fields));
}
const UNREADABLE = '{"truncated":';
function read(file: string): string | undefined {
  const path = join(root, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}
/** The bytes a W5 writer produces for `value`. */
function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Every file under the data directory, by path, with its bytes. */
function images(): Record<string, string> {
  const files: Record<string, string> = {};
  const data = join(dir, 'data');
  const visit = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      if (lstatSync(child).isDirectory()) visit(child);
      else files[relative(data, child)] = readFileSync(child, 'utf8');
    }
  };
  visit(data);
  return files;
}
const IDS = ['a', 'fresh', 'fresh-2', 'staged', 'other'];
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
  /** The data files whose bytes changed, appeared or disappeared. */
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
/** Nothing committed, advanced or changed: only `events` were logged. */
function nothingBut(events: unknown[]): Omit<Observed<unknown>, 'result'> {
  return { events, advanced: {}, changed: [] };
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

/** The home scaffold of a managed Cowork workspace. */
function scaffoldFiles(workspaceId: string): string[] {
  return Object.keys(images())
    .filter((file) => file.startsWith(join('workspaces', workspaceId, 'home')))
    .sort();
}

describe('Cowork create', () => {
  it('creates a managed workspace in one reserved commit: the scaffold, the index, then the manifest', async () => {
    seedIndex([{ id: 'a' }]);
    seedManifest('a');
    const created = await observe(() =>
      recordNewCoworkWorkspace({
        source: 'managed_create',
        name: ' Fresh ',
        createdAt: CREATED_AT,
      }),
    );
    const item = {
      id: 'fresh',
      name: 'Fresh',
      type: 'cowork',
      color: '#0EA5E9',
      collapsed: false,
      order: 1,
      cowork: { createdAt: CREATED_AT, archiveRetentionDays: 7 },
    };
    expect(created.result).toEqual(item);
    expect(withoutResult(created)).toEqual({
      events: [
        'decision:cowork.create.allocate',
        'reserve:core.workspace.create',
        'decision:cowork.create',
        'decision:cowork.create.manifest',
        {
          commit: 'core.workspace.create',
          advance: ['workspaces', 'workspace:fresh'],
          files: ['index.json', 'index.json.bak', 'fresh/workspace.json'],
          reservation: true,
        },
        'sync',
        'sync',
        'notify',
      ],
      advanced: { workspaces: 1, 'workspace:fresh': 1 },
      changed: [
        'workspaces/fresh/home/AGENTS.md',
        'workspaces/fresh/home/CLAUDE.md',
        'workspaces/fresh/workspace.json',
        'workspaces/index.json',
        'workspaces/index.json.bak',
      ],
    });
    expect(read('index.json')).toBe(
      pretty({
        version: 1,
        workspaces: [
          indexEntry('a', 0),
          {
            id: 'fresh',
            name: 'Fresh',
            type: 'cowork',
            color: '#0EA5E9',
            collapsed: false,
            order: 1,
          },
        ],
      }),
    );
    expect(read('fresh/workspace.json')).toBe(
      pretty(
        coworkManifest({
          cowork: { createdAt: CREATED_AT, archiveRetentionDays: 7 },
          alwaysShow: true,
        }),
      ),
    );
    expect(await localReservations()).toEqual([]);
  });
});

describe('Cowork create, continued', () => {
  it('creates a bound workspace with its manifest inside the index update, in one reserved commit', async () => {
    seedIndex([{ id: 'a' }]);
    const created = await observe(() =>
      recordNewCoworkWorkspace({
        source: 'managed_create',
        name: 'Fresh',
        createdAt: CREATED_AT,
        owner: OWNER,
      }),
    );
    expect(created.result).toMatchObject({ id: 'fresh', owner: OWNER });
    expect(withoutResult(created)).toEqual({
      events: [
        'decision:cowork.create.allocate',
        'reserve:core.workspace.create',
        'decision:cowork.create',
        {
          commit: 'core.workspace.create',
          advance: ['workspace:fresh', 'workspaces'],
          files: ['fresh/workspace.json', 'index.json', 'index.json.bak'],
          reservation: true,
        },
        'sync',
        'sync',
        'notify',
      ],
      advanced: { workspaces: 1, 'workspace:fresh': 1 },
      changed: [
        'workspaces/fresh/home/AGENTS.md',
        'workspaces/fresh/home/CLAUDE.md',
        'workspaces/fresh/workspace.json',
        'workspaces/index.json',
        'workspaces/index.json.bak',
      ],
    });
    expect(read('fresh/workspace.json')).toBe(
      pretty(
        coworkManifest({
          cowork: { createdAt: CREATED_AT, archiveRetentionDays: 7 },
          alwaysShow: true,
          owner: OWNER,
        }),
      ),
    );
  });

  it('attaches an external folder without a scaffold or any write inside it', async () => {
    seedIndex([{ id: 'a' }]);
    const folder = join(dir, 'attached');
    mkdirSync(folder);
    writeFileSync(join(folder, 'sentinel.txt'), 'user-owned');
    const created = await observe(() =>
      recordNewCoworkWorkspace({
        source: 'external_import',
        name: 'Fresh',
        createdAt: CREATED_AT,
        externalPath: folder,
      }),
    );
    expect(created.result).toMatchObject({ id: 'fresh', externalPath: folder });
    expect(withoutResult(created)).toEqual({
      events: [
        'decision:cowork.create.allocate',
        'reserve:core.workspace.create',
        'decision:cowork.create',
        'decision:cowork.create.manifest',
        {
          commit: 'core.workspace.create',
          advance: ['workspaces', 'workspace:fresh'],
          files: ['index.json', 'index.json.bak', 'fresh/workspace.json'],
          reservation: true,
        },
        'sync',
        'sync',
        'notify',
      ],
      advanced: { workspaces: 1, 'workspace:fresh': 1 },
      changed: [
        'workspaces/fresh/workspace.json',
        'workspaces/index.json',
        'workspaces/index.json.bak',
      ],
    });
    expect(readdirSync(folder)).toEqual(['sentinel.txt']);
    expect(read('fresh/workspace.json')).toBe(
      pretty(
        coworkManifest({
          externalPath: folder,
          cowork: { createdAt: CREATED_AT, archiveRetentionDays: 7 },
          alwaysShow: true,
        }),
      ),
    );
  });

  it('allocates past indexed, pending and occupied identities', async () => {
    seedIndex([{ id: 'fresh' }]);
    // A leftover directory with no manifest still occupies its identity.
    mkdirSync(join(root, 'fresh-2'));
    const created = await observe(() =>
      recordNewCoworkWorkspace({
        source: 'managed_create',
        name: 'Fresh',
        createdAt: CREATED_AT,
      }),
    );
    expect(created.result).toMatchObject({ id: 'fresh-3', order: 1 });
    expect(read('fresh-3/workspace.json')).toBeDefined();
  });

  it('refuses an empty name, an unprobeable identity and an unreadable index before any reservation', async () => {
    seedIndex([{ id: 'a' }]);
    const empty = await observeRefusal(() =>
      recordNewCoworkWorkspace({
        source: 'managed_create',
        name: '   ',
        createdAt: CREATED_AT,
      }),
    );
    expect(empty.result).toMatchObject({
      reason: 'invalid-request',
      message: 'Project name is required',
    });
    expect(withoutResult(empty)).toEqual(nothingBut([]));

    const long = await observeRefusal(() =>
      recordNewCoworkWorkspace({
        source: 'managed_create',
        name: 'x'.repeat(300),
        createdAt: CREATED_AT,
      }),
    );
    // The occupancy probe fails before the id is admitted, as before.
    expect(long.result).not.toBeInstanceOf(CoworkWorkspaceRecordRefusedError);
    expect(long.result).toMatchObject({ code: 'ENAMETOOLONG' });
    expect(withoutResult(long)).toEqual(
      nothingBut(['decision:cowork.create.allocate']),
    );

    seed('index.json', UNREADABLE);
    const unreadable = await observeRefusal(() =>
      recordNewCoworkWorkspace({
        source: 'managed_create',
        name: 'Fresh',
        createdAt: CREATED_AT,
      }),
    );
    expect(unreadable.result).toMatchObject({ reason: 'index-unavailable' });
    expect(withoutResult(unreadable)).toEqual(
      nothingBut(['decision:cowork.create.allocate']),
    );
    expect(await localReservations()).toEqual([]);
  });

  it('keeps the scaffold and the identity for recovery when the index changes after the scaffold', async () => {
    seedIndex([{ id: 'a' }]);
    const foreign = pretty({
      version: 1,
      workspaces: [indexEntry('a', 0), indexEntry('other', 1)],
    });
    const scaffold = chatProjectUtils.ensureCoworkHomeScaffold;
    jest
      .spyOn(chatProjectUtils, 'ensureCoworkHomeScaffold')
      .mockImplementation(async (workspaceId) => {
        await scaffold(workspaceId);
        // A writer outside the locks changes the index after the effect.
        writeFileSync(join(root, 'index.json'), foreign);
      });
    const conflicted = await observeRefusal(() =>
      recordNewCoworkWorkspace({
        source: 'managed_create',
        name: 'Fresh',
        createdAt: CREATED_AT,
      }),
    );
    expect(conflicted.result).toMatchObject({ reason: 'fingerprint-conflict' });
    // The decision is refused before the worker: no commit, no revision.
    expect(withoutResult(conflicted)).toEqual({
      events: [
        'decision:cowork.create.allocate',
        'reserve:core.workspace.create',
        'decision:cowork.create',
        'decision:cowork.create.manifest',
      ],
      advanced: {},
      changed: [
        'workspaces/fresh/home/AGENTS.md',
        'workspaces/fresh/home/CLAUDE.md',
        'workspaces/index.json',
      ],
    });
    expect(read('index.json')).toBe(foreign);
    expect(read('fresh/workspace.json')).toBeUndefined();
    const [identity] = await localReservations();
    expect(identity?.workspaceId).toBe('fresh');

    // After a restart the retained identity is reported for recovery, never adopted.
    await host.shutdown();
    startHost();
    __resetSidebarItemsStateForTests();
    expect(
      (await host.recoveryReport()).recoveryRequiredReservations,
    ).toHaveLength(1);
    expect(scaffoldFiles('fresh')).toEqual([
      'workspaces/fresh/home/AGENTS.md',
      'workspaces/fresh/home/CLAUDE.md',
    ]);
    expect(read('index.json')).toBe(foreign);
  });
});

function stagedItem(
  fields: Partial<CoworkSidebarItem> = {},
): CoworkSidebarItem {
  return {
    id: 'staged',
    name: 'Staged',
    type: 'cowork',
    color: '#7C3AED',
    collapsed: false,
    order: 0,
    cowork: { createdAt: CREATED_AT, archiveRetentionDays: 7 },
    owner: OWNER,
    ...fields,
  };
}

describe('Cowork stage', () => {
  const stage = (item: CoworkSidebarItem = stagedItem()): Promise<boolean> =>
    recordStagedCoworkWorkspace({ source: 'org_cowork_stage', item });

  it('stages an absent manifest in one manifest commit, then refreshes its owner in another', async () => {
    seedIndex([{ id: 'a' }]);
    const staged = await observe(() => stage());
    expect(staged.result).toBe(true);
    expect(withoutResult(staged)).toEqual({
      events: ['decision:cowork.stage', manifestCommit('staged')],
      advanced: { 'workspace:staged': 1 },
      changed: ['workspaces/staged/workspace.json'],
    });
    expect(read('staged/workspace.json')).toBe(
      pretty(
        coworkManifest({
          cowork: { createdAt: CREATED_AT, archiveRetentionDays: 7 },
          alwaysShow: true,
          owner: OWNER,
        }),
      ),
    );

    // The same owner rewrites the same bytes, which commits nothing.
    const same = await observe(() => stage());
    expect(same.result).toBe(false);
    expect(withoutResult(same)).toEqual(nothingBut(['decision:cowork.stage']));

    const rebound = { ...OWNER, instanceId: OTHER_INSTANCE };
    const refreshed = await observe(() =>
      stage(stagedItem({ owner: rebound, name: 'Ignored' })),
    );
    expect(refreshed.result).toBe(false);
    expect(withoutResult(refreshed)).toEqual({
      events: ['decision:cowork.stage', manifestCommit('staged')],
      advanced: { 'workspace:staged': 1 },
      changed: ['workspaces/staged/workspace.json'],
    });
    expect(read('staged/workspace.json')).toBe(
      pretty(
        coworkManifest({
          cowork: { createdAt: CREATED_AT, archiveRetentionDays: 7 },
          alwaysShow: true,
          owner: rebound,
        }),
      ),
    );
  });

  it('refuses another project, a code manifest, an unreadable manifest, an indexed id without a manifest and another index type unchanged', async () => {
    seedIndex([{ id: 'a', type: 'single-repo' }, { id: 'other' }]);
    seedManifest('staged', { owner: { ...OWNER, projectId: OTHER_PROJECT } });
    seed(join('fresh', 'workspace.json'), UNREADABLE);
    seed(
      join('fresh-2', 'workspace.json'),
      '{"version":1,"type":"single-repo","repos":[]}',
    );
    for (const [id, events] of [
      ['staged', []],
      ['fresh', ['diagnostic:workspace_config_write_refused']],
      ['fresh-2', []],
      ['other', []],
      ['a', []],
    ] as const) {
      const refused = await observeRefusal(() => stage(stagedItem({ id })));
      expect(refused.result).toMatchObject({
        reason: 'identity-changed',
        message: 'The local workspace id is already in use',
      });
      expect(withoutResult(refused)).toEqual(
        nothingBut(['decision:cowork.stage', ...events]),
      );
    }
    expect(read('other/workspace.json')).toBeUndefined();

    const unbound = await observeRefusal(() =>
      stage(stagedItem({ owner: undefined })),
    );
    expect(unbound.result).toMatchObject({ reason: 'identity-changed' });
    expect(withoutResult(unbound)).toEqual(nothingBut([]));

    seed('index.json', UNREADABLE);
    const index = await observeRefusal(() => stage());
    expect(index.result).toMatchObject({ reason: 'index-unavailable' });
    expect(withoutResult(index)).toEqual(nothingBut(['decision:cowork.stage']));
  });
});

describe('Cowork publish', () => {
  const publish = (
    fields: Partial<Parameters<typeof publishCoworkWorkspaceRecord>[0]> = {},
  ): Promise<CoworkSidebarItem> =>
    publishCoworkWorkspaceRecord({
      source: 'org_cowork_publish',
      workspaceId: 'staged',
      name: ' Published ',
      owner: OWNER,
      ...fields,
    });

  it('publishes a staged manifest: the manifest, then the index; a retry commits nothing', async () => {
    seedIndex([{ id: 'a' }]);
    seedManifest('staged', {
      cowork: { createdAt: CREATED_AT, future: true },
      owner: { ...OWNER, bindingGeneration: 1 },
      ownershipTransfer: {
        version: 1,
        previousOwner: { type: 'personal' },
        organizationId: OWNER.organizationId,
        projectId: OWNER.projectId,
        convertedAt: CREATED_AT,
      },
    });
    const published = await observe(() => publish());
    // The projection is taken before the owner changes: it reports the new
    // owner but still carries the cleared transfer, as before.
    expect(published.result).toMatchObject({
      id: 'staged',
      name: 'Published',
      type: 'cowork',
      color: '#0EA5E9',
      collapsed: false,
      order: 1,
      cowork: { createdAt: CREATED_AT, future: true },
      owner: OWNER,
      ownershipTransfer: { organizationId: OWNER.organizationId },
    });
    expect(withoutResult(published)).toEqual({
      events: [
        'decision:cowork.publish',
        manifestCommit('staged'),
        indexCommit(['workspaces', 'workspace:staged']),
        'sync',
        'sync',
        'notify',
      ],
      advanced: { workspaces: 1, 'workspace:staged': 2 },
      changed: [
        'workspaces/index.json',
        'workspaces/index.json.bak',
        'workspaces/staged/workspace.json',
      ],
    });
    // Unknown Cowork fields lead; the transfer is cleared.
    expect(read('staged/workspace.json')).toBe(
      pretty(
        coworkManifest({
          cowork: { future: true, createdAt: CREATED_AT },
          alwaysShow: true,
          owner: OWNER,
        }),
      ),
    );
    expect(read('index.json')).toBe(
      pretty({
        version: 1,
        workspaces: [
          indexEntry('a', 0),
          {
            id: 'staged',
            name: 'Published',
            type: 'cowork',
            color: '#0EA5E9',
            collapsed: false,
            order: 1,
          },
        ],
      }),
    );

    const again = await observe(() => publish());
    expect(again.result).toMatchObject({ id: 'staged', name: 'Published' });
    expect(withoutResult(again)).toEqual(
      nothingBut(['decision:cowork.publish']),
    );

    const renamed = await observe(() => publish({ name: 'Renamed' }));
    expect(renamed.result).toMatchObject({ name: 'Renamed', order: 1 });
    // The manifest is rewritten with the same bytes, which commits nothing.
    expect(withoutResult(renamed)).toEqual({
      events: [
        'decision:cowork.publish',
        indexCommit(['workspace:staged']),
        'sync',
        'sync',
        'notify',
      ],
      advanced: { 'workspace:staged': 1 },
      changed: ['workspaces/index.json', 'workspaces/index.json.bak'],
    });
  });

  it('refuses a missing, unreadable, unbound or other-project manifest and another index type unchanged; a failed precheck writes nothing', async () => {
    seedIndex([{ id: 'a', type: 'single-repo' }]);
    seed(join('fresh', 'workspace.json'), UNREADABLE);
    seedManifest('other', { owner: { ...OWNER, projectId: OTHER_PROJECT } });
    seedManifest('fresh-2');
    for (const [workspaceId, events] of [
      ['staged', []],
      ['fresh', ['diagnostic:workspace_config_write_refused']],
      ['other', []],
      ['fresh-2', []],
    ] as const) {
      const refused = await observeRefusal(() => publish({ workspaceId }));
      expect(refused.result).toMatchObject({
        reason: 'configuration-unavailable',
        message: 'The staged Cowork workspace is unavailable',
      });
      expect(withoutResult(refused)).toEqual(
        nothingBut(['decision:cowork.publish', ...events]),
      );
    }
    expect(read('staged/workspace.json')).toBeUndefined();

    seedManifest('a', { owner: OWNER });
    const otherType = await observeRefusal(() => publish({ workspaceId: 'a' }));
    expect(otherType.result).toMatchObject({ reason: 'identity-changed' });
    expect(withoutResult(otherType)).toEqual(
      nothingBut(['decision:cowork.publish']),
    );

    seedManifest('staged', { owner: OWNER });
    const precheck = jest.fn(() =>
      Promise.reject(new Error('organization project is gone')),
    );
    const failed = await observeRefusal(() => publish({ precheck }));
    expect(failed.result).toMatchObject({
      message: 'organization project is gone',
    });
    expect(precheck).toHaveBeenCalledTimes(1);
    expect(withoutResult(failed)).toEqual(
      nothingBut(['decision:cowork.publish']),
    );

    seed('index.json', UNREADABLE);
    const index = await observeRefusal(() => publish());
    expect(index.result).toMatchObject({ reason: 'index-unavailable' });
    expect(withoutResult(index)).toEqual(
      nothingBut(['decision:cowork.publish']),
    );
  });

  it('keeps the committed manifest when the index changes after it, refusing the index write', async () => {
    seedIndex([{ id: 'a' }]);
    seedManifest('staged', { owner: { ...OWNER, bindingGeneration: 1 } });
    const foreign = pretty({
      version: 1,
      workspaces: [indexEntry('a', 0), indexEntry('other', 1)],
    });
    afterWorkerCommit = (request): void => {
      if (request.operation === MANIFEST_WRITE)
        writeFileSync(join(root, 'index.json'), foreign);
    };
    const conflicted = await observeRefusal(() => publish());
    expect(conflicted.result).toMatchObject({ reason: 'fingerprint-conflict' });
    // Two plain commits, as before the port: no recovery marker or rollback.
    expect(withoutResult(conflicted)).toEqual({
      events: ['decision:cowork.publish', manifestCommit('staged')],
      advanced: { 'workspace:staged': 1 },
      changed: ['workspaces/index.json', 'workspaces/staged/workspace.json'],
    });
    expect(read('staged/workspace.json')).toBe(
      pretty(coworkManifest({ alwaysShow: true, owner: OWNER })),
    );
    expect(read('index.json')).toBe(foreign);
  });
});

const HASH = 'a'.repeat(64);
const SELECTIONS = { collectionIds: [], skillRefs: [], pluginRefs: [] };
const IMPORTED_SELECTIONS = {
  collectionIds: ['collection'],
  skillRefs: [],
  pluginRefs: [],
};
describe('Cowork import, install and blueprint metadata', () => {
  beforeEach(() => {
    seedIndex([{ id: 'a' }, { id: 'fresh', name: 'Fresh' }]);
    seedManifest('fresh', {
      cowork: { createdAt: CREATED_AT, description: 'old', future: true },
      defaultPluginSelections: SELECTIONS,
    });
  });

  it('records an install and a blueprint in one manifest commit each, keeping hidden Cowork fields', async () => {
    const index = read('index.json');
    const installed = await observe(() =>
      recordCoworkWorkspaceMetadata({
        source: 'template_install',
        workspaceId: 'fresh',
        change: { kind: 'install', externalId: 'template', contentHash: HASH },
      }),
    );
    expect(withoutResult(installed)).toEqual({
      events: [
        'decision:cowork.metadata.install',
        manifestCommit('fresh'),
        'sync',
        'notify',
      ],
      advanced: { 'workspace:fresh': 1 },
      changed: ['workspaces/fresh/workspace.json'],
    });
    const blueprint = await observe(() =>
      recordCoworkWorkspaceMetadata({
        source: 'blueprint_create',
        workspaceId: 'fresh',
        change: { kind: 'blueprint', externalId: 'blueprint' },
      }),
    );
    expect(withoutResult(blueprint)).toEqual({
      events: [
        'decision:cowork.metadata.blueprint',
        manifestCommit('fresh'),
        'sync',
        'notify',
      ],
      advanced: { 'workspace:fresh': 1 },
      changed: ['workspaces/fresh/workspace.json'],
    });
    expect(read('fresh/workspace.json')).toBe(
      pretty(
        coworkManifest({
          cowork: { future: true, createdAt: CREATED_AT, description: 'old' },
          defaultPluginSelections: SELECTIONS,
          installedFromTemplateExternalId: 'template',
          installedFromTemplateContentHash: HASH,
          seededFromBlueprintExternalId: 'blueprint',
          alwaysShow: true,
        }),
      ),
    );
    expect(read('index.json')).toBe(index);
  });

  it('imports settings over the manifest, then the color and the bundle name into the index', async () => {
    // The bundle import passes its whole manifest, name included.
    const bundle = {
      version: 1,
      name: ' Bundle ',
      color: '#22C55E',
      cowork: { createdAt: CREATED_AT, description: 'imported' },
      defaultPluginSelections: IMPORTED_SELECTIONS,
    };
    const imported = await observe(() =>
      recordCoworkWorkspaceMetadata({
        source: 'bundle_import',
        workspaceId: 'fresh',
        change: { kind: 'import', ...bundle },
      }),
    );
    expect(withoutResult(imported)).toEqual({
      events: [
        'decision:cowork.metadata.import',
        manifestCommit('fresh'),
        indexCommit(['workspace:fresh']),
        'sync',
        'sync',
        'notify',
      ],
      advanced: { 'workspace:fresh': 2 },
      changed: [
        'workspaces/fresh/workspace.json',
        'workspaces/index.json',
        'workspaces/index.json.bak',
      ],
    });
    expect(read('fresh/workspace.json')).toBe(
      pretty(
        coworkManifest({
          cowork: {
            future: true,
            createdAt: CREATED_AT,
            description: 'imported',
          },
          defaultPluginSelections: IMPORTED_SELECTIONS,
          alwaysShow: true,
        }),
      ),
    );
    expect(read('index.json')).toBe(
      pretty({
        version: 1,
        workspaces: [
          indexEntry('a', 0),
          { ...indexEntry('fresh', 1), name: 'Bundle', color: '#22C55E' },
        ],
      }),
    );

    const settingsOnly = await observe(() =>
      recordCoworkWorkspaceMetadata({
        source: 'bundle_import',
        workspaceId: 'fresh',
        change: { kind: 'import', defaultPluginSelections: SELECTIONS },
      }),
    );
    expect(withoutResult(settingsOnly)).toEqual({
      events: [
        'decision:cowork.metadata.import',
        manifestCommit('fresh'),
        'sync',
        'notify',
      ],
      advanced: { 'workspace:fresh': 1 },
      changed: ['workspaces/fresh/workspace.json'],
    });
  });

  it('keeps an imported manifest when the index changes after it, refusing the rename', async () => {
    const foreign = pretty({
      version: 1,
      workspaces: [indexEntry('a', 0), indexEntry('fresh', 1, { name: 'X' })],
    });
    afterWorkerCommit = (request): void => {
      if (request.operation === MANIFEST_WRITE)
        writeFileSync(join(root, 'index.json'), foreign);
    };
    const conflicted = await observeRefusal(() =>
      recordCoworkWorkspaceMetadata({
        source: 'bundle_import',
        workspaceId: 'fresh',
        change: { kind: 'import', color: '#22C55E', cowork: {} },
      }),
    );
    expect(conflicted.result).toMatchObject({ reason: 'fingerprint-conflict' });
    expect(withoutResult(conflicted)).toEqual({
      events: ['decision:cowork.metadata.import', manifestCommit('fresh')],
      advanced: { 'workspace:fresh': 1 },
      changed: ['workspaces/fresh/workspace.json', 'workspaces/index.json'],
    });
    expect(read('fresh/workspace.json')).toBe(
      pretty(
        coworkManifest({
          cowork: { future: true },
          defaultPluginSelections: SELECTIONS,
          alwaysShow: true,
        }),
      ),
    );
    expect(read('index.json')).toBe(foreign);
  });

  it('refuses a missing entry, another index type, a missing, code or unreadable manifest unchanged', async () => {
    seedIndex([
      { id: 'a', type: 'single-repo' },
      { id: 'fresh' },
      { id: 'fresh-2' },
      { id: 'other' },
    ]);
    seed(join('fresh-2', 'workspace.json'), UNREADABLE);
    seed(
      join('other', 'workspace.json'),
      '{"version":1,"type":"single-repo","repos":[]}',
    );
    for (const [workspaceId, reason, events] of [
      ['missing', 'not-found', []],
      ['a', 'not-found', []],
      ['staged', 'not-found', []],
      ['other', 'not-found', []],
      [
        'fresh-2',
        'configuration-unavailable',
        ['diagnostic:workspace_config_write_refused'],
      ],
    ] as const)
      for (const change of [
        { kind: 'install', externalId: 'template', contentHash: HASH },
        { kind: 'blueprint', externalId: 'blueprint' },
        { kind: 'import', color: '#000000' },
      ] as const) {
        const refused = await observeRefusal(() =>
          recordCoworkWorkspaceMetadata({
            source: 'template_install',
            workspaceId,
            change,
          }),
        );
        expect(refused.result).toMatchObject({ reason });
        expect(withoutResult(refused)).toEqual(
          nothingBut(['decision:cowork.metadata.' + change.kind, ...events]),
        );
      }
  });
});

describe('Cowork discard', () => {
  const discard = (
    workspaceId = 'staged',
    projectId = OWNER.projectId,
  ): Promise<void> =>
    discardCoworkWorkspaceRecord({
      source: 'org_cowork_discard',
      workspaceId,
      projectId,
    });

  it('removes exactly the matching unpublished metadata directory, by project, with zero commits; an attached folder is kept', async () => {
    seedIndex([{ id: 'a' }]);
    seedManifest('a', { owner: OWNER });
    const folder = join(dir, 'attached');
    mkdirSync(folder);
    writeFileSync(join(folder, 'sentinel.txt'), 'user-owned');
    // Re-staged by another claim instance of the same project.
    seedManifest('staged', {
      externalPath: folder,
      owner: { ...OWNER, instanceId: OTHER_INSTANCE },
    });
    seed(join('staged', 'home', 'CLAUDE.md'), 'staged home');
    const before = images();
    const removed = await observe(() => discard());
    expect(withoutResult(removed)).toEqual({
      events: ['decision:cowork.discard'],
      advanced: {},
      changed: [
        'workspaces/staged/home/CLAUDE.md',
        'workspaces/staged/workspace.json',
      ],
    });
    expect(existsSync(join(root, 'staged'))).toBe(false);
    expect(readdirSync(folder)).toEqual(['sentinel.txt']);
    const after = images();
    for (const file of Object.keys(before).filter(
      (path) => !path.startsWith(join('workspaces', 'staged')),
    ))
      expect(after[file]).toBe(before[file]);

    const again = await observe(() => discard());
    expect(withoutResult(again)).toEqual(
      nothingBut(['decision:cowork.discard']),
    );
  });

  it('keeps published, other-project, unbound, code, malformed-owner, unreadable and absent cases unchanged with zero commits', async () => {
    seedIndex([{ id: 'a' }]);
    seedManifest('a', { owner: OWNER });
    seedManifest('staged', { owner: { ...OWNER, projectId: OTHER_PROJECT } });
    seedManifest('fresh', { owner: { type: 'personal' } });
    seed(join('fresh-2', 'workspace.json'), UNREADABLE);
    seed(join('other', 'workspace.json'), {
      version: 1,
      type: 'single-repo',
      repoPath: '/repos/other',
      repos: [],
      owner: OWNER,
    });
    seedManifest('malformed', { owner: { type: 'organization' } });
    for (const workspaceId of [
      'a',
      'staged',
      'fresh',
      'fresh-2',
      'other',
      'malformed',
      'missing',
    ]) {
      const kept = await observe(() => discard(workspaceId));
      expect(withoutResult(kept)).toEqual(
        nothingBut(['decision:cowork.discard']),
      );
    }
    expect(existsSync(join(root, 'missing'))).toBe(false);
  });

  it('keeps even a matching manifest when the index cannot show it unpublished', async () => {
    seedManifest('staged', { owner: OWNER });
    for (const index of [
      UNREADABLE,
      '{"version":1,"workspaces":[{"id":"a"}]}',
    ]) {
      seed('index.json', index);
      const kept = await observe(() => discard());
      expect(withoutResult(kept)).toEqual(
        nothingBut(['decision:cowork.discard']),
      );
    }
    expect(read('staged/workspace.json')).toBeDefined();
  });

  it('removes a matching manifest when no index exists yet', async () => {
    seedManifest('staged', { owner: OWNER });
    const removed = await observe(() => discard());
    expect(withoutResult(removed)).toEqual({
      events: ['decision:cowork.discard'],
      advanced: {},
      changed: ['workspaces/staged/workspace.json'],
    });
  });

  it('surfaces a failed removal with zero commits and nothing changed', async () => {
    seedIndex([{ id: 'a' }]);
    seedManifest('staged', { owner: OWNER });
    mockRmFailPath = join(root, 'staged');
    const failed = await observeRefusal(() => discard());
    expect(failed.result).toMatchObject({ code: 'EBUSY' });
    expect(withoutResult(failed)).toEqual(
      nothingBut(['decision:cowork.discard']),
    );
  });

  it('waits for a create of the same id in the workspace queue, then keeps the published workspace', async () => {
    seedIndex([{ id: 'a' }]);
    const settled = await observe(() =>
      Promise.all([
        recordNewCoworkWorkspace({
          source: 'managed_create',
          name: 'Staged',
          createdAt: CREATED_AT,
          owner: OWNER,
        }),
        discard(),
      ]),
    );
    expect(settled.result[0]).toMatchObject({ id: 'staged', owner: OWNER });
    expect(
      settled.events.filter(
        (event) => typeof event !== 'string' || event.startsWith('decision:'),
      ),
    ).toEqual([
      'decision:cowork.create.allocate',
      'decision:cowork.create',
      {
        commit: 'core.workspace.create',
        advance: ['workspace:staged', 'workspaces'],
        files: ['staged/workspace.json', 'index.json', 'index.json.bak'],
        reservation: true,
      },
      'decision:cowork.discard',
    ]);
    expect(read('staged/workspace.json')).toBeDefined();
    expect(scaffoldFiles('staged')).toHaveLength(2);
  });

  it('refuses an invalid id before reading anything', async () => {
    const refused = await observeRefusal(() => discard('../escape'));
    expect(refused.result).toMatchObject({ reason: 'invalid-request' });
    expect(withoutResult(refused)).toEqual(nothingBut([]));
  });
});

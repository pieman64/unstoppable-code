// W5c2 (CAN-4807): the W5 commits of the ownership records, the organization
// private memory record, the index seed, the default Cowork provision, the
// two Cowork migrations and the sidebar seen record through the record
// decision port, on the real commit log worker.
//
// One log interleaves each port decision (as JSON, so it is plain data), each
// commit the worker receives and the post-commit hooks. Every record here is
// unkeyed and runs outside a boundary step, so each write commits on its own
// under its plain label; a declined, refused or unchanged record commits
// nothing and leaves every byte and revision as it was. Without the decision
// entries, each expected log is the one the code before the port produced.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type {
  W5CommitRequest,
  W5Resource,
} from '@canopy/desktop-shared/node/w5-commit-log';
import type {
  WorkspaceOwnerBinding,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as SidebarItemGroups from '../sidebar-item-groups';
import type * as OwnershipPort from '../workspace-ownership-decision-port';
import type * as CoworkPort from '../cowork-record-decision-port';
import type * as SeedPort from '../workspace-index-seed-decision-port';
import type * as RecordPort from '../workspace-record-decision-port';
import type {
  AdoptedWorkspaceReleaseDecision,
  CoworkIndexDecision,
  CoworkManifestDecision,
  CoworkProvisionDecision,
  OrganizationOwnerRefreshDecision,
  PersonalCatalogIdDecision,
  WorkspaceIndexSeedDecision,
  WorkspaceOwnerCompare,
  WorkspaceOwnershipDecision,
  WorktreeListPreconditions,
  WorktreeListUpdateDecision,
} from '../worktree-record-decisions';

const mockEvents: unknown[] = [];
let mockOrgProjectsEnabled = true;

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
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): unknown => ({
    isEnabled: (): boolean => mockOrgProjectsEnabled,
  }),
}));
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
jest.mock('../sidebar-item-groups', () => ({
  ...jest.requireActual<typeof SidebarItemGroups>('../sidebar-item-groups'),
  publishSidebarItemGroupsChanged: jest.fn(() => mockEvents.push('groups')),
}));
jest.mock('../../services/foreign-activity-sources', () => ({
  markForeignPipelineResultsSeen: jest.fn(
    (_workspaceId: string, _worktreeId: string, ids: string[]) =>
      mockEvents.push(`seen:${ids.join(',')}`),
  ),
}));
jest.mock('../workspace-ownership-decision-port', () => {
  const actual = jest.requireActual<typeof OwnershipPort>(
    '../workspace-ownership-decision-port',
  );
  return {
    ...actual,
    applyWorkspaceOwnerDecision: (
      workspaceId: string,
      decision: WorkspaceOwnerCompare | OrganizationOwnerRefreshDecision,
    ): Promise<unknown> =>
      typeof decision === 'function'
        ? actual.applyWorkspaceOwnerDecision(workspaceId, (current) => {
            // The compare's decision, logged where it is made: on the read.
            const replacement = decision(current);
            if (replacement) return mockDecision(replacement);
            mockEvents.push('decision:declined');
            return null;
          })
        : actual.applyWorkspaceOwnerDecision(
            workspaceId,
            mockDecision(decision),
          ),
    applyPersonalCatalogIdDecision: (
      workspaceId: string,
      decision: PersonalCatalogIdDecision,
      allowed: () => Promise<boolean>,
    ): Promise<unknown> =>
      actual.applyPersonalCatalogIdDecision(
        workspaceId,
        mockDecision(decision),
        allowed,
      ),
    applyWorkspaceOwnershipDecision: (
      workspaceId: string,
      decision: WorkspaceOwnershipDecision,
    ): Promise<unknown> =>
      actual.applyWorkspaceOwnershipDecision(
        workspaceId,
        mockDecision(decision),
      ),
    applyAdoptedWorkspaceRelease: (
      workspaceId: string,
      decision: AdoptedWorkspaceReleaseDecision,
    ): Promise<unknown> =>
      actual.applyAdoptedWorkspaceRelease(workspaceId, mockDecision(decision)),
  };
});
jest.mock('../cowork-record-decision-port', () => {
  const actual = jest.requireActual<typeof CoworkPort>(
    '../cowork-record-decision-port',
  );
  return {
    ...actual,
    applyCoworkProvisionDecision: (
      decision: CoworkProvisionDecision,
    ): Promise<unknown> =>
      actual.applyCoworkProvisionDecision(mockDecision(decision)),
    applyCoworkIndexDecision: (
      decision: CoworkIndexDecision,
    ): Promise<unknown> =>
      actual.applyCoworkIndexDecision(mockDecision(decision)),
    applyCoworkManifestDecision: (
      workspaceId: string,
      decision: CoworkManifestDecision,
    ): Promise<unknown> =>
      actual.applyCoworkManifestDecision(workspaceId, mockDecision(decision)),
  };
});
jest.mock('../workspace-index-seed-decision-port', () => {
  const actual = jest.requireActual<typeof SeedPort>(
    '../workspace-index-seed-decision-port',
  );
  return {
    ...actual,
    applyWorkspaceIndexSeed: (
      decision: WorkspaceIndexSeedDecision,
    ): Promise<unknown> =>
      actual.applyWorkspaceIndexSeed(mockDecision(decision)),
  };
});
jest.mock('../workspace-record-decision-port', () => {
  const actual = jest.requireActual<typeof RecordPort>(
    '../workspace-record-decision-port',
  );
  return {
    ...actual,
    applyWorktreeListUpdate: (
      workspaceId: string,
      decision: WorktreeListUpdateDecision,
      preconditions: WorktreeListPreconditions,
    ): Promise<unknown> =>
      actual.applyWorktreeListUpdate(
        workspaceId,
        mockDecision(decision),
        preconditions,
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
import {
  rebindWorkspaceHookExecutionContexts,
  recordOrganizationHookBindings,
  recordPersonalCatalogId,
  recordWorkspaceOwner,
  refreshOrganizationOwner,
  releaseAdoptedWorkspace,
  WorkspaceOwnershipRecordRefusedError,
} from '../workspace-ownership';
import {
  recordOrganizationPrivateMemory,
  WorkspacePrivateMemoryRefusedError,
} from '../workspace-private-memory';
import { WorkspaceConfigUnreadableError } from '../workspace-persistence';
import { seedWorkspaceIndex } from '../workspace-index-seed';
import {
  DEFAULT_COWORK_WORKSPACE_NAME,
  provisionCoworkWorkspaceRecord,
  recordMigratedCoworkWorkspace,
  renameDefaultCoworkWorkspaceRecord,
} from '../cowork-workspace-records';
import { recordSidebarPipelineResultsSeen } from '../sidebar-save-adapter';
import {
  listRegisteredWorkspaceIds,
  registerWorkspaceTypes,
} from '../workspace-registry';

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
const OTHER_INSTANCE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CREATED_AT = '2026-10-01T00:00:00.000Z';

let dir: string;
let root: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

beforeEach(() => {
  // Recovery and path tests use the canonical TMPDIR.
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'w5-ownership-commits-'));
  root = join(dir, 'data', 'workspaces');
  mkdirSync(root, { recursive: true });
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  mockOrgProjectsEnabled = true;
  __resetSidebarItemsStateForTests();
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
      return commit(request);
    });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
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
}
function commitEvent(request: W5CommitRequest): CommitEvent {
  return {
    commit: request.operation,
    advance: request.advance.map(w5ResourceKey),
    files: request.files.map((file) => relative(root, file.path)),
  };
}
const MANIFEST_WRITE = 'w5.workspace_manifest.write';
const INDEX_WRITE = 'w5.workspace_index.write';
const LIST_WRITE = 'w5.worktree_list.write';
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
    type: fields.type ?? 'single-repo',
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
function seedManifest(workspaceId: string, fields: object = {}): void {
  seed(join(workspaceId, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: `/repos/${workspaceId}`,
    repos: [],
    ...fields,
  });
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
function single(
  workspaceId: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    type: 'single-repo',
    repoPath: `/repos/${workspaceId}`,
    repos: [],
    ...fields,
  };
}

const IDS = ['a', 'b', 'cowork', 'legacy', 'legacy-2'];
/** Every canonical file under the root, by path, with its bytes. */
function images(): Record<string, string | undefined> {
  const files = ['index.json'];
  for (const id of IDS)
    files.push(join(id, 'workspace.json'), join(id, 'worktrees.json'));
  return Object.fromEntries(files.map((file) => [file, read(file)]));
}
const RESOURCES: W5Resource[] = [
  { kind: 'workspaces' },
  ...IDS.map((workspaceId): W5Resource => ({ kind: 'workspace', workspaceId })),
  { kind: 'worktrees', workspaceId: 'a' },
  { kind: 'worktree', workspaceId: 'a', worktreeId: 'w' },
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
  /** The canonical files whose bytes changed. */
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
    changed: Object.keys(afterImages).filter(
      (file) => afterImages[file] !== beforeImages[file],
    ),
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

const ownerRecord = (
  workspaceId: string,
): Parameters<typeof recordWorkspaceOwner>[0] => ({
  workspaceId,
  source: 'org_project_materialization',
  update: (current) => (current.owner === undefined ? { owner: OWNER } : null),
});

describe('ownership records', () => {
  it('records an owner in one manifest commit; a declined, absent or unreadable one commits nothing', async () => {
    seedIndex([{ id: 'a' }, { id: 'b' }, { id: 'cowork' }]);
    seedManifest('a', { archiveRetentionDays: 5 });
    seed(join('b', 'workspace.json'), UNREADABLE);
    seedManifest('cowork', { owner: { type: 'organization' } });

    const written = await observe(() => recordWorkspaceOwner(ownerRecord('a')));
    expect(written.result).toBe('written');
    expect(withoutResult(written)).toEqual({
      events: ['decision:ownership.owner', manifestCommit('a'), 'notify'],
      advanced: { 'workspace:a': 1 },
      changed: ['a/workspace.json'],
    });
    expect(read('a/workspace.json')).toBe(
      pretty(
        single('a', {
          alwaysShow: true,
          owner: OWNER,
          archiveRetentionDays: 5,
        }),
      ),
    );

    const declined = await observe(() =>
      recordWorkspaceOwner(ownerRecord('a')),
    );
    expect(declined.result).toBe('declined');
    expect(withoutResult(declined)).toEqual(nothingBut(['decision:declined']));

    // The compare never runs without an authoritative ownership read.
    for (const [workspaceId, status] of [
      ['missing', 'absent'],
      ['b', 'unreadable'],
      ['cowork', 'unreadable'],
    ]) {
      const refused = await observe(() =>
        recordWorkspaceOwner(ownerRecord(workspaceId)),
      );
      expect(refused.result).toBe(status);
      expect(withoutResult(refused)).toEqual(nothingBut([]));
    }
    expect(existsSync(join(root, 'missing'))).toBe(false);
  });

  it('refreshes a re-claim only forward; a stale fence commits nothing and a mismatch is refused unchanged', async () => {
    seedIndex([{ id: 'a' }, { id: 'b' }]);
    seedManifest('a', { owner: OWNER });
    seed(join('b', 'workspace.json'), UNREADABLE);

    const stale = await observe(() =>
      refreshOrganizationOwner({
        workspaceId: 'a',
        source: 'org_project_reclaim',
        owner: { ...OWNER, bindingGeneration: 1 },
      }),
    );
    expect(stale.result).toEqual(OWNER);
    expect(withoutResult(stale)).toEqual(
      nothingBut(['decision:ownership.organization.refresh']),
    );

    const advanced = { ...OWNER, bindingGeneration: 3 };
    const forward = await observe(() =>
      refreshOrganizationOwner({
        workspaceId: 'a',
        source: 'org_project_reclaim',
        owner: advanced,
      }),
    );
    expect(forward.result).toEqual(advanced);
    expect(withoutResult(forward)).toEqual({
      events: [
        'decision:ownership.organization.refresh',
        manifestCommit('a'),
        'notify',
      ],
      advanced: { 'workspace:a': 1 },
      changed: ['a/workspace.json'],
    });
    expect(read('a/workspace.json')).toBe(
      pretty(single('a', { alwaysShow: true, owner: advanced })),
    );

    for (const workspaceId of ['a', 'b', 'missing']) {
      const refused = await observeRefusal(() =>
        refreshOrganizationOwner({
          workspaceId,
          source: 'org_project_reclaim',
          owner: { ...OWNER, instanceId: OTHER_INSTANCE, bindingGeneration: 9 },
        }),
      );
      expect(refused.result).toBeInstanceOf(
        WorkspaceOwnershipRecordRefusedError,
      );
      expect(refused.result).toMatchObject({
        reason: 'binding-mismatch',
        message: 'Existing workspace has a different organization binding',
      });
      expect(withoutResult(refused)).toEqual(
        nothingBut(['decision:ownership.organization.refresh']),
      );
    }
  });

  it('enrolls a Personal workspace once; an existing id, a refusal or an organization workspace commits nothing', async () => {
    seedIndex([{ id: 'a' }, { id: 'b' }]);
    seedManifest('a');
    seedManifest('b', { owner: OWNER });
    const enroll = (
      workspaceId: string,
      allowed = true,
    ): Promise<string | undefined> =>
      recordPersonalCatalogId({
        workspaceId,
        source: 'personal_catalog_sync',
        allowed: () => Promise.resolve(allowed),
      });

    const declined = await observe(() => enroll('a', false));
    expect(declined.result).toBeUndefined();
    expect(withoutResult(declined)).toEqual(
      nothingBut(['decision:ownership.personal-catalog-id']),
    );

    const allocated = await observe(() => enroll('a'));
    expect(typeof allocated.result).toBe('string');
    // Enrollment does not notify the Portal, as before.
    expect(withoutResult(allocated)).toEqual({
      events: ['decision:ownership.personal-catalog-id', manifestCommit('a')],
      advanced: { 'workspace:a': 1 },
      changed: ['a/workspace.json'],
    });
    expect(read('a/workspace.json')).toBe(
      pretty({
        version: 1,
        personalCatalogId: allocated.result,
        type: 'single-repo',
        repoPath: '/repos/a',
        repos: [],
        alwaysShow: true,
      }),
    );

    const again = await observe(() => enroll('a'));
    expect(again.result).toBe(allocated.result);
    expect(withoutResult(again)).toEqual(
      nothingBut(['decision:ownership.personal-catalog-id']),
    );
    const organization = await observe(() => enroll('b'));
    expect(organization.result).toBeUndefined();
    expect(withoutResult(organization)).toEqual(
      nothingBut(['decision:ownership.personal-catalog-id']),
    );
  });

  it('binds organization hooks once under the persisted owner; a bound, flagged-off or unknown repository commits nothing', async () => {
    seedIndex([{ id: 'b' }]);
    seedManifest('b', { owner: OWNER });
    const sourceHooks = {
      'worktree:created': [{ type: 'chat' as const, prompt: 'Review' }],
    };
    const bind = (
      repoId?: string,
    ): ReturnType<typeof recordOrganizationHookBindings> =>
      recordOrganizationHookBindings({
        workspaceId: 'b',
        ...(repoId === undefined ? {} : { repoId }),
        source: 'hook_resolution',
        sourceHooks,
        localHooks: undefined,
        owner: OWNER,
      });

    mockOrgProjectsEnabled = false;
    const flaggedOff = await observe(() => bind());
    expect(flaggedOff.result).toEqual({ hooks: undefined, owner: OWNER });
    expect(withoutResult(flaggedOff)).toEqual(
      nothingBut(['decision:ownership.hook-bindings']),
    );
    mockOrgProjectsEnabled = true;

    const unknownRepository = await observe(() => bind('gone'));
    expect(unknownRepository.result).toEqual({
      hooks: undefined,
      owner: OWNER,
    });
    expect(withoutResult(unknownRepository)).toEqual(
      nothingBut(['decision:ownership.hook-bindings']),
    );

    const bound = await observe(() => bind());
    const hooks = {
      'worktree:created': [
        {
          type: 'chat',
          prompt: 'Review',
          executionContext: `org:${OWNER.organizationId}`,
          localExecutionContextOverlay: true,
        },
      ],
    };
    expect(bound.result).toEqual({ hooks, owner: OWNER });
    // No Portal notification, as before.
    expect(withoutResult(bound)).toEqual({
      events: ['decision:ownership.hook-bindings', manifestCommit('b')],
      advanced: { 'workspace:b': 1 },
      changed: ['b/workspace.json'],
    });
    expect(read('b/workspace.json')).toBe(
      pretty(single('b', { hooks, alwaysShow: true, owner: OWNER })),
    );

    const again = await observe(() => bind());
    expect(again.result).toEqual({ hooks, owner: OWNER });
    expect(withoutResult(again)).toEqual(
      nothingBut(['decision:ownership.hook-bindings']),
    );
  });

  it('rebinds hook contexts in one commit only when one moved; a missing manifest stays missing and an unreadable one is refused', async () => {
    seedIndex([{ id: 'a' }, { id: 'b' }]);
    const hook = (executionContext: string): Record<string, unknown> => ({
      'worktree:created': [
        { type: 'chat', prompt: 'Review', executionContext },
      ],
    });
    seedManifest('b', {
      hooks: hook('personal'),
      repos: [
        {
          id: 'r',
          name: 'R',
          repoPath: '/repos/r',
          hooks: hook('personal'),
        },
      ],
    });
    seed(join('a', 'workspace.json'), UNREADABLE);
    const rebind = (workspaceId: string): Promise<string[]> =>
      rebindWorkspaceHookExecutionContexts({
        workspaceId,
        source: 'background_execution_rebinding',
        previousContext: 'personal',
        nextContext: `org:${OWNER.organizationId}`,
      });

    const rebound = await observe(() => rebind('b'));
    expect(rebound.result).toEqual([
      'workspace-root:worktree:created:0',
      'workspace-repo:r:worktree:created:0',
    ]);
    expect(withoutResult(rebound)).toEqual({
      events: ['decision:ownership.hook-contexts.rebind', manifestCommit('b')],
      advanced: { 'workspace:b': 1 },
      changed: ['b/workspace.json'],
    });
    const moved = hook(`org:${OWNER.organizationId}`);
    expect(read('b/workspace.json')).toBe(
      pretty({
        version: 1,
        type: 'single-repo',
        repoPath: '/repos/b',
        repos: [{ id: 'r', name: 'R', repoPath: '/repos/r', hooks: moved }],
        hooks: moved,
        alwaysShow: true,
      }),
    );

    for (const workspaceId of ['b', 'missing']) {
      const none = await observe(() => rebind(workspaceId));
      expect(none.result).toEqual([]);
      expect(withoutResult(none)).toEqual(
        nothingBut(['decision:ownership.hook-contexts.rebind']),
      );
    }
    expect(existsSync(join(root, 'missing'))).toBe(false);

    const unreadable = await observeRefusal(() => rebind('a'));
    expect(unreadable.result).toBeInstanceOf(WorkspaceConfigUnreadableError);
    expect(withoutResult(unreadable)).toEqual(
      nothingBut([
        'decision:ownership.hook-contexts.rebind',
        'diagnostic:workspace_config_write_refused',
      ]),
    );
  });

  it('releases an adoption in one targeted index commit with no manifest write, keeping its files; every other case commits nothing', async () => {
    seedIndex([{ id: 'a' }, { id: 'b' }, { id: 'cowork' }, { id: 'legacy' }]);
    seedManifest('a', { owner: OWNER });
    seedManifest('b', { owner: { ...OWNER, instanceId: OTHER_INSTANCE } });
    seedManifest('cowork', { owner: { type: 'organization' } });
    const release = (workspaceId: string): Promise<boolean> =>
      releaseAdoptedWorkspace({
        workspaceId,
        source: 'org_project_adoption_rollback',
        instanceId: OWNER.instanceId,
      });
    registerWorkspaceTypes(new Map());

    // Bound elsewhere, or to an owner that cannot be read: kept, not undone,
    // and the type registry is not refreshed.
    for (const workspaceId of ['b', 'cowork']) {
      const kept = await observe(() => release(workspaceId));
      expect(kept.result).toBe(false);
      expect(withoutResult(kept)).toEqual(
        nothingBut(['decision:ownership.adoption.release']),
      );
    }
    expect(listRegisteredWorkspaceIds()).toEqual([]);
    // Indexed without a manifest: kept, and undone, as before.
    const absent = await observe(() => release('legacy'));
    expect(absent.result).toBe(true);
    expect(withoutResult(absent)).toEqual(
      nothingBut(['decision:ownership.adoption.release']),
    );
    expect(listRegisteredWorkspaceIds()).toEqual([
      'a',
      'b',
      'cowork',
      'legacy',
    ]);

    const manifest = read('a/workspace.json');
    const released = await observe(() => release('a'));
    expect(released.result).toBe(true);
    // The index entry's removal advances its workspace; other entries keep
    // their order and nothing else is written.
    expect(withoutResult(released)).toEqual({
      events: [
        'decision:ownership.adoption.release',
        indexCommit(['workspaces', 'workspace:a']),
        'sync',
      ],
      advanced: { workspaces: 1, 'workspace:a': 1 },
      changed: ['index.json'],
    });
    expect(read('index.json')).toBe(
      pretty({
        version: 1,
        workspaces: [
          indexEntry('b', 1),
          indexEntry('cowork', 2),
          indexEntry('legacy', 3),
        ],
      }),
    );
    expect(read('a/workspace.json')).toBe(manifest);
    // The type registry follows the index.
    expect(listRegisteredWorkspaceIds()).toEqual(['b', 'cowork', 'legacy']);

    // Not indexed, or unreadable: undone without entering the port.
    seed(join('b', 'workspace.json'), UNREADABLE);
    for (const workspaceId of ['a', 'b']) {
      const undone = await observe(() => release(workspaceId));
      expect(undone.result).toBe(true);
      expect(withoutResult(undone)).toEqual(nothingBut([]));
    }
  });
});

describe('organization private memory record', () => {
  it('records the policy and its marker in one commit; the same policy, another project or an unreadable manifest commits nothing', async () => {
    seedIndex([{ id: 'a' }, { id: 'b' }]);
    seedManifest('a', { owner: OWNER });
    seed(join('b', 'workspace.json'), UNREADABLE);
    const record = (
      workspaceId: string,
      projectId = OWNER.projectId,
    ): Promise<boolean> =>
      recordOrganizationPrivateMemory({
        workspaceId,
        organizationId: OWNER.organizationId,
        projectId,
        privateMemory: true,
      });

    const recorded = await observe(() => record('a'));
    expect(recorded.result).toBe(true);
    expect(withoutResult(recorded)).toEqual({
      events: ['decision:ownership.private-memory', manifestCommit('a')],
      advanced: { 'workspace:a': 1 },
      changed: ['a/workspace.json'],
    });
    expect(read('a/workspace.json')).toBe(
      pretty({
        privateMemory: true,
        privateMemoryManagedBy: 'organization',
        ...single('a', { alwaysShow: true, owner: OWNER }),
      }),
    );

    const same = await observe(() => record('a'));
    expect(same.result).toBe(false);
    expect(withoutResult(same)).toEqual(
      nothingBut(['decision:ownership.private-memory']),
    );

    for (const [workspaceId, projectId, events] of [
      ['a', 'another-project', ['decision:ownership.private-memory']],
      ['missing', OWNER.projectId, ['decision:ownership.private-memory']],
      [
        'b',
        OWNER.projectId,
        [
          'decision:ownership.private-memory',
          'diagnostic:workspace_config_write_refused',
        ],
      ],
    ] as const) {
      const refused = await observeRefusal(() =>
        record(workspaceId, projectId),
      );
      expect(refused.result).toBeInstanceOf(WorkspacePrivateMemoryRefusedError);
      expect(refused.result).toMatchObject({
        reason: 'configuration-unavailable',
        message: 'Organization project config is unavailable for memory policy',
      });
      expect(withoutResult(refused)).toEqual(nothingBut([...events]));
    }
    expect(existsSync(join(root, 'missing'))).toBe(false);
  });
});

describe('index seed', () => {
  it('publishes an absent index outside the commit log, then never again', async () => {
    const primaryDataDir = join(dir, 'data');
    const seeded = await observe(() =>
      seedWorkspaceIndex({
        source: 'preferences_create_primary_data_dir',
        primaryDataDir,
      }),
    );
    expect(seeded.result).toEqual({ seeded: true });
    // Zero commits: an exclusive create, with no revision and no backup.
    expect(withoutResult(seeded)).toEqual({
      events: ['decision:index.seed'],
      advanced: {},
      changed: ['index.json'],
    });
    expect(read('index.json')).toBe(pretty({ version: 1, workspaces: [] }));
    expect(existsSync(join(root, 'index.json.bak'))).toBe(false);

    const again = await observe(() =>
      seedWorkspaceIndex({
        source: 'preferences_create_primary_data_dir',
        primaryDataDir,
      }),
    );
    expect(again.result).toEqual({ seeded: false });
    expect(withoutResult(again)).toEqual(nothingBut(['decision:index.seed']));
  });
});

describe('designated Cowork records', () => {
  const COWORK_SETTINGS = {
    createdAt: '2025-01-01T00:00:00.000Z',
    archiveRetentionDays: 7,
  };

  it('migrates into the first free id: the index, then the manifest; a retry commits nothing', async () => {
    seedIndex([{ id: 'a' }, { id: 'legacy', type: 'multi-repo' }]);
    const migrate = (): Promise<string> =>
      recordMigratedCoworkWorkspace({
        source: 'legacy_cowork_migration',
        legacyId: 'legacy',
        candidateId: 'legacy',
        name: 'Legacy',
        cowork: { description: 'migrated' },
      });

    const migrated = await observe(migrate);
    expect(migrated.result).toBe('legacy-2');
    expect(withoutResult(migrated)).toEqual({
      events: [
        'decision:cowork.migration',
        indexCommit(['workspaces', 'workspace:legacy-2']),
        'sync',
        'decision:cowork.migration.manifest',
        manifestCommit('legacy-2'),
        'sync',
        'notify',
      ],
      advanced: { workspaces: 1, 'workspace:legacy-2': 2 },
      changed: ['index.json', 'legacy-2/workspace.json'],
    });
    expect(read('index.json')).toBe(
      pretty({
        version: 1,
        workspaces: [
          indexEntry('a', 0),
          indexEntry('legacy', 1, { type: 'multi-repo' }),
          {
            id: 'legacy-2',
            name: 'Legacy',
            type: 'cowork',
            color: '#22C55E',
            collapsed: false,
            order: 2,
          },
        ],
      }),
    );
    expect(read('legacy-2/workspace.json')).toBe(
      pretty({
        version: 1,
        type: 'cowork',
        repos: [],
        cowork: { description: 'migrated' },
        alwaysShow: true,
      }),
    );
    expect(read('legacy-2/worktrees.json')).toBeUndefined();

    const again = await observe(migrate);
    expect(again.result).toBe('legacy-2');
    expect(withoutResult(again)).toEqual(
      nothingBut(['decision:cowork.migration']),
    );
  });

  it('provisions the default: the index with its scaffold, then the deferred manifest; an unchanged retry commits nothing and a binding commits the manifest alone', async () => {
    seedIndex([{ id: 'a' }]);
    const provision = (
      owner?: WorkspaceOwnerBinding,
    ): ReturnType<typeof provisionCoworkWorkspaceRecord> =>
      provisionCoworkWorkspaceRecord({
        source: 'default_cowork_provision',
        workspaceId: 'cowork',
        ...(owner ? { owner } : {}),
      });

    const created = await observe(() => provision());
    const item = {
      id: 'cowork',
      name: DEFAULT_COWORK_WORKSPACE_NAME,
      type: 'cowork',
      color: '#0EA5E9',
      collapsed: false,
      order: 1,
      cowork: COWORK_SETTINGS,
    };
    // The deferred manifest stays on the returned outcome, as before.
    expect(created.result).toEqual({
      item,
      deferredManifest: item,
      notify: true,
    });
    expect(withoutResult(created)).toEqual({
      events: [
        'decision:cowork.provision',
        indexCommit(['workspaces', 'workspace:cowork']),
        'sync',
        'decision:cowork.provision.manifest',
        manifestCommit('cowork'),
        'sync',
        'notify',
      ],
      advanced: { workspaces: 1, 'workspace:cowork': 2 },
      changed: ['index.json', 'cowork/workspace.json'],
    });
    expect(read('index.json')).toBe(
      pretty({
        version: 1,
        workspaces: [
          indexEntry('a', 0),
          {
            id: 'cowork',
            name: DEFAULT_COWORK_WORKSPACE_NAME,
            type: 'cowork',
            color: '#0EA5E9',
            collapsed: false,
            order: 1,
          },
        ],
      }),
    );
    const createdManifest = {
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: COWORK_SETTINGS,
      alwaysShow: true,
    };
    expect(read('cowork/workspace.json')).toBe(pretty(createdManifest));
    expect(existsSync(join(root, 'cowork', 'home', 'CLAUDE.md'))).toBe(true);

    const unchanged = await observe(() => provision());
    expect(unchanged.result).toMatchObject({ notify: false });
    expect(withoutResult(unchanged)).toEqual(
      nothingBut(['decision:cowork.provision']),
    );

    const bound = await observe(() => provision(OWNER));
    expect(bound.result).toMatchObject({
      item: { id: 'cowork', owner: OWNER },
      notify: true,
    });
    expect(withoutResult(bound)).toEqual({
      events: [
        'decision:cowork.provision',
        manifestCommit('cowork'),
        'sync',
        'notify',
      ],
      advanced: { 'workspace:cowork': 1 },
      changed: ['cowork/workspace.json'],
    });
    expect(read('cowork/workspace.json')).toBe(
      pretty({ ...createdManifest, owner: OWNER }),
    );

    const rebound = await observe(() => provision(OWNER));
    expect(rebound.result).toMatchObject({ notify: false });
    expect(withoutResult(rebound)).toEqual(
      nothingBut(['decision:cowork.provision']),
    );
  });

  it('provisions a bound default on an absent manifest: the manifest inside the index update, then the index', async () => {
    seedIndex([{ id: 'a' }]);
    const created = await observe(() =>
      provisionCoworkWorkspaceRecord({
        source: 'default_cowork_provision',
        workspaceId: 'cowork',
        owner: OWNER,
      }),
    );
    const item = {
      id: 'cowork',
      name: DEFAULT_COWORK_WORKSPACE_NAME,
      type: 'cowork',
      color: '#0EA5E9',
      collapsed: false,
      order: 1,
      cowork: COWORK_SETTINGS,
      owner: OWNER,
    };
    // No deferred manifest: the bound manifest is written before publication.
    expect(created.result).toEqual({ item, notify: true });
    expect(withoutResult(created)).toEqual({
      events: [
        'decision:cowork.provision',
        manifestCommit('cowork'),
        indexCommit(['workspaces', 'workspace:cowork']),
        'sync',
        'sync',
        'notify',
      ],
      advanced: { workspaces: 1, 'workspace:cowork': 2 },
      changed: ['index.json', 'cowork/workspace.json'],
    });
    expect(read('cowork/workspace.json')).toBe(
      pretty({
        version: 1,
        type: 'cowork',
        repos: [],
        cowork: COWORK_SETTINGS,
        alwaysShow: true,
        owner: OWNER,
      }),
    );
    expect(existsSync(join(root, 'cowork', 'home', 'CLAUDE.md'))).toBe(true);
  });

  it('provisions an unpublished default without an index commit; unbound, it writes only the scaffold', async () => {
    seedIndex([{ id: 'a' }]);
    const index = read('index.json');
    const unbound = await observe(() =>
      provisionCoworkWorkspaceRecord({
        source: 'default_cowork_provision',
        workspaceId: 'cowork',
        publishToIndex: false,
      }),
    );
    expect(unbound.result).toMatchObject({ notify: false });
    expect(unbound.result).not.toHaveProperty('deferredManifest');
    expect(withoutResult(unbound)).toEqual(
      nothingBut(['decision:cowork.provision']),
    );
    expect(read('cowork/workspace.json')).toBeUndefined();
    expect(existsSync(join(root, 'cowork', 'home', 'CLAUDE.md'))).toBe(true);

    const bound = await observe(() =>
      provisionCoworkWorkspaceRecord({
        source: 'default_cowork_provision',
        workspaceId: 'legacy',
        owner: OWNER,
        publishToIndex: false,
      }),
    );
    expect(bound.result).toMatchObject({ notify: false });
    expect(withoutResult(bound)).toEqual({
      events: ['decision:cowork.provision', manifestCommit('legacy')],
      advanced: { 'workspace:legacy': 1 },
      changed: ['legacy/workspace.json'],
    });
    expect(read('index.json')).toBe(index);
  });

  it('refuses a migration whose free id has an unreadable manifest, committing nothing', async () => {
    seedIndex([{ id: 'legacy', type: 'multi-repo' }]);
    seed(join('legacy-2', 'workspace.json'), UNREADABLE);
    const refused = await observeRefusal(() =>
      recordMigratedCoworkWorkspace({
        source: 'legacy_cowork_migration',
        legacyId: 'legacy',
        candidateId: 'legacy',
        name: 'Legacy',
      }),
    );
    expect(refused.result).toMatchObject({
      name: 'CoworkWorkspaceRecordRefusedError',
      reason: 'configuration-unavailable',
    });
    expect(withoutResult(refused)).toEqual(
      nothingBut(['decision:cowork.migration']),
    );
    expect(read('legacy-2/workspace.json')).toBe(UNREADABLE);
  });

  it('refuses a default over another project type or an unreadable index unchanged', async () => {
    seedIndex([{ id: 'cowork' }]);
    const provision = (): ReturnType<typeof provisionCoworkWorkspaceRecord> =>
      provisionCoworkWorkspaceRecord({
        source: 'default_cowork_provision',
        workspaceId: 'cowork',
      });
    const otherType = await observeRefusal(provision);
    expect(otherType.result).toMatchObject({
      reason: 'configuration-unavailable',
      message: `The ${DEFAULT_COWORK_WORKSPACE_NAME} project configuration is unavailable`,
    });
    expect(withoutResult(otherType)).toEqual(
      nothingBut(['decision:cowork.provision']),
    );

    seed('index.json', UNREADABLE);
    const unreadable = await observeRefusal(provision);
    expect(unreadable.result).toMatchObject({ reason: 'index-unavailable' });
    expect(withoutResult(unreadable)).toEqual(
      nothingBut(['decision:cowork.provision']),
    );
  });

  it('renames the default only while it has a default name, in one index commit; otherwise commits nothing', async () => {
    seedIndex([{ id: 'a' }, { id: 'cowork', type: 'cowork', name: 'Chats' }]);
    const rename = (): ReturnType<typeof renameDefaultCoworkWorkspaceRecord> =>
      renameDefaultCoworkWorkspaceRecord({
        source: 'default_cowork_name_migration',
        workspaceId: 'cowork',
        name: 'Renamed',
        onlyWhenNamed: ['Chats'],
      });

    const renamed = await observe(rename);
    expect(renamed.result).toEqual({ authority: 'ok', renamed: true });
    // A rename advances only its workspace, not the collection.
    expect(withoutResult(renamed)).toEqual({
      events: [
        'decision:cowork.default-name',
        indexCommit(['workspace:cowork']),
        'sync',
        'notify',
      ],
      advanced: { 'workspace:cowork': 1 },
      changed: ['index.json'],
    });
    expect(read('index.json')).toBe(
      pretty({
        version: 1,
        workspaces: [
          indexEntry('a', 0),
          indexEntry('cowork', 1, { type: 'cowork', name: 'Renamed' }),
        ],
      }),
    );

    const again = await observe(rename);
    expect(again.result).toEqual({ authority: 'ok', renamed: false });
    expect(withoutResult(again)).toEqual(
      nothingBut(['decision:cowork.default-name']),
    );

    seed('index.json', UNREADABLE);
    const degraded = await observe(rename);
    expect(degraded.result).toEqual({
      authority: 'unreadable',
      renamed: false,
    });
    expect(withoutResult(degraded)).toEqual(
      nothingBut(['decision:cowork.default-name']),
    );
  });
});

describe('sidebar seen record', () => {
  it('applies a seen delta to its incarnation in one list commit; an applied delta or another incarnation commits nothing', async () => {
    seedIndex([{ id: 'a' }]);
    seedManifest('a');
    const row: WorktreeData = {
      id: 'w',
      branchName: 'main',
      createdAt: CREATED_AT,
      seenPipelineExecutionIds: ['x', 'kept'],
    };
    seed(join('a', 'worktrees.json'), { version: 1, worktrees: [row] });
    const markSeen = (createdAt: string): Promise<void> =>
      recordSidebarPipelineResultsSeen({
        source: 'projects_save',
        workspaceId: 'a',
        worktreeId: 'w',
        createdAt,
        change: { source: 'sidebar_save', seen: ['y'], unseen: ['x'] },
      });

    const seen = await observe(() => markSeen(CREATED_AT));
    expect(withoutResult(seen)).toEqual({
      events: [
        'decision:pipelineResults.markSeen',
        {
          commit: LIST_WRITE,
          advance: ['worktree:a/w'],
          files: ['a/worktrees.json'],
        },
        'groups',
        'sync',
        'notify',
        'seen:y',
      ],
      advanced: { 'worktree:a/w': 1 },
      changed: ['a/worktrees.json'],
    });
    const list: unknown = JSON.parse(read('a/worktrees.json') ?? 'null');
    expect(list).toMatchObject({
      version: 1,
      worktrees: [
        {
          id: 'w',
          branchName: 'main',
          createdAt: CREATED_AT,
          seenPipelineExecutionIds: ['kept', 'y'],
        },
      ],
    });

    for (const createdAt of [CREATED_AT, '2026-10-02T00:00:00.000Z']) {
      const none = await observe(() => markSeen(createdAt));
      // The unchanged list still publishes its groups, as before.
      expect(withoutResult(none)).toEqual(
        nothingBut(['decision:pipelineResults.markSeen', 'groups']),
      );
    }
  });
});

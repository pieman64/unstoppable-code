/*
 * CAN-5201 (W4b acceptance): every saved W5 outcome shape replays through the
 * core keyed runners and today's desktop entry points. The saved outcomes are
 * hand-written in fixtures/w5-historical-outcomes.json, never produced by the
 * decoders under test; the matrix that maps each shape to its operation,
 * caller, provenance and decoder is
 * docs/planning/2026-07-31-desktop-core-daemon/artifacts/w5-historical-outcome-replay.md.
 *
 * Each receipt is planted the way an earlier build committed it: the entry
 * point's own receipt (caller, operation, key, parameter fingerprint) is
 * captured at its receipt lookup, before any admission or effect, and the
 * saved outcome is committed under it through the real commit-log worker.
 */
jest.mock('../../shared-containers/canopy-server-client', () => ({
  fetchLatestSharedContainerRevision: jest.fn(() =>
    Promise.resolve({
      id: 'container',
      access: 'direct',
      owner: { id: 'publisher', name: 'Ada' },
    }),
  ),
}));
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../agents/session-manager', () => ({
  getActiveChatIds: jest.fn(() => []),
  subscribeGlobalPluginDefaultsRevision: jest.fn(() => jest.fn()),
  subscribeChatSessionActivity: jest.fn(() => jest.fn()),
  subscribeLiveBackgroundTasks: jest.fn(() => jest.fn()),
}));
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
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
  recordWorktreeCrudTelemetry: jest.fn(),
}));
jest.mock('../../ledger/lifecycle', () => ({
  LEDGER_INTENT_REFUSING_WAIT_MS: 5000,
  recordLedgerMoveIntent: jest.fn(() => Promise.resolve('recorded')),
  discardLedgerMoveIntent: jest.fn(),
  notifyLedgerContainerMoved: jest.fn(),
  notifyLedgerContainerPurged: jest.fn(),
  notifyLedgerContainerArchived: jest.fn(),
  captureLedgerWorkspaceIncarnations: jest.fn(() => Promise.resolve(null)),
  notifyLedgerWorkspaceDeleted: jest.fn(),
  notifyLedgerContainerRestored: jest.fn(),
  recordLedgerRestoreIntent: jest.fn(() => Promise.resolve('recorded')),
}));
jest.mock('../../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    deleteWorkspaceDocs: jest.fn(() => Promise.resolve()),
    deleteWorktreeDocs: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../post-archive-sync', () => ({
  queueTrackedGitHubWorktreeSync: jest.fn(),
}));

import {
  projectW5ReorderOutcome,
  projectW5WorkspaceCreationOutcome,
  projectW5WorktreeBranchRenameOutcome,
  projectW5WorktreeCreationOutcome,
  projectW5WorktreeUpdateOutcome,
  W5OutcomeDecodeError,
} from '@canopy/core-runtime/node/w5/stored-outcome-projection';
import { W5CommitLog } from '@canopy/desktop-shared/node/w5-commit-log';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from './fixtures/w5-boundary-host';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import * as keyedOperation from '../w5-keyed-operation';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { getW5DestructiveLifecycleDir } from '../paths';
import {
  findCompletedDestructiveArchive,
  readDestructiveRecovery,
} from '../w5-destructive-recovery';
import { acceptSharedContainer } from '../../shared-containers/acceptance-store';
import { createWorkspace } from '../workspace-creation';
import { createWorktreeFromSelection } from '../worktree-creation';
import { deleteWorkspace } from '../workspace-deletion';
import { archiveWorktree, deleteWorktree } from '../worktree-archive';
import {
  reorderWorkspaces,
  updateWorkspaceMetadata,
} from '../workspace-metadata';
import { moveWorktree, updateWorktree } from '../worktree-update';
import { renameWorktreeBranch } from '../worktree-branch-rename';
import { inProcessBranchRenameGit } from '../../__tests__/helpers/in-process-branch-rename-git';
import { convertWorkspaceType } from '../workspace-type-conversion';
import {
  addWorkspaceRepository,
  removeWorkspaceRepository,
} from '../workspace-repositories';
import { initializeWorkspaceSourceRepo } from '../workspace-source-control';
import { applySourceChanges } from '../workspace-source-changes';
import {
  combineWorktreeWithWorkspace,
  promoteTemporaryWorkspace,
} from '../adhoc-multi-repo-workspaces';
import { combineWorktreeWithExistingWorktree } from '../adhoc-existing-worktree-join';
import { splitTemporaryWorkspaceWorktree } from '../split-temporary-workspace';
import { restoreArchivedContainer } from '../archived-container-restore';
import { forkSharedContainer } from '../../shared-containers/fork';
import {
  setWorktreeHooksPaused,
  updateWorkspaceHooks,
  updateWorkspacePlanDetection,
  updateWorkspaceScripts,
} from '../workspace-script-hook-settings';
import { updateWorkspaceRetention } from '../workspace-retention';
import { updateWorkspacePrivateMemory } from '../workspace-private-memory';
import { updateWorkspacePlugins } from '../workspace-plugin-defaults';
import { updateCoworkWorkspaceSettings } from '../cowork-workspace-crud';
import { setBeforeProjectPluginDefaultsChangeHandler } from '../workspace-persistence';

jest.setTimeout(120_000);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type Expectation =
  | { kind: 'replay'; value: unknown }
  | { kind: 'void' }
  | { kind: 'refused'; name: string; message?: string };

/** What the W5a3 stored-outcome projector returns for a saved outcome. */
type Projection = { kind: 'value'; value: unknown } | { kind: 'refused' };

interface HistoricalCase {
  id: string;
  saved: unknown;
  expect: Expectation;
  projected?: Projection;
}

const PROJECTOR_NAMES = [
  'workspace-creation',
  'worktree-creation',
  'worktree-update',
  'worktree-branch-rename',
  'workspace-reorder',
  'worktree-reorder',
] as const;
type ProjectorName = (typeof PROJECTOR_NAMES)[number];

/** `workspaceId` is the keyed request's workspace, for worktree results. */
const projectors: Record<
  ProjectorName,
  (stored: unknown, workspaceId: string) => unknown
> = {
  'workspace-creation': (stored) => projectW5WorkspaceCreationOutcome(stored),
  'worktree-creation': (stored, workspaceId) =>
    projectW5WorktreeCreationOutcome(stored, { workspaceId }),
  'worktree-update': (stored, workspaceId) =>
    projectW5WorktreeUpdateOutcome(stored, { workspaceId }),
  'worktree-branch-rename': (stored, workspaceId) =>
    projectW5WorktreeBranchRenameOutcome(stored, { workspaceId }),
  'workspace-reorder': (stored) =>
    projectW5ReorderOutcome('core.workspace.reorder', stored),
  'worktree-reorder': (stored) =>
    projectW5ReorderOutcome('core.worktree.reorder', stored),
};

function isProjectorName(value: unknown): value is ProjectorName {
  return PROJECTOR_NAMES.some((name) => name === value);
}

interface HistoricalEntry {
  key: string;
  operation: string;
  caller: string;
  /** The W5a3 projector for this operation, with the request's workspace. */
  projector?: { name: ProjectorName; workspaceId: string };
  cases: HistoricalCase[];
}

interface HistoricalJournal {
  id: string;
  worktreeId: string;
  saved: unknown;
  expect:
    | Expectation
    | { kind: 'recovery-required' }
    /** An unfinished journal: not an outcome, so it must never replay. */
    | { kind: 'never-replayed' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`Fixture field ${field} must be a non-empty string`);
  return value;
}

/** Exactly one expected result per case, so no case is ambiguous. */
function readExpectation(
  input: Record<string, unknown>,
  id: string,
): HistoricalJournal['expect'] {
  const present = ['replay', 'replayVoid', 'refused', 'neverReplayed'].filter(
    (key) => key in input,
  );
  if (present.length !== 1)
    throw new Error(`Fixture case ${id} must name one expected result`);
  if ('replay' in input)
    return { kind: 'replay', value: input.replay } satisfies Expectation;
  if ('replayVoid' in input) {
    if (input.replayVoid !== true)
      throw new Error(`Fixture case ${id}: replayVoid must be true`);
    return { kind: 'void' } satisfies Expectation;
  }
  if ('neverReplayed' in input) {
    if (input.neverReplayed !== true)
      throw new Error(`Fixture case ${id}: neverReplayed must be true`);
    return { kind: 'never-replayed' } as const;
  }
  const refused = input.refused;
  if (!isRecord(refused)) throw new Error(`Fixture case ${id}: bad refusal`);
  if ('reason' in refused) {
    if (refused.reason !== 'recovery-required')
      throw new Error(`Fixture case ${id}: unknown refusal reason`);
    return { kind: 'recovery-required' } as const;
  }
  return {
    kind: 'refused',
    name: readText(refused.name, `${id}.refused.name`),
    ...(refused.message === undefined
      ? {}
      : { message: readText(refused.message, `${id}.refused.message`) }),
  } satisfies Expectation;
}

/** A projector-covered case names exactly one projection; others name none. */
function readProjection(
  input: Record<string, unknown>,
  id: string,
  covered: boolean,
): Projection | undefined {
  const present = ['projected', 'projectedRefused'].filter(
    (key) => key in input,
  );
  if (!covered) {
    if (present.length > 0)
      throw new Error(`Fixture case ${id}: no projector covers it`);
    return undefined;
  }
  if (present.length !== 1)
    throw new Error(`Fixture case ${id} must name one projection`);
  if ('projected' in input) return { kind: 'value', value: input.projected };
  if (input.projectedRefused !== true)
    throw new Error(`Fixture case ${id}: projectedRefused must be true`);
  return { kind: 'refused' };
}

function readProjector(
  value: Record<string, unknown>,
  key: string,
): HistoricalEntry['projector'] {
  if (!('projector' in value)) return undefined;
  if (!isProjectorName(value.projector))
    throw new Error(`Fixture entry ${key}: unknown projector`);
  return {
    name: value.projector,
    workspaceId:
      value.projectorWorkspaceId === undefined
        ? ''
        : readText(value.projectorWorkspaceId, `${key}.projectorWorkspaceId`),
  };
}

function readFixture(): {
  entries: HistoricalEntry[];
  journals: HistoricalJournal[];
} {
  const raw: unknown = JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures/w5-historical-outcomes.json'),
      'utf8',
    ),
  );
  if (!isRecord(raw) || !isRecord(raw.entries))
    throw new Error('Fixture must hold entries');
  const ids = new Set<string>();
  const entries = Object.entries(raw.entries).map(([key, value]) => {
    if (!isRecord(value) || !Array.isArray(value.cases))
      throw new Error(`Fixture entry ${key} must hold cases`);
    const projector = readProjector(value, key);
    return {
      key,
      operation: readText(value.operation, `${key}.operation`),
      caller: readText(value.caller, `${key}.caller`),
      ...(projector ? { projector } : {}),
      cases: value.cases.map((item: unknown): HistoricalCase => {
        if (!isRecord(item) || !('saved' in item))
          throw new Error(`Fixture entry ${key} has a case without saved`);
        const id = readText(item.id, `${key}.id`);
        readText(item.shape, `${id}.shape`);
        if (ids.has(id)) throw new Error(`Duplicate fixture case ${id}`);
        ids.add(id);
        const expectation = readExpectation(item, id);
        if (
          expectation.kind === 'recovery-required' ||
          expectation.kind === 'never-replayed'
        )
          throw new Error(`Fixture case ${id}: not a receipt expectation`);
        const projected = readProjection(item, id, projector !== undefined);
        return {
          id,
          saved: item.saved,
          expect: expectation,
          ...(projected ? { projected } : {}),
        };
      }),
    };
  });
  if (!Array.isArray(raw.destructiveJournals))
    throw new Error('Fixture must hold destructiveJournals');
  const journals = raw.destructiveJournals.map(
    (item: unknown): HistoricalJournal => {
      if (!isRecord(item) || !('saved' in item))
        throw new Error('Fixture journal without saved');
      const id = readText(item.id, 'journal.id');
      readText(item.shape, `${id}.shape`);
      return {
        id,
        worktreeId: readText(item.worktreeId, `${id}.worktreeId`),
        saved: item.saved,
        expect: readExpectation(item, id),
      };
    },
  );
  return { entries, journals };
}

const fixture = readFixture();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let dir: string;
let root: string;
let repo: string;
let dbPath: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
}

async function setUp(): Promise<void> {
  ({ dir, root, repo } = createW5BoundaryFixture(
    (createdAt) => [
      { id: 'one', branchName: 'old', createdAt },
      { id: 'two', branchName: 'second', createdAt },
    ],
    ['b', 'm'],
  ));
  // A multi-repo project with no owner: shared-project readiness admits it.
  writeFileSync(
    join(root, 'm', 'workspace.json'),
    JSON.stringify({ version: 1, type: 'multi-repo', repos: [] }),
  );
  dbPath = join(dir, 'w5', 'commit-log.sqlite');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  startHost();
  // The fork boundary resolves the accepted share before its receipt lookup.
  await acceptSharedContainer('container', undefined, undefined, 'direct');
}

async function tearDown(): Promise<void> {
  await settleDetachedWork();
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await shutdownW5BoundaryHost(host, dbPath);
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Every file the fixture owns: the data directory with all canonical W5
 * files, the source repository's checkout, and the import and fork
 * destinations. The commit log is read separately; Git internals are covered
 * by the worktree list.
 */
function snapshot(path = dir): unknown {
  return readdirSync(path, { withFileTypes: true })
    .filter(
      (entry) =>
        ![join(dir, 'w5'), join(repo, '.git')].includes(join(path, entry.name)),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => [
      entry.name,
      entry.isDirectory()
        ? snapshot(join(path, entry.name))
        : readFileSync(join(path, entry.name), 'utf8'),
    ]);
}

function gitWorktrees(): string {
  return execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  });
}

/**
 * Each entry point with an idempotency key, as its production caller sends
 * it. The request is fixed per entry, so a planted receipt's fingerprint
 * matches its replay.
 */
const invocations: Record<string, (key: string) => Promise<unknown>> = {
  'workspace.create': (key) =>
    createWorkspace({
      source: 'new_multi_repo',
      variant: { kind: 'new-multi-repo', name: 'Historical' },
      idempotencyKey: key,
    }),
  'workspace.import': (key) =>
    createWorkspace({
      source: 'import_from_repo',
      variant: { kind: 'repository-manifest', repoPath: join(dir, 'import') },
      idempotencyKey: key,
    }),
  'worktree.create.single-repo': (key) =>
    createWorktreeFromSelection({
      workspaceId: 'a',
      workspaceKind: 'single-repo',
      branch: { kind: 'new', branchName: 'feature' },
      base: { kind: 'repository-default' },
      allowBaseBranchNetwork: false,
      seedPanelLayoutMode: false,
      idempotencyKey: key,
    }),
  'worktree.create.multi-repo': (key) =>
    createWorktreeFromSelection({
      workspaceId: 'm',
      workspaceKind: 'multi-repo',
      branch: { kind: 'new', branchName: 'topic' },
      base: { kind: 'repository-default' },
      allowBaseBranchNetwork: false,
      seedPanelLayoutMode: false,
      idempotencyKey: key,
    }),
  'workspace.delete': (key) =>
    deleteWorkspace({
      workspaceId: 'a',
      source: 'multi_repo_workspace_delete',
      idempotencyKey: key,
    }),
  'worktree.delete': (key) =>
    deleteWorktree({
      workspaceId: 'a',
      worktreeId: 'one',
      source: 'single_repo',
      idempotencyKey: key,
    }),
  'workspace.update': (key) =>
    updateWorkspaceMetadata({
      workspaceId: 'a',
      source: 'desktop_canopy_client',
      patch: { name: 'Renamed' },
      idempotencyKey: key,
    }),
  'workspace.reorder': (key) =>
    reorderWorkspaces({
      visibleWorkspaceIds: ['a', 'b'],
      activeWorkspaceId: 'a',
      overWorkspaceId: 'b',
      idempotencyKey: key,
    }),
  'worktree.update': (key) =>
    updateWorktree({
      workspaceId: 'a',
      worktreeId: 'one',
      patch: { label: 'Renamed' },
      idempotencyKey: key,
    }),
  'worktree.reorder': (key) =>
    moveWorktree({
      workspaceId: 'a',
      activeWorktreeId: 'one',
      overWorktreeId: 'two',
      idempotencyKey: key,
    }),
  'worktree.branch.rename': (key) =>
    renameWorktreeBranch(
      {
        source: 'desktop',
        workspaceId: 'a',
        worktreeId: 'one',
        newBranchName: 'renamed',
        idempotencyKey: key,
      },
      inProcessBranchRenameGit,
    ),
  'workspace.type.convert': (key) =>
    convertWorkspaceType({
      workspaceId: 'a',
      targetType: 'multi-repo',
      claudeMdMode: 'unchanged',
      source: 'workspace_settings',
      idempotencyKey: key,
    }),
  'workspace.repository.add': (key) =>
    addWorkspaceRepository({
      workspaceId: 'm',
      source: 'workspace_settings',
      repository: { repoPath: repo },
      idempotencyKey: key,
    }),
  'workspace.repository.remove': (key) =>
    removeWorkspaceRepository({
      workspaceId: 'm',
      repoId: 'r1',
      source: 'workspace_settings',
      idempotencyKey: key,
    }),
  'workspace.sourceRepo.initialize': (key) =>
    initializeWorkspaceSourceRepo({
      workspaceId: 'm',
      source: 'workspace_settings',
      idempotencyKey: key,
    }),
  'workspace.sourceChanges.apply.workspace': (key) =>
    applySourceChanges({
      kind: 'workspace',
      source: 'workspace_settings',
      request: {
        workspaceId: 'm',
        target: { mode: 'new', existingWorktreeIds: [] },
        workspaceScripts: { dev: 'echo dev' },
      },
      getWindow: () => null,
      idempotencyKey: key,
    }),
  'workspace.sourceChanges.apply.project': (key) =>
    applySourceChanges({
      kind: 'project',
      source: 'project_settings',
      request: {
        projectId: 'a',
        target: { mode: 'new', existingWorktreeIds: [] },
        scripts: { dev: 'echo dev' },
      },
      getWindow: () => null,
      idempotencyKey: key,
    }),
  'composition.combine.workspace': (key) =>
    combineWorktreeWithWorkspace({
      sourceWorkspaceId: 'a',
      sourceWorktreeId: 'one',
      joinWorkspaceId: 'b',
      mode: 'temporary',
      idempotencyKey: key,
    }),
  'composition.combine.existing-worktree': (key) =>
    combineWorktreeWithExistingWorktree({
      sourceWorkspaceId: 'a',
      sourceWorktreeId: 'one',
      joinWorkspaceId: 'b',
      joinWorktreeId: 'two',
      mode: 'temporary',
      idempotencyKey: key,
    }),
  'composition.promote': (key) =>
    promoteTemporaryWorkspace({
      workspaceId: 'm',
      name: 'Promoted',
      idempotencyKey: key,
    }),
  'composition.split': (key) =>
    splitTemporaryWorkspaceWorktree({
      workspaceId: 'm',
      worktreeId: 'one',
      selections: {},
      rootAction: 'delete',
      idempotencyKey: key,
    }),
  'archive.container.restore': (key) =>
    restoreArchivedContainer('a', 'archived', { idempotencyKey: key }),
  'sharedContainer.fork': (key) =>
    forkSharedContainer({
      containerId: 'container',
      revisionId: 'revision',
      sourceOwnerDisplayName: 'Ada',
      destination: {
        kind: 'new-workspace',
        owner: { kind: 'personal' },
        parentDirectory: join(dir, 'forks'),
      },
      idempotencyKey: key,
    }),
  'workspace.scripts.update': (key) =>
    updateWorkspaceScripts({
      workspaceId: 'a',
      source: 'desktop',
      change: { kind: 'merge-commands', commands: { setup: 'pnpm install' } },
      idempotencyKey: key,
    }),
  'workspace.hooks.update': (key) =>
    updateWorkspaceHooks({
      workspaceId: 'a',
      source: 'desktop',
      change: {
        kind: 'replace',
        hooks: {
          'worktree:created': [
            { type: 'pipeline', source: 'bundled', id: 'p' },
          ],
        },
      },
      idempotencyKey: key,
    }),
  'workspace.planDetection.update': (key) =>
    updateWorkspacePlanDetection({
      workspaceId: 'a',
      source: 'desktop',
      planDetection: { disabledRuleIds: ['a'] },
      idempotencyKey: key,
    }),
  'worktree.hooks.setPaused': (key) =>
    setWorktreeHooksPaused({
      workspaceId: 'a',
      worktreeId: 'one',
      source: 'desktop',
      change: { kind: 'pause', hookKeys: ['onCreate'] },
      idempotencyKey: key,
    }),
  'workspace.retention.update': (key) =>
    updateWorkspaceRetention({
      workspaceId: 'a',
      patch: { archiveRetentionDays: 30, autoArchiveDays: 7 },
      source: 'workspace_settings',
      idempotencyKey: key,
    }),
  'workspace.privateMemory.update': (key) =>
    updateWorkspacePrivateMemory({
      workspaceId: 'a',
      privateMemory: true,
      source: 'workspace_settings',
      idempotencyKey: key,
    }),
  'workspace.plugins.update.defaults': (key) =>
    updateWorkspacePlugins({
      workspaceId: 'a',
      change: {
        kind: 'setDefaults',
        defaultPluginSelections: {
          collectionIds: ['collection-1'],
          skillRefs: [],
          pluginRefs: [],
        },
      },
      source: 'workspace_settings',
      idempotencyKey: key,
    }),
  'workspace.plugins.update.prune': (key) =>
    updateWorkspacePlugins({
      workspaceId: 'a',
      change: { kind: 'pruneMarketplace', marketplaceId: 'market' },
      source: 'marketplace_removal',
      fanOutRequestId: key,
    }),
  'workspace.cowork.update': (key) =>
    updateCoworkWorkspaceSettings({
      projectId: 'a',
      description: 'Notes',
      idempotencyKey: key,
    }),
};

class ReceiptCaptured extends Error {}
type Receipt = Parameters<W5CommitLogHost['lookupReceipt']>[0];

/** The receipt the entry point looks up first, before any admission or effect. */
async function captureReceipt(
  entry: HistoricalEntry,
  key: string,
): Promise<Receipt> {
  let captured: Receipt | undefined;
  const lookup = jest
    .spyOn(host, 'lookupReceipt')
    .mockImplementationOnce((receipt) => {
      captured = receipt;
      return Promise.reject(new ReceiptCaptured());
    });
  try {
    await expect(invoke(entry, key)).rejects.toBeInstanceOf(ReceiptCaptured);
  } finally {
    lookup.mockRestore();
  }
  if (!captured) throw new Error(`${entry.key} looked up no receipt`);
  // A marketplace prune keys each workspace of its fan-out request.
  const keyed: unknown = expect.stringContaining(key);
  expect(captured).toMatchObject({
    caller: entry.caller,
    operation: entry.operation,
    idempotencyKey: keyed,
  });
  return captured;
}

function invoke(entry: HistoricalEntry, key: string): Promise<unknown> {
  const run = invocations[entry.key];
  if (!run) throw new Error(`No entry point for ${entry.key}`);
  return run(key);
}

/** An earlier build's decision: the receipt and its saved outcome, no files. */
async function plant(receipt: Receipt, saved: unknown): Promise<void> {
  await expect(
    host.commit({
      operation: receipt.operation,
      receipt,
      advance: [],
      files: [],
      outcome: saved,
    }),
  ).resolves.toMatchObject({ status: 'applied' });
}

/**
 * Every keyed entry point reaches the core keyed runner through desktop's
 * `runKeyedW5Operation`. Counts its business admission and its work, which
 * run only for a new key.
 */
function observeKeyedRuns(): {
  runs: number;
  admitted: number;
  worked: number;
} {
  const counts = { runs: 0, admitted: 0, worked: 0 };
  const run = keyedOperation.runKeyedW5Operation;
  jest
    .spyOn(keyedOperation, 'runKeyedW5Operation')
    .mockImplementation((input, decode, work) => {
      counts.runs += 1;
      const { admit } = input;
      return run(
        {
          ...input,
          admit:
            admit &&
            (async (): Promise<void> => {
              counts.admitted += 1;
              await admit();
            }),
        },
        decode,
        (binding, attempt) => {
          counts.worked += 1;
          return work(binding, attempt);
        },
      );
    });
  return counts;
}

/** Any call here would be a new reservation, decision or recovery choice. */
function observeHostWrites(): jest.SpyInstance[] {
  return [
    jest.spyOn(host, 'commit'),
    jest.spyOn(host, 'reserve'),
    jest.spyOn(host, 'releaseReservation'),
    jest.spyOn(host, 'markReservationRecoveryRequired'),
    jest.spyOn(host, 'updateReservationDiagnostics'),
    jest.spyOn(host, 'resolveRecovery'),
  ];
}

async function expectResult(
  pending: Promise<unknown>,
  expectation: Expectation,
): Promise<void> {
  switch (expectation.kind) {
    case 'replay':
      expect(await pending).toStrictEqual(expectation.value);
      return;
    case 'void':
      expect(await pending).toBeUndefined();
      return;
    case 'refused': {
      const error: unknown = await pending.then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ name: expectation.name });
      expect(error).not.toBeInstanceOf(W5CommitRefusedError);
      if (expectation.message !== undefined) {
        const message: unknown = expect.stringContaining(expectation.message);
        expect(error).toMatchObject({ message });
      }
    }
  }
}

const cases = fixture.entries.flatMap((entry) =>
  entry.cases.map((item) => [`${entry.key} ${item.id}`, entry, item] as const),
);

/** One replayable case per entry, for the receipt lifecycle states. */
const representatives = fixture.entries.map((entry) => {
  const item = entry.cases.find(
    (candidate) => candidate.expect.kind !== 'refused',
  );
  if (!item) throw new Error(`${entry.key} has no replayable case`);
  return [entry.key, entry, item] as const;
});

function readSavedOutcomes(): Map<string, string> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT r.idempotency_key AS key, c.outcome_json AS outcome
           FROM w5_receipts r JOIN w5_commits c USING (commit_id)`,
      )
      .all();
    return new Map(
      rows.map((row) => [String(row.key), String(row.outcome)] as const),
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

describe('saved receipts replay through the core runners and desktop entry points', () => {
  const plantedKeys = new Map<string, string>();
  const key = (id: string): string => `replay:${id}`;

  // Every receipt is planted first, so the bytes check covers all of them
  // even when a filter runs only some cases.
  beforeAll(async () => {
    await setUp();
    for (const [, entry, item] of cases) {
      const receipt = await captureReceipt(entry, key(item.id));
      plantedKeys.set(item.id, receipt.idempotencyKey);
      await plant(receipt, item.saved);
    }
  });
  afterAll(tearDown);
  afterEach(() => jest.restoreAllMocks());

  it('covers every keyed entry point and no other', () => {
    expect(fixture.entries.map((entry) => entry.key).sort()).toEqual(
      Object.keys(invocations).sort(),
    );
  });

  it.each(cases)('%s', async (_name, entry, item) => {
    const before = snapshot();
    const gitBefore = gitWorktrees();
    const writes = observeHostWrites();
    const lookup = jest.spyOn(host, 'lookupReceipt');
    const keyed = observeKeyedRuns();

    await expectResult(invoke(entry, key(item.id)), item.expect);

    expect(keyed).toEqual({ runs: 1, admitted: 0, worked: 0 });
    // The saved outcome was read, and nothing new was admitted or decided.
    expect(lookup).toHaveBeenCalledTimes(1);
    await expect(lookup.mock.results[0]?.value).resolves.toMatchObject({
      status: 'replay',
      outcome: item.saved,
    });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    expect(gitWorktrees()).toBe(gitBefore);
  });

  it('never rewrites a saved receipt', async () => {
    await host.shutdown();
    const saved = readSavedOutcomes();
    expect(plantedKeys.size).toBe(cases.length);
    for (const [, , item] of cases)
      expect(saved.get(plantedKeys.get(item.id) ?? item.id)).toBe(
        JSON.stringify(item.saved),
      );
    startHost();
  });

  it.each(representatives)(
    '%s replays the same outcome after a worker restart',
    async (_name, entry, item) => {
      await host.shutdown();
      startHost();
      const before = snapshot();
      const writes = observeHostWrites();
      const keyed = observeKeyedRuns();
      await expectResult(invoke(entry, key(item.id)), item.expect);
      expect(keyed).toEqual({ runs: 1, admitted: 0, worked: 0 });
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
    },
  );
});

// ---------------------------------------------------------------------------
// W5a3 stored-outcome projectors
// ---------------------------------------------------------------------------

describe('saved receipts project through the W5a3 stored-outcome projectors', () => {
  const projected = fixture.entries.flatMap((entry) =>
    entry.projector
      ? entry.cases.map(
          (item) => [`${entry.key} ${item.id}`, entry.projector, item] as const,
        )
      : [],
  );

  function project(
    projector: NonNullable<HistoricalEntry['projector']>,
    stored: unknown,
  ): Projection {
    try {
      return {
        kind: 'value',
        value: projectors[projector.name](stored, projector.workspaceId),
      };
    } catch (error) {
      expect(error).toBeInstanceOf(W5OutcomeDecodeError);
      return { kind: 'refused' };
    }
  }

  it('covers every projector', () => {
    expect(new Set(projected.map(([, projector]) => projector?.name))).toEqual(
      new Set(PROJECTOR_NAMES),
    );
  });

  it.each(projected)('%s', (_name, projector, item) => {
    if (!projector || !item.projected) throw new Error('No projection');
    const saved = structuredClone(item.saved);
    // An untagged receipt reads as version 1.
    expect(project(projector, saved)).toStrictEqual(item.projected);
    expect(saved).toStrictEqual(item.saved);
    // A receipt desktop refuses is refused here too.
    if (item.expect.kind === 'refused')
      expect(item.projected.kind).toBe('refused');
    // What desktop's own replay keeps projects to the same result.
    if (item.expect.kind === 'replay' && item.projected.kind === 'value')
      expect(
        project(projector, JSON.parse(JSON.stringify(item.expect.value))),
      ).toStrictEqual(item.projected);
  });
});

// ---------------------------------------------------------------------------
// Receipt lifecycle states
// ---------------------------------------------------------------------------

describe('saved receipts that cannot replay are refused without effects', () => {
  beforeAll(setUp);
  afterAll(tearDown);
  afterEach(() => jest.restoreAllMocks());

  const expiredKey = (id: string): string => `expired:${id}`;
  const interruptedKey = (id: string): string => `interrupted:${id}`;

  beforeAll(async () => {
    for (const [, entry, item] of representatives) {
      await plant(await captureReceipt(entry, expiredKey(item.id)), item.saved);
      const receipt = await captureReceipt(entry, interruptedKey(item.id));
      const reservationId = randomUUID();
      await host.reserve({
        reservationId,
        operation: receipt.operation,
        receipt,
      });
      await host.markReservationRecoveryRequired(reservationId, {
        operation: receipt.operation,
        errorName: 'Error',
      });
    }
    // The 30-day retry window passes.
    await host.shutdown();
    const log = W5CommitLog.open(dbPath, {
      clock: () => Date.now() + 31 * 24 * 60 * 60 * 1000,
    });
    try {
      expect(log.compact()).toBe(representatives.length);
    } finally {
      log.close();
    }
    startHost();
  });

  /*
   * Fork receipts saved from da9d0b7624 until 0a9d1a3e78 fingerprinted the
   * request without the share's owner, its acceptance time or the
   * destination owner. A same-key retry of one is a changed request today.
   */
  it('refuses a fork receipt saved under its pre-0a9d1a3e78 fingerprint', async () => {
    const fork = fixture.entries.find(
      (entry) => entry.key === 'sharedContainer.fork',
    );
    const item = fork?.cases.find(
      (candidate) => candidate.id === 'fork-legacy-provenance',
    );
    if (!fork || !item) throw new Error('Fixture has no legacy fork case');
    const receipt = await captureReceipt(fork, 'legacy-fingerprint');
    // Sorted keys, as the keyed runner canonicalizes them.
    const legacyParameters = JSON.stringify({
      containerId: 'container',
      destination: {
        kind: 'new-workspace',
        parentDirectory: join(dir, 'forks'),
      },
      revisionId: 'revision',
      sourceOwnerDisplayName: 'Ada',
    });
    const fingerprint = createHash('sha256')
      .update(legacyParameters)
      .digest('hex');
    expect(fingerprint).not.toBe(receipt.fingerprint);
    await plant({ ...receipt, fingerprint }, item.saved);
    const before = snapshot();
    const writes = observeHostWrites();
    const keyed = observeKeyedRuns();
    await expect(invoke(fork, 'legacy-fingerprint')).rejects.toMatchObject({
      reason: 'key-reused',
    });
    expect(keyed).toEqual({ runs: 1, admitted: 0, worked: 0 });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it.each(representatives)(
    '%s refuses an expired outcome',
    async (_name, entry, item) => {
      const before = snapshot();
      const writes = observeHostWrites();
      const keyed = observeKeyedRuns();
      await expect(invoke(entry, expiredKey(item.id))).rejects.toMatchObject({
        reason: 'outcome-expired',
      });
      expect(keyed).toEqual({ runs: 1, admitted: 0, worked: 0 });
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
    },
  );

  it.each(representatives)(
    '%s refuses an interrupted attempt that needs recovery',
    async (_name, entry, item) => {
      const before = snapshot();
      const writes = observeHostWrites();
      const keyed = observeKeyedRuns();
      await expect(
        invoke(entry, interruptedKey(item.id)),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      expect(keyed).toEqual({ runs: 1, admitted: 0, worked: 0 });
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
    },
  );
});

// ---------------------------------------------------------------------------
// Launch recovery before replay
// ---------------------------------------------------------------------------

describe('a saved decision that never reached its files', () => {
  beforeAll(setUp);
  afterAll(tearDown);
  afterEach(() => jest.restoreAllMocks());

  const appliedKey = (id: string): string => `unapplied:${id}`;
  const conflictKey = (id: string): string => `conflicted:${id}`;
  const probe = (name: string): string => join(root, 'a', `${name}.json`);

  beforeAll(async () => {
    const receipts = [];
    for (const [, entry, item] of representatives)
      receipts.push({
        item,
        applied: await captureReceipt(entry, appliedKey(item.id)),
        conflicted: await captureReceipt(entry, conflictKey(item.id)),
      });
    // A crash after the decision, before the applier wrote its files.
    await host.shutdown();
    const log = W5CommitLog.open(dbPath);
    try {
      for (const { item, applied, conflicted } of receipts) {
        log.commit({
          operation: applied.operation,
          receipt: applied,
          advance: [],
          files: [
            {
              path: probe(`applied-${item.id}`),
              contents: '{}',
              previousFingerprint: null,
            },
          ],
          outcome: item.saved,
        });
        // The file changed since the decision: recovery cannot apply it.
        writeFileSync(probe(`conflicted-${item.id}`), 'edited');
        log.commit({
          operation: conflicted.operation,
          receipt: conflicted,
          advance: [],
          files: [
            {
              path: probe(`conflicted-${item.id}`),
              contents: '{}',
              previousFingerprint: null,
            },
          ],
          outcome: item.saved,
        });
      }
    } finally {
      log.close();
    }
    startHost();
    // Launch recovery runs once, before any case's snapshot.
    expect((await host.recoveryReport()).applied).toHaveLength(
      representatives.length,
    );
  });

  it.each(representatives)(
    '%s is applied by launch recovery, then replays its saved outcome',
    async (_name, entry, item) => {
      // Recovery already applied the file in beforeAll; the replay adds nothing.
      expect(readFileSync(probe(`applied-${item.id}`), 'utf8')).toBe('{}');
      const before = snapshot();
      const writes = observeHostWrites();
      const keyed = observeKeyedRuns();
      await expectResult(invoke(entry, appliedKey(item.id)), item.expect);
      expect(keyed).toEqual({ runs: 1, admitted: 0, worked: 0 });
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
    },
  );

  it.each(representatives)(
    '%s refuses a decision recovery could not apply',
    async (_name, entry, item) => {
      const before = snapshot();
      const writes = observeHostWrites();
      const keyed = observeKeyedRuns();
      await expect(invoke(entry, conflictKey(item.id))).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      expect(keyed).toEqual({ runs: 1, admitted: 0, worked: 0 });
      expect(readFileSync(probe(`conflicted-${item.id}`), 'utf8')).toBe(
        'edited',
      );
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
    },
  );
});

// ---------------------------------------------------------------------------
// Destructive lifecycle journals
// ---------------------------------------------------------------------------

describe('saved worktree archive journals', () => {
  beforeAll(setUp);
  afterAll(tearDown);
  afterEach(() => jest.restoreAllMocks());

  function journalPath(worktreeId: string): string {
    const key = createHash('sha256')
      .update(JSON.stringify(['a', worktreeId]))
      .digest('hex');
    return join(getW5DestructiveLifecycleDir(), `${key}.json`);
  }

  it.each(fixture.journals.map((journal) => [journal.id, journal] as const))(
    '%s',
    async (_name, journal) => {
      const path = journalPath(journal.worktreeId);
      mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
      const bytes = JSON.stringify(journal.saved);
      writeFileSync(path, bytes);
      try {
        const before = snapshot();
        const writes = observeHostWrites();
        if (journal.expect.kind === 'never-replayed') {
          // The archive reads a completed outcome only from a completed journal.
          await expect(
            readDestructiveRecovery('a', journal.worktreeId),
          ).resolves.toMatchObject({ state: 'recovery-required' });
          await expect(
            findCompletedDestructiveArchive('a', journal.worktreeId),
          ).resolves.toBeNull();
        } else {
          const pending = archiveWorktree({
            workspaceId: 'a',
            worktreeId: journal.worktreeId,
            source: 'single_repo',
          });
          if (journal.expect.kind === 'recovery-required')
            await expect(pending).rejects.toMatchObject({
              reason: 'recovery-required',
            });
          else await expectResult(pending, journal.expect);
        }
        for (const write of writes) expect(write).not.toHaveBeenCalled();
        expect(snapshot()).toEqual(before);
        expect(readFileSync(path, 'utf8')).toBe(bytes);
      } finally {
        rmSync(path, { force: true });
      }
      expect(existsSync(path)).toBe(false);
    },
  );
});

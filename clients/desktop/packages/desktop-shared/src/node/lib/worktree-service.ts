import { randomUUID } from 'node:crypto';
import {
  worktreeListProcessLock,
  withW5ProcessFileLocks,
} from '../w5-host-cohort/process-file-lock';
import {
  copyFile,
  link,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { getCanopyDataDir } from '../../canopy-paths';
import { APP_ADVISOR_PROJECT_ID, APP_ADVISOR_WORKTREE_ID } from '../../types';
import type {
  ArchiveWorktreeResponse,
  CreateWorkspaceWorktreeResponse,
  CreateWorktreeResponse,
  SidebarItem,
  WorkspaceWorktreeRepairIssue,
  WorktreeData,
  WorktreeGitFailedEvent,
  WorktreeGitReadyEvent,
} from '../../types';
import { readCanopyJson, writeCanopyJson } from './canopy-json';
import { writeFileAtomically, type AtomicFileStorage } from './atomic-file';
import { withStorageAdmission } from './storage-admission';
import {
  isProjectInstructionFileReadable,
  resolveProjectInstructionFile,
  restoreProjectInstructionFiles,
} from './project-instruction-files';
import {
  initializePanelLayoutModeFile,
  PANEL_LAYOUT_MODE_FILENAME,
  readWorkspaceDefaultLayoutMode,
} from './panel-layout-mode';
import { getWorkspaceItem } from './workspace-cli-reads';
import {
  getMultiRepoRepoWorktreeDir,
  getMultiRepoRootWorktreeDir,
  getMultiRepoWorktreeDir,
  getSingleRepoWorktreeDir,
  getWorktreesFilePath,
  multiRepoGitEntries,
  normalizeWorktree,
  pathExists,
  readWorktrees,
  runGit,
} from './worktree-cli-reads';
import { isErrnoException } from './type-guards';

import { BrowserProfileRepository } from '../browser-profiles/repository';
import { resolveBrowserTaskOwner } from '../browser-profiles/owners';
import { prepareBrowserTaskRetirement } from '../browser-profiles/lifecycle';
import { settleAll } from './detached-work';

export type { WorktreeCliRepoEntry } from './worktree-cli-reads';
export {
  aggregateMultiRepoDiffStats,
  getWorktreeCliRecord,
  getWorktreeStats,
  listWorktreeCliRepoEntries,
  listWorktreeCliRows,
  listWorktreePipelineExecutions,
} from './worktree-cli-reads';

const DEFERRED_BROWSER_RETIREMENT_WARNING =
  'Browser data for this worktree will be cleared the next time the app starts.';

async function withBrowserTaskRetirement(
  workspaceId: string,
  worktreeId: string,
  operation: () => Promise<ArchiveWorktreeResponse>,
): Promise<ArchiveWorktreeResponse> {
  const dataRoot = getCanopyDataDir();
  const repository = new BrowserProfileRepository(
    path.join(dataRoot, 'browser-profiles'),
  );
  // Browser profile metadata never holds an archive. An unfenced or uncommitted
  // profile whose owner is removed is retired by desktop owner reconciliation.
  let deferred = false;
  let retirementId: string | null = null;
  try {
    const owner = await resolveBrowserTaskOwner(
      dataRoot,
      workspaceId,
      worktreeId,
    );
    retirementId = owner
      ? await prepareBrowserTaskRetirement(repository, dataRoot, owner)
      : null;
  } catch {
    deferred = true;
  }
  // A CLI failure during Git removal has an uncertain outcome. Leave its durable
  // fence for desktop recovery instead of reviving a potentially removed owner.
  const result = await operation();
  if (retirementId) {
    try {
      await repository.commitRetirement(retirementId, {
        kind: 'owner_removed',
        ownerOperationId: retirementId,
      });
    } catch {
      deferred = true;
    }
  }
  return deferred
    ? {
        ...result,
        warnings: [...result.warnings, DEFERRED_BROWSER_RETIREMENT_WARNING],
      }
    : result;
}

export type NodeWindowHandle = { readonly __nodeWindowHandle?: never };

export interface CreateWorktreeServiceOptions {
  workspaceId: string;
  existingWorktreeIds?: string[];
  branchName?: string;
  baseWorktreeId?: string;
  baseBranch?: string;
  repairWorkspaceRoot?: boolean;
  restoreClaudeMd?: boolean;
  startPostCreateSetup?: boolean;
  /** Defaults to true. Restore-style callers can explicitly suppress seeding. */
  seedPanelLayoutMode?: boolean;
  startProjectPostCreateSetup?: ProjectWorktreePostCreateSetup;
  startWorkspacePostCreateSetup?: WorkspaceWorktreePostCreateSetup;
  getWindow?: () => NodeWindowHandle | null;
  deferGitSetup?: boolean;
  onGitReady?: (event: WorktreeGitReadyEvent) => void;
  onGitFailed?: (event: WorktreeGitFailedEvent) => void;
}

async function seedCreatedWorktreePanelLayoutMode(
  options: CreateWorktreeServiceOptions,
  worktreeId: string,
): Promise<void> {
  if (
    options.seedPanelLayoutMode === false ||
    (options.workspaceId === APP_ADVISOR_PROJECT_ID &&
      worktreeId === APP_ADVISOR_WORKTREE_ID)
  ) {
    return;
  }
  try {
    const mode = await readWorkspaceDefaultLayoutMode();
    await initializePanelLayoutModeFile(
      {
        workspaceId: options.workspaceId,
        worktreeId,
        filePath: path.join(
          getCanopyDataDir(),
          'workspaces',
          options.workspaceId,
          'worktree-data',
          worktreeId,
          PANEL_LAYOUT_MODE_FILENAME,
        ),
      },
      mode,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      'Failed to seed worktree panel layout mode ' +
        `(workspaceId=${options.workspaceId}, worktreeId=${worktreeId}): ` +
        `${errorMessage}\n`,
    );
  }
}

export interface WorktreeArchiveLiveServices {
  cleanupLiveState?: (projectId: string, worktreeId: string) => Promise<void>;
  purgeObservabilityData?: (
    projectId: string,
    worktreeId: string,
  ) => Promise<void>;
}

export type ProjectWorktreePostCreateSetup = (params: {
  projectId: string;
  worktreeId: string;
  project: { repoPath: string };
  getWindow: () => NodeWindowHandle | null;
}) => void | Promise<void>;

export type WorkspaceWorktreePostCreateSetup = (params: {
  workspaceId: string;
  worktreeId: string;
  workspaceRootPath: string;
  repos: Array<{ id: string; name: string; repoPath: string }>;
  getWindow: () => NodeWindowHandle | null;
}) => void | Promise<void>;

interface WorktreesFile {
  version: 1;
  worktrees: WorktreeData[];
}

interface ArchiveSingleRepoOptions {
  workspaceId: string;
  worktreeId: string;
  repoPath?: string;
  observabilityMode?: 'persisted-only' | 'live-service';
  liveServices?: WorktreeArchiveLiveServices;
}

interface ArchiveMultiRepoOptions {
  workspaceId: string;
  worktreeId: string;
  observabilityMode?: 'persisted-only' | 'live-service';
  liveServices?: WorktreeArchiveLiveServices;
}

function normalizeBranchName(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function makeWorktreeId(
  existingIds: string[],
  branchName: string | null,
): string {
  const base =
    branchName
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'worktree';
  const existing = new Set(existingIds);
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

// Shared W5 writers run in CLI commands and headless built-in actions.
const WORKTREE_LIST_STORAGE: AtomicFileStorage = {
  namespace: 'worktree_list',
  writer: 'desktop_cli',
};

/** A failed create keeps its primary error and names effects needing cleanup. */
export class WorktreeCreationConflictError extends Error {
  constructor(
    readonly worktreeId: string,
    readonly remainingPaths: readonly string[],
    cause?: unknown,
  ) {
    super(
      cause instanceof Error
        ? cause.message
        : 'This worktree could not be saved safely. Its existing files have been kept.',
    );
    this.name = 'WorktreeCreationConflictError';
    Object.defineProperty(this, 'cause', { value: cause, configurable: true });
  }
}

/** Git removal completed; metadata persistence still needs recovery. */
export class WorktreeArchiveMetadataError extends Error {
  constructor(
    readonly worktreeId: string,
    readonly path: string,
    cause: unknown,
  ) {
    super(
      'The checkout was removed, but its worktree list could not be saved.',
    );
    this.name = 'WorktreeArchiveMetadataError';
    Object.defineProperty(this, 'cause', { value: cause, configurable: true });
  }
}

interface CliWorktree extends WorktreeData {
  cliCreationToken?: string;
}
const ownedCreations = new Map<string, string>();

/** CLI lifecycle order: checkout resource, then list. Workers take only lists.
 * Neither layer acquires repository locks or the host decision queue.
 */
function lockCheckout<T>(
  workspaceId: string,
  worktreeId: string,
  work: () => Promise<T>,
): Promise<T> {
  return withW5ProcessFileLocks(
    [getSingleRepoWorktreeDir(workspaceId, worktreeId)],
    { dataRoot: getCanopyDataDir() },
    work,
  );
}

function lockWorktreeList<T>(
  workspaceId: string,
  work: () => Promise<T>,
): Promise<T> {
  return worktreeListProcessLock(getCanopyDataDir())(
    [getWorktreesFilePath(workspaceId)],
    work,
  );
}

/** Mutations must preserve unknown row fields and refuse unreadable lists. */
async function readMutableWorktrees(
  workspaceId: string,
): Promise<CliWorktree[]> {
  let raw: string;
  try {
    raw = await readFile(getWorktreesFilePath(workspaceId), 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return [];
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('worktrees' in value) ||
    !Array.isArray(value.worktrees) ||
    !value.worktrees.every(
      (row: unknown): row is CliWorktree =>
        typeof row === 'object' &&
        row !== null &&
        'id' in row &&
        typeof row.id === 'string' &&
        'branchName' in row &&
        typeof row.branchName === 'string' &&
        'createdAt' in row &&
        typeof row.createdAt === 'string',
    )
  )
    throw new Error('The worktree list cannot be read safely.');
  return value.worktrees.map((row) => ({ ...row, ...normalizeWorktree(row) }));
}

async function appendWorktree(
  workspaceId: string,
  worktree: CliWorktree,
): Promise<void> {
  await lockWorktreeList(workspaceId, async () => {
    const current = await readMutableWorktrees(workspaceId);
    if (current.some((row) => row.id === worktree.id))
      throw new WorktreeCreationConflictError(worktree.id, []);
    await writeWorktrees(workspaceId, [worktree, ...current]);
    if (worktree.cliCreationToken)
      ownedCreations.set(
        getWorktreesFilePath(workspaceId) + ':' + worktree.id,
        worktree.cliCreationToken,
      );
  });
}

async function removeWorktreeRecord(
  workspaceId: string,
  worktreeId: string,
): Promise<void> {
  try {
    await lockWorktreeList(workspaceId, async () => {
      const current = await readMutableWorktrees(workspaceId);
      await writeWorktrees(
        workspaceId,
        current.filter((row) => row.id !== worktreeId),
      );
      ownedCreations.delete(
        getWorktreesFilePath(workspaceId) + ':' + worktreeId,
      );
    });
  } catch (cause) {
    throw new WorktreeArchiveMetadataError(
      worktreeId,
      getWorktreesFilePath(workspaceId),
      cause,
    );
  }
}

async function writeWorktrees(
  workspaceId: string,
  worktrees: WorktreeData[],
): Promise<void> {
  const filePath = getWorktreesFilePath(workspaceId);
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload: WorktreesFile = { version: 1, worktrees };
  await writeFileAtomically(filePath, JSON.stringify(payload, null, 2), {
    encoding: 'utf8',
    storage: WORKTREE_LIST_STORAGE,
  });
}

async function addGitWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  baseBranch: string | undefined,
): Promise<void> {
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const startPoint = baseBranch ?? 'HEAD';
  await runGit(
    ['worktree', 'add', '-b', branchName, worktreePath, startPoint],
    repoPath,
  );
}

async function gitignoreContainsReposEntry(
  worktreeRoot: string,
): Promise<boolean> {
  try {
    const content = await readFile(
      path.join(worktreeRoot, '.gitignore'),
      'utf8',
    );
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .some((line) => line === 'repos' || line === 'repos/');
  } catch {
    return false;
  }
}

async function ensureGitignoreContainsReposEntry(
  worktreeRoot: string,
): Promise<void> {
  const gitignorePath = path.join(worktreeRoot, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(gitignorePath, 'utf8');
  } catch {
    await writeFile(gitignorePath, 'repos/\n', 'utf8');
    return;
  }

  if (await gitignoreContainsReposEntry(worktreeRoot)) {
    return;
  }

  const separator =
    existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  await writeFile(gitignorePath, `${existing}${separator}repos/\n`, 'utf8');
}

export async function ensureAgentsMdSymlinkOrCopy(
  worktreeRoot: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const agentsPath = path.join(worktreeRoot, 'AGENTS.md');
  await rm(agentsPath, { recursive: true, force: true });

  if (platform !== 'win32') {
    try {
      await symlink('CLAUDE.md', agentsPath);
      return;
    } catch (error) {
      if (
        !isErrnoException(error) ||
        (error.code !== 'EPERM' && error.code !== 'EACCES')
      ) {
        throw error;
      }
    }
  }

  const claudePath = path.join(worktreeRoot, 'CLAUDE.md');
  try {
    await link(claudePath, agentsPath);
  } catch {
    await copyFile(claudePath, agentsPath);
  }
}

async function validateWorkspaceRootWorktree(
  workspaceId: string,
  worktreeId: string,
): Promise<WorkspaceWorktreeRepairIssue[]> {
  const worktreeRoot = getMultiRepoRootWorktreeDir(workspaceId, worktreeId);
  const issues: WorkspaceWorktreeRepairIssue[] = [];

  if (!(await gitignoreContainsReposEntry(worktreeRoot))) {
    issues.push({
      code: (await pathExists(path.join(worktreeRoot, '.gitignore')))
        ? 'invalid-gitignore'
        : 'missing-gitignore',
      message: '.gitignore must include "repos/" for nested project repos',
      blocking: true,
    });
  }

  try {
    const manifest = await readCanopyJson(worktreeRoot);
    if (manifest === null) {
      issues.push({
        code: 'missing-canopy-json',
        message: 'canopy.json is missing from the project root',
        blocking: true,
      });
    }
  } catch (error) {
    issues.push({
      code: 'invalid-canopy-json',
      message:
        error instanceof Error
          ? error.message
          : 'canopy.json is invalid in the project root',
      blocking: true,
    });
  }

  const [hasAgentsMd, hasClaudeMd] = await settleAll([
    isProjectInstructionFileReadable(worktreeRoot, 'AGENTS.md').catch(
      () => false,
    ),
    isProjectInstructionFileReadable(worktreeRoot, 'CLAUDE.md').catch(
      () => false,
    ),
  ]);
  if (!hasAgentsMd && !hasClaudeMd) {
    issues.push({
      code: 'missing-claude-md',
      message: 'AGENTS.md is missing from the project root',
      blocking: false,
    });
  }

  if (!hasAgentsMd) {
    issues.push({
      code: 'invalid-agents-md',
      message: 'AGENTS.md must mirror CLAUDE.md',
      blocking: false,
    });
  }

  return issues;
}

async function repairWorkspaceRootWorktree(options: {
  workspace: SidebarItem & { type: 'multi-repo' };
  worktreeId: string;
  restoreClaudeMd: boolean;
}): Promise<WorkspaceWorktreeRepairIssue[]> {
  const worktreeRoot = getMultiRepoRootWorktreeDir(
    options.workspace.id,
    options.worktreeId,
  );
  await mkdir(worktreeRoot, { recursive: true });
  await ensureGitignoreContainsReposEntry(worktreeRoot);

  const manifest = options.workspace.sourceRepoPath
    ? await readCanopyJson(options.workspace.sourceRepoPath)
    : null;
  await writeCanopyJson(worktreeRoot, manifest ?? { version: 1, repos: [] });

  try {
    const existing = await resolveProjectInstructionFile(worktreeRoot);
    if (existing.exists) {
      if (
        path.basename(existing.filePath) === 'CLAUDE.md' &&
        !existing.aliasPath
      ) {
        await ensureAgentsMdSymlinkOrCopy(worktreeRoot);
      }
    } else if (options.restoreClaudeMd && options.workspace.sourceRepoPath) {
      const source = await resolveProjectInstructionFile(
        options.workspace.sourceRepoPath,
      );
      if (source.exists) {
        await restoreProjectInstructionFiles(source, existing);
        if (
          !existing.aliasPath &&
          path.basename(source.filePath) === 'CLAUDE.md'
        ) {
          await ensureAgentsMdSymlinkOrCopy(worktreeRoot);
        }
      }
    }
  } catch {
    return validateWorkspaceRootWorktree(
      options.workspace.id,
      options.worktreeId,
    );
  }

  return validateWorkspaceRootWorktree(
    options.workspace.id,
    options.worktreeId,
  );
}

async function removeGitWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  try {
    await runGit(['worktree', 'remove', '--force', worktreePath], repoPath);
  } catch {
    await rm(worktreePath, { recursive: true, force: true });
  }
}

function buildTrackedRepoBaseBranches(
  entries: Array<{ id: string }>,
  baseBranch: string | undefined,
): Record<string, string> | undefined {
  if (!baseBranch) {
    return undefined;
  }
  const tracked: Record<string, string> = {};
  for (const entry of entries) {
    tracked[entry.id] = baseBranch;
  }
  return tracked;
}

export function rollbackPersistedReservation(
  ...args: Parameters<typeof rollbackAdmittedReservation>
): Promise<void> {
  return withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    lockCheckout(args[0], args[1], () => rollbackAdmittedReservation(...args)),
  );
}

async function rollbackAdmittedReservation(
  workspaceId: string,
  worktreeId: string,
  metadataDir: string,
  expectedToken?: string,
): Promise<void> {
  await lockWorktreeList(workspaceId, async () => {
    const current = await readMutableWorktrees(workspaceId);
    const owned = current.find((row) => row.id === worktreeId);
    expectedToken ??= ownedCreations.get(
      getWorktreesFilePath(workspaceId) + ':' + worktreeId,
    );
    if (!expectedToken || owned?.cliCreationToken !== expectedToken)
      throw new WorktreeCreationConflictError(worktreeId, [metadataDir]);
    await writeWorktrees(
      workspaceId,
      current.filter((row) => row !== owned),
    );
    await rm(metadataDir, { recursive: true, force: true });
    ownedCreations.delete(getWorktreesFilePath(workspaceId) + ':' + worktreeId);
  });
}

export function createSingleRepoWorktree(
  ...args: Parameters<typeof createAdmittedSingleRepoWorktree>
): Promise<CreateWorktreeResponse> {
  return withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    createAdmittedSingleRepoWorktree(...args),
  );
}

async function createAdmittedSingleRepoWorktree(
  options: CreateWorktreeServiceOptions,
): Promise<CreateWorktreeResponse> {
  const workspace = await getWorkspaceItem(options.workspaceId);
  if (workspace.type !== 'single-repo') {
    throw new Error(`Project ${options.workspaceId} is not single-repo`);
  }
  const current = await readWorktrees(options.workspaceId);
  const explicitBranch = normalizeBranchName(options.branchName);
  const id = makeWorktreeId(
    [
      ...current.map((worktree) => worktree.id),
      ...(options.existingWorktreeIds ?? []),
    ],
    explicitBranch,
  );
  const branchName = explicitBranch ?? id;
  const worktree: CliWorktree = {
    id,
    cliCreationToken: randomUUID(),
    branchName,
    createdAt: new Date().toISOString(),
    trackedBaseBranch: options.baseBranch,
  };
  const worktreePath = getSingleRepoWorktreeDir(options.workspaceId, id);
  return lockCheckout(options.workspaceId, id, async () => {
    try {
      await addGitWorktree(
        workspace.repoPath,
        worktreePath,
        branchName,
        options.baseBranch,
      );
      // Reread under the shared lock after Git; never replace a stale list.
      await appendWorktree(options.workspaceId, worktree);
    } catch (error) {
      // A failed Git command may already have created a checkout (for example,
      // before a hook failed). Preserve even uncertain effects and their cause.
      throw new WorktreeCreationConflictError(id, [worktreePath], error);
    }
    await seedCreatedWorktreePanelLayoutMode(options, id);
    return {
      id,
      branchName,
      createdAt: worktree.createdAt,
      trackedBaseBranch: options.baseBranch,
    };
  });
}

export function rollbackWorkspaceWorktree(
  ...args: Parameters<typeof rollbackAdmittedWorkspaceWorktree>
): Promise<void> {
  return withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    lockCheckout(args[0], args[1], () =>
      rollbackAdmittedWorkspaceWorktree(...args),
    ),
  );
}

async function rollbackAdmittedWorkspaceWorktree(
  workspaceId: string,
  worktreeId: string,
  worktreeDir: string,
  repos: Array<{ id: string; name: string; repoPath: string }>,
  _repoIds?: string[],
  sourceRepoPath?: string,
  expectedToken?: string,
): Promise<void> {
  expectedToken ??= ownedCreations.get(
    getWorktreesFilePath(workspaceId) + ':' + worktreeId,
  );
  // Old callers without invocation provenance must recover manually.
  await lockWorktreeList(workspaceId, async () => {
    const current = await readMutableWorktrees(workspaceId);
    if (
      !expectedToken ||
      !current.some(
        (row) =>
          row.id === worktreeId && row.cliCreationToken === expectedToken,
      )
    )
      throw new WorktreeCreationConflictError(worktreeId, [worktreeDir]);
  });
  await settleAll(
    repos.map((repo) =>
      removeGitWorktree(
        repo.repoPath,
        getMultiRepoRepoWorktreeDir(workspaceId, worktreeId, repo.id),
      ),
    ),
  );
  if (sourceRepoPath) {
    await removeGitWorktree(
      sourceRepoPath,
      getMultiRepoRootWorktreeDir(workspaceId, worktreeId),
    );
  }
  await rm(worktreeDir, { recursive: true, force: true });
  await rollbackAdmittedReservation(
    workspaceId,
    worktreeId,
    worktreeDir,
    expectedToken,
  );
}

export function createMultiRepoWorktree(
  ...args: Parameters<typeof createAdmittedMultiRepoWorktree>
): Promise<CreateWorkspaceWorktreeResponse> {
  return withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    createAdmittedMultiRepoWorktree(...args),
  );
}

async function createAdmittedMultiRepoWorktree(
  options: CreateWorktreeServiceOptions,
): Promise<CreateWorkspaceWorktreeResponse> {
  const workspace = await getWorkspaceItem(options.workspaceId);
  if (workspace.type !== 'multi-repo') {
    throw new Error(`Project ${options.workspaceId} is not multi-repo`);
  }
  const current = await readWorktrees(options.workspaceId);
  const explicitBranch = normalizeBranchName(options.branchName);
  const id = makeWorktreeId(
    [
      ...current.map((worktree) => worktree.id),
      ...(options.existingWorktreeIds ?? []),
    ],
    explicitBranch,
  );
  const branchName = explicitBranch ?? id;
  const worktree: CliWorktree = {
    id,
    cliCreationToken: randomUUID(),
    branchName,
    createdAt: new Date().toISOString(),
  };
  const worktreeDir = getMultiRepoWorktreeDir(options.workspaceId, id);
  return lockCheckout(options.workspaceId, id, async () => {
    const gitEntries = multiRepoGitEntries(workspace, id);
    const trackedRepoBaseBranches = buildTrackedRepoBaseBranches(
      gitEntries,
      options.baseBranch,
    );
    if (trackedRepoBaseBranches) {
      worktree.trackedRepoBaseBranches = trackedRepoBaseBranches;
    }

    const attemptedPaths: string[] = [];
    try {
      if (workspace.sourceRepoPath) {
        attemptedPaths.push(
          getMultiRepoRootWorktreeDir(options.workspaceId, id),
        );
        await addGitWorktree(
          workspace.sourceRepoPath,
          getMultiRepoRootWorktreeDir(options.workspaceId, id),
          branchName,
          options.baseBranch,
        );
        const repairIssues = await validateWorkspaceRootWorktree(
          options.workspaceId,
          id,
        );
        if (repairIssues.some((issue) => issue.blocking)) {
          if (options.repairWorkspaceRoot === true) {
            const repairedIssues = await repairWorkspaceRootWorktree({
              workspace,
              worktreeId: id,
              restoreClaudeMd: options.restoreClaudeMd ?? true,
            });
            const blockingIssues = repairedIssues.filter(
              (issue) => issue.blocking,
            );
            if (blockingIssues.length > 0) {
              throw new Error(
                blockingIssues.map((issue) => issue.message).join('; '),
              );
            }
          } else {
            throw new Error(
              'Created project root worktree requires repair and cannot be finalized from the CLI. ' +
                'Re-run this command with --repair to repair project root files during creation. ' +
                'Add --no-restore-claude-md if repair should not restore project instructions from the project source repo.',
            );
          }
        }
      } else {
        attemptedPaths.push(worktreeDir);
        await mkdir(path.dirname(worktreeDir), { recursive: true });
        await mkdir(worktreeDir);
      }

      for (const repo of workspace.repos) {
        attemptedPaths.push(
          getMultiRepoRepoWorktreeDir(options.workspaceId, id, repo.id),
        );
        await addGitWorktree(
          repo.repoPath,
          getMultiRepoRepoWorktreeDir(options.workspaceId, id, repo.id),
          branchName,
          options.baseBranch,
        );
      }
      await appendWorktree(options.workspaceId, worktree);
    } catch (error) {
      // A failed Git command may itself have partial effects. Without a durable
      // reservation proving every checkout's ownership, preserve them for recovery.
      throw new WorktreeCreationConflictError(id, attemptedPaths, error);
    }
    await seedCreatedWorktreePanelLayoutMode(options, id);
    return {
      id,
      branchName,
      createdAt: worktree.createdAt,
      trackedRepoBaseBranches,
      needsRepair: false,
    };
  });
}

export function archiveSingleRepoWorktree(
  ...args: Parameters<typeof archiveAdmittedSingleRepoWorktree>
): Promise<ArchiveWorktreeResponse> {
  return withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    lockCheckout(args[0].workspaceId, args[0].worktreeId, () =>
      archiveAdmittedSingleRepoWorktree(...args),
    ),
  );
}

async function archiveAdmittedSingleRepoWorktree(
  options: ArchiveSingleRepoOptions,
): Promise<ArchiveWorktreeResponse> {
  return withBrowserTaskRetirement(
    options.workspaceId,
    options.worktreeId,
    async () => {
      const workspace = await getWorkspaceItem(options.workspaceId);
      const repoPath =
        options.repoPath ??
        (workspace.type === 'single-repo' ? workspace.repoPath : null);
      if (!repoPath) {
        throw new Error(`Project ${options.workspaceId} is not single-repo`);
      }
      await removeGitWorktree(
        repoPath,
        getSingleRepoWorktreeDir(options.workspaceId, options.worktreeId),
      );
      await removeWorktreeRecord(options.workspaceId, options.worktreeId);
      return { success: true, warnings: [] };
    },
  );
}

export function archiveMultiRepoWorktree(
  ...args: Parameters<typeof archiveAdmittedMultiRepoWorktree>
): Promise<ArchiveWorktreeResponse> {
  return withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    lockCheckout(args[0].workspaceId, args[0].worktreeId, () =>
      archiveAdmittedMultiRepoWorktree(...args),
    ),
  );
}

async function archiveAdmittedMultiRepoWorktree(
  options: ArchiveMultiRepoOptions,
): Promise<ArchiveWorktreeResponse> {
  return withBrowserTaskRetirement(
    options.workspaceId,
    options.worktreeId,
    async () => {
      const workspace = await getWorkspaceItem(options.workspaceId);
      if (workspace.type !== 'multi-repo') {
        throw new Error(`Project ${options.workspaceId} is not multi-repo`);
      }
      for (const repo of workspace.repos) {
        await removeGitWorktree(
          repo.repoPath,
          getMultiRepoRepoWorktreeDir(
            options.workspaceId,
            options.worktreeId,
            repo.id,
          ),
        );
      }
      if (workspace.sourceRepoPath) {
        await removeGitWorktree(
          workspace.sourceRepoPath,
          getMultiRepoRootWorktreeDir(options.workspaceId, options.worktreeId),
        );
      }
      await rm(
        getMultiRepoWorktreeDir(options.workspaceId, options.worktreeId),
        {
          recursive: true,
          force: true,
        },
      );
      await removeWorktreeRecord(options.workspaceId, options.worktreeId);
      return { success: true, warnings: [] };
    },
  );
}

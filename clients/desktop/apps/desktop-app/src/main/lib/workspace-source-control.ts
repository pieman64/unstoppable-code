import { w5CompositionLocks } from './w5-composition-operation';
import { commitW5BoundaryStep } from './w5-composition-operation';
import type { W5CommitOptions } from './w5-commit-scope';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  isHookTriggerName,
  getChatHookActionOverlayKey,
  normalizeHookInputMap,
  type HookAction,
  type HookOverrides,
} from '@canopy/desktop-shared/hooks';
import type { ScriptDefinition } from '@canopy/desktop-shared/scripts';
import type {
  CanopyJsonFile,
  CanopyJsonRepoEntry,
  WorkspaceConfigFile,
  WorkspaceInitGitResponse,
  WorkspaceSourceWarning,
  WorkspaceWorktreeRepairIssue,
} from '@canopy/desktop-shared/types';
import {
  createWorktree,
  getRemoteUrl,
  initGitRepo,
  isGitRepo,
  stageAllChanges,
  commitWithLocalIdentity,
} from './git';
import {
  getDefaultReposDir,
  getWorkspaceClaudeMdPath,
  getWorkspaceWorktreeRootRepoDir,
} from './paths';
import { readCanopyJson, writeCanopyJson } from './canopy-json';
import {
  WORKSPACE_SOURCE_REPO_INITIAL_COMMIT_MESSAGE,
  ensureGitignoreContainsReposEntry,
  findAvailableWorkspaceSourceRepoPath,
  gitignoreContainsReposEntry,
  sanitizeWorkspaceSourceRepoName,
} from '@canopy/desktop-shared/node/lib/workspace-source-repo';
import {
  ensureAgentsMdSymlink,
  isProjectInstructionFileReadable,
  resolveProjectInstructionFile,
  restoreProjectInstructionFiles,
} from './instruction-files';
import { readWorkspaceIndexEntry } from './sidebar-items';
import { validateId } from './validation';
import {
  readWorkspaceConfig,
  readWorkspaceConfigDetailed,
  readWorkspaceWorktrees,
  updateWorkspaceConfig,
  WorkspaceConfigUnreadableError,
} from './workspace-persistence';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';
import { safeRemoveWorktree } from './safe-remove-worktree';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';

const WORKSPACE_ROOT_RESTORE_SKIP = new Set<string>([
  '.git',
  '.gitignore',
  'AGENTS.md',
  'canopy.json',
  'CLAUDE.md',
]);

interface BuiltWorkspaceManifest {
  manifest: CanopyJsonFile;
  localConfig: WorkspaceConfigFile;
  warnings: WorkspaceSourceWarning[];
}

/** The caller of a source repository initialization (CAN-3819). */
export type WorkspaceSourceRepoInitializeSource =
  /** `workspace:init-git` from the project settings. */
  | 'workspace_settings'
  /** A new multi-repo project, in its create commit (D2). */
  | 'workspace_create'
  /** A temporary project being promoted to a regular one. */
  | 'temporary_promote';

/** `core.workspace.sourceRepo.initialize`. */
export interface WorkspaceSourceRepoInitializeRequest {
  workspaceId: string;
  /** The repository folder name; the project name when omitted. */
  repoName?: string;
  /**
   * The project name, which the create and promote callers already hold.
   * Project settings omit it and the project's index entry supplies it.
   */
  workspaceName?: string;
  source: WorkspaceSourceRepoInitializeSource;
}

export type WorkspaceSourceRepoRefusal =
  | 'not-found'
  | 'temporary'
  | 'already-initialized'
  | 'configuration-unavailable';

/**
 * The initialization was refused. Every refusal but a source repository
 * recorded while this one was being created comes before any effect.
 */
export class WorkspaceSourceRepoRefusedError extends Error {
  constructor(
    readonly reason: WorkspaceSourceRepoRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceSourceRepoRefusedError';
  }
}

const ALREADY_INITIALIZED_MESSAGE = 'Project already has a source repository';

function refuseSourceRepo(
  reason: WorkspaceSourceRepoRefusal,
  message: string,
): WorkspaceSourceRepoRefusedError {
  return new WorkspaceSourceRepoRefusedError(reason, message);
}

/**
 * Applies what the source repository took over to the configuration read in
 * the write queue: each repository the manifest was built from becomes a
 * manifest or local repository as the build decided, repositories added
 * since are left as they are, workspace scripts move into `canopy.json` and
 * hooks keep their local overlays.
 */
function recordSourceRepo(
  config: WorkspaceConfigFile,
  built: BuiltWorkspaceManifest,
  sourceRepoPath: string,
): void {
  const localized = new Map(
    built.localConfig.repos.map((repo) => [repo.id, repo]),
  );
  config.repos = config.repos.map((repo) => {
    const decided = localized.get(repo.id);
    if (!decided) return repo;
    return decided.source === 'manifest'
      ? {
          ...repo,
          source: 'manifest',
          manifestUrl: decided.manifestUrl,
          scripts: undefined,
          hooks: extractLocalHookOverlays(repo.hooks),
        }
      : { ...repo, source: 'local', manifestUrl: undefined };
  });
  config.scripts = undefined;
  config.hooks = extractLocalHookOverlays(config.hooks);
  config.sourceRepoPath = sourceRepoPath;
}

/**
 * The typed in-process `core.workspace.sourceRepo.initialize` boundary
 * (CAN-3819): creates and commits a multi-repo project's source repository
 * under the managed repos directory, from the project settings
 * (`workspace:init-git`), a new multi-repo project and a temporary project's
 * promotion.
 *
 * A missing project and, from the settings, a temporary project are refused
 * before anything is created, as is a project that already has a source
 * repository. The source repository path, the repositories the manifest took
 * over and the moved scripts are recorded on the configuration read inside
 * its write queue, so a repository or setting changed while the repository
 * was being committed is kept. A source repository recorded in the meantime
 * is refused and the new repository folder is left in place; nothing is
 * deleted. It makes no revision or idempotency guarantee (CAN-3805), so the
 * operation stays unregistered.
 */
export async function initializeWorkspaceSourceRepo(
  request: WorkspaceSourceRepoInitializeRequest,
  transition?: { commit: W5CommitOptions; beforeEffects?: () => void },
): Promise<WorkspaceInitGitResponse> {
  const { workspaceId } = request;
  validateId(workspaceId, 'workspaceId');
  const detail = await readWorkspaceConfigDetailed(workspaceId);
  if (detail.authority === 'absent') {
    throw refuseSourceRepo('not-found', `Project ${workspaceId} not found`);
  }
  if (detail.authority === 'unreadable') {
    throw refuseSourceRepo(
      'configuration-unavailable',
      new WorkspaceConfigUnreadableError().message,
    );
  }
  const localConfig = detail.config;
  if (request.source === 'workspace_settings' && localConfig.temporary) {
    throw refuseSourceRepo(
      'temporary',
      'Promote this temporary project before initializing source control.',
    );
  }
  if (localConfig.sourceRepoPath) {
    throw refuseSourceRepo('already-initialized', ALREADY_INITIALIZED_MESSAGE);
  }
  const workspaceName =
    request.workspaceName ??
    (await readWorkspaceIndexEntry(workspaceId))?.name ??
    workspaceId;

  transition?.beforeEffects?.();
  const prepared = await prepareWorkspaceSourceRepo(
    request,
    localConfig,
    workspaceName,
  );
  const { built, sourceRepoPath } = prepared;

  try {
    const stageInitializedSourceRepo = (): Promise<void> =>
      updateWorkspaceConfig(workspaceId, (config, read): void => {
        if (read.authority === 'absent') {
          throw refuseSourceRepo(
            'not-found',
            `Project ${workspaceId} not found`,
          );
        }
        if (config.sourceRepoPath) {
          throw refuseSourceRepo(
            'already-initialized',
            ALREADY_INITIALIZED_MESSAGE,
          );
        }
        recordSourceRepo(config, built, sourceRepoPath);
      });
    await commitW5BoundaryStep(
      transition?.commit,
      transition ? w5CompositionLocks({ manifests: [workspaceId] }) : [],
      stageInitializedSourceRepo,
    );
  } catch (error) {
    if (error instanceof WorkspaceConfigUnreadableError) {
      throw refuseSourceRepo('configuration-unavailable', error.message);
    }
    throw error;
  }
  await repairExistingWorkspaceRootWorktrees(workspaceId);

  return {
    sourceRepoPath,
    manifest: built.manifest,
    warnings: built.warnings,
  };
}

/** Provisions source control before a new workspace enters its W5 write scope. */
export async function prepareNewWorkspaceSourceRepo(
  workspaceId: string,
  workspaceName: string,
  config: WorkspaceConfigFile,
  plannedSourceRepoPath?: string,
): Promise<string> {
  validateId(workspaceId, 'workspaceId');
  const { built, sourceRepoPath } = await prepareWorkspaceSourceRepo(
    { workspaceId, workspaceName, source: 'workspace_create' },
    config,
    workspaceName,
    plannedSourceRepoPath,
  );
  recordSourceRepo(config, built, sourceRepoPath);
  return sourceRepoPath;
}

async function prepareWorkspaceSourceRepo(
  request: WorkspaceSourceRepoInitializeRequest,
  localConfig: WorkspaceConfigFile,
  workspaceName: string,
  plannedSourceRepoPath?: string,
): Promise<{ built: BuiltWorkspaceManifest; sourceRepoPath: string }> {
  const { workspaceId } = request;
  const destinationRoot = await ensureDefaultReposDir();
  const preferredName = sanitizeWorkspaceSourceRepoName(
    request.repoName ?? workspaceName,
  );
  const sourceRepoPath =
    plannedSourceRepoPath ??
    (await findAvailableWorkspaceSourceRepoPath(
      destinationRoot,
      preferredName,
    ));

  // Validate and prepare the portable manifest before creating a repository.
  const built = await buildWorkspaceManifest(localConfig);

  await mkdir(sourceRepoPath, {
    recursive: plannedSourceRepoPath === undefined,
  });
  await initGitRepo(sourceRepoPath);

  await writeWorkspaceRootFiles(
    sourceRepoPath,
    built.manifest,
    true,
    getWorkspaceClaudeMdPath(workspaceId),
  );

  await stageAllChanges(sourceRepoPath);
  await commitWithLocalIdentity(
    sourceRepoPath,
    WORKSPACE_SOURCE_REPO_INITIAL_COMMIT_MESSAGE,
  );

  return { built, sourceRepoPath };
}

export async function repairExistingWorkspaceRootWorktrees(
  workspaceId: string,
): Promise<void> {
  // Startup project loading can overlap automatic archival. Re-read targets
  // only after acquiring the same operation lock used by capture and deletion.
  const { withArchivedWorkspaceOperationLock } =
    await import('./archived-containers');
  return withArchivedWorkspaceOperationLock(workspaceId, () =>
    repairExistingWorkspaceRootWorktreesWithoutOperationLock(workspaceId),
  );
}

async function repairExistingWorkspaceRootWorktreesWithoutOperationLock(
  workspaceId: string,
): Promise<void> {
  const config = await readWorkspaceConfig(workspaceId);
  if (!config.sourceRepoPath) {
    return;
  }
  const referenceRepoPath = await resolveWorkspaceReferenceRepoPath(
    config.sourceRepoPath,
  );

  const worktrees = await readWorkspaceWorktrees(workspaceId);
  const failures: string[] = [];

  for (const worktree of worktrees) {
    const worktreeRoot = getWorkspaceWorktreeRootRepoDir(
      workspaceId,
      worktree.id,
    );
    if (!(await pathExists(worktreeRoot))) {
      continue;
    }

    try {
      await repairExistingWorkspaceRootWorktree(
        workspaceId,
        worktree.id,
        worktree.branchName.trim() || worktree.id,
        referenceRepoPath,
      );
    } catch (error) {
      failures.push(
        `${worktree.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Failed to repair ${failures.length} project root worktrees:\n${failures.join('\n')}`,
    );
  }
}

export async function validateWorkspaceRootWorktree(
  workspaceId: string,
  worktreeId: string,
): Promise<WorkspaceWorktreeRepairIssue[]> {
  const worktreeRoot = getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId);
  const issues: WorkspaceWorktreeRepairIssue[] = [];

  if (!(await gitignoreContainsReposEntry(worktreeRoot))) {
    const gitignorePath = join(worktreeRoot, '.gitignore');
    issues.push({
      code: (await pathExists(gitignorePath))
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
        error instanceof Error ? error.message : 'canopy.json is invalid',
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

export async function repairWorkspaceRootWorktree(
  workspaceId: string,
  worktreeId: string,
  restoreClaudeMd: boolean,
): Promise<WorkspaceWorktreeRepairIssue[]> {
  const config = await readWorkspaceConfig(workspaceId);
  if (!config.sourceRepoPath) {
    throw new Error('Project does not have a source repository');
  }
  const referenceRepoPath = await resolveWorkspaceReferenceRepoPath(
    config.sourceRepoPath,
  );

  const manifest =
    (await readCanopyJson(referenceRepoPath).catch(() => null)) ??
    buildRepairManifest(config);
  const worktreeRoot = getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId);

  await writeWorkspaceRootFiles(
    worktreeRoot,
    manifest,
    restoreClaudeMd,
    join(referenceRepoPath, 'CLAUDE.md'),
  );
  return validateWorkspaceRootWorktree(workspaceId, worktreeId);
}

export async function buildWorkspaceManifest(
  config: WorkspaceConfigFile,
): Promise<BuiltWorkspaceManifest> {
  const warnings: WorkspaceSourceWarning[] = [];
  const manifestRepos: CanopyJsonRepoEntry[] = [];
  const localRepos: WorkspaceConfigFile['repos'] = [];

  for (const repo of config.repos) {
    const remoteUrl = await getRemoteUrl(repo.repoPath);
    if (remoteUrl) {
      manifestRepos.push({
        id: repo.id,
        name: repo.name,
        url: remoteUrl,
        ...(repo.scripts ? { scripts: repo.scripts } : {}),
        ...(repo.hooks
          ? {
              hooks: normalizeManifestRepoHooks(
                repo.hooks,
                warnings,
                repo.id,
                repo.name,
              ),
            }
          : {}),
      });
      localRepos.push({
        ...repo,
        source: 'manifest',
        manifestUrl: remoteUrl,
        scripts: undefined,
        hooks: extractLocalHookOverlays(repo.hooks),
      });
      continue;
    }

    warnings.push({
      code: 'missing-remote',
      repoId: repo.id,
      repoName: repo.name,
      message: `${repo.name} has no origin remote and remains local-only`,
    });
    localRepos.push({
      ...repo,
      source: 'local',
      manifestUrl: undefined,
    });
  }

  const manifest: CanopyJsonFile = {
    version: 1,
    ...(config.scripts
      ? { scripts: filterManifestScripts(config.scripts) }
      : {}),
    ...(config.hooks
      ? { hooks: normalizeManifestWorkspaceHooks(config.hooks, warnings) }
      : {}),
    repos: manifestRepos,
  };

  return {
    manifest,
    localConfig: {
      ...config,
      repos: localRepos,
      scripts: undefined,
      hooks: extractLocalHookOverlays(config.hooks),
    },
    warnings,
  };
}

function buildRepairManifest(config: WorkspaceConfigFile): CanopyJsonFile {
  const manifestRepos: CanopyJsonRepoEntry[] = [];

  for (const repo of config.repos) {
    if (repo.source !== 'manifest' || !repo.manifestUrl) {
      continue;
    }

    manifestRepos.push({
      id: repo.id,
      name: repo.name,
      url: repo.manifestUrl,
    });
  }

  return {
    version: 1,
    repos: manifestRepos,
  };
}

async function writeWorkspaceRootFiles(
  targetDir: string,
  manifest: CanopyJsonFile,
  restoreClaudeMd: boolean,
  claudeMdSourcePath: string,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  await ensureGitignoreContainsReposEntry(targetDir);
  await writeCanopyJson(targetDir, manifest);

  try {
    const existing = await resolveProjectInstructionFile(targetDir);
    if (existing.exists) {
      if (
        basename(existing.filePath) === 'CLAUDE.md' &&
        !(await pathExists(join(targetDir, 'AGENTS.md')))
      ) {
        await ensureAgentsMdSymlink(targetDir);
      }
      return;
    }
    if (!restoreClaudeMd) return;

    const source = await resolveProjectInstructionFile(
      dirname(claudeMdSourcePath),
    );
    if (!source.exists) return;
    await restoreProjectInstructionFiles(source, existing);
    // Only create a legacy alias when restoring an actual CLAUDE.md into an
    // empty target. Existing project-owned instructions are never replaced.
    if (!existing.aliasPath && basename(source.filePath) === 'CLAUDE.md') {
      await ensureAgentsMdSymlink(targetDir);
    }
  } catch {
    return;
  }
}

async function repairExistingWorkspaceRootWorktree(
  workspaceId: string,
  worktreeId: string,
  branchName: string,
  referenceRepoPath: string,
): Promise<void> {
  const worktreeRoot = getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId);

  if (await isGitRepo(worktreeRoot)) {
    const existingIssues = await validateWorkspaceRootWorktree(
      workspaceId,
      worktreeId,
    );
    if (!existingIssues.some((issue) => issue.blocking)) {
      return;
    }

    const issues = await repairWorkspaceRootWorktree(
      workspaceId,
      worktreeId,
      true,
    );
    const blockingIssues = issues.filter((issue) => issue.blocking);
    if (blockingIssues.length > 0) {
      throw new Error(formatRepairIssues(blockingIssues));
    }
    return;
  }

  const shelvedDir = await shelveWorkspaceRootEntries(worktreeRoot, worktreeId);
  try {
    await createWorktree(referenceRepoPath, worktreeRoot, branchName);
    await restoreShelvedWorkspaceRootEntries(worktreeRoot, shelvedDir);
    const existingIssues = await validateWorkspaceRootWorktree(
      workspaceId,
      worktreeId,
    );
    const issues = existingIssues.some((issue) => issue.blocking)
      ? await repairWorkspaceRootWorktree(workspaceId, worktreeId, true)
      : existingIssues;
    const blockingIssues = issues.filter((issue) => issue.blocking);
    if (blockingIssues.length > 0) {
      throw new Error(formatRepairIssues(blockingIssues));
    }
  } catch (error) {
    await rollbackShelvedWorkspaceRootEntries(
      referenceRepoPath,
      worktreeRoot,
      shelvedDir,
    );
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function shelveWorkspaceRootEntries(
  worktreeRoot: string,
  worktreeId: string,
): Promise<string | null> {
  if (!(await pathExists(worktreeRoot))) {
    return null;
  }

  const entries = await readdir(worktreeRoot, { withFileTypes: true });
  if (entries.length === 0) {
    await rm(worktreeRoot, { recursive: true, force: true });
    return null;
  }

  const shelvedDir = join(dirname(worktreeRoot), `.${worktreeId}-root-repair`);
  await rm(shelvedDir, { recursive: true, force: true });
  await mkdir(shelvedDir, { recursive: true });

  for (const entry of entries) {
    await rename(join(worktreeRoot, entry.name), join(shelvedDir, entry.name));
  }

  await rm(worktreeRoot, { recursive: true, force: true });
  return shelvedDir;
}

async function restoreShelvedWorkspaceRootEntries(
  worktreeRoot: string,
  shelvedDir: string | null,
): Promise<void> {
  if (!shelvedDir || !(await pathExists(shelvedDir))) {
    return;
  }

  const entries = await readdir(shelvedDir, { withFileTypes: true });
  for (const entry of entries) {
    if (WORKSPACE_ROOT_RESTORE_SKIP.has(entry.name)) {
      continue;
    }

    const targetPath = join(worktreeRoot, entry.name);
    if (await pathExists(targetPath)) {
      continue;
    }

    await rename(join(shelvedDir, entry.name), targetPath);
  }

  await rm(shelvedDir, { recursive: true, force: true });
}

async function rollbackShelvedWorkspaceRootEntries(
  referenceRepoPath: string,
  worktreeRoot: string,
  shelvedDir: string | null,
): Promise<void> {
  if (await pathExists(worktreeRoot)) {
    try {
      await safeRemoveWorktree(
        referenceRepoPath,
        worktreeRoot,
        'workspace-source-control safeRemoveWorktree',
      );
    } catch {
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  }

  if (!shelvedDir || !(await pathExists(shelvedDir))) {
    return;
  }

  await mkdir(worktreeRoot, { recursive: true });
  const entries = await readdir(shelvedDir, { withFileTypes: true });
  for (const entry of entries) {
    await rename(join(shelvedDir, entry.name), join(worktreeRoot, entry.name));
  }
  await rm(shelvedDir, { recursive: true, force: true });
}

function filterManifestScripts(
  scripts: WorkspaceConfigFile['scripts'],
): Record<string, string | ScriptDefinition> | undefined {
  if (!scripts) {
    return undefined;
  }

  const entries = Object.entries(scripts).filter(
    (entry): entry is [string, string | ScriptDefinition] => entry[1] !== null,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeManifestWorkspaceHooks(
  hooks: WorkspaceConfigFile['hooks'],
  warnings: WorkspaceSourceWarning[],
): CanopyJsonFile['hooks'] {
  const normalized = normalizeHookInputMap(hooks);
  if (!normalized) {
    return undefined;
  }

  const nextHooks: NonNullable<CanopyJsonFile['hooks']> = {};
  let strippedLocalSelections = false;
  for (const [triggerName, actions] of Object.entries(normalized)) {
    if (isHookTriggerName(triggerName) && Array.isArray(actions)) {
      const portable = portableManifestHookActions(actions);
      nextHooks[triggerName] = portable.actions;
      strippedLocalSelections ||= portable.strippedLocalSelections;
    }
  }
  if (strippedLocalSelections) {
    warnings.push({
      code: 'local-hook-plugin-selections',
      message:
        'Local hook plugin selections and installed mentions remain in project settings and were omitted from canopy.json.',
    });
  }
  return Object.keys(nextHooks).length > 0 ? nextHooks : undefined;
}

function normalizeManifestRepoHooks(
  hooks: WorkspaceConfigFile['repos'][number]['hooks'],
  warnings: WorkspaceSourceWarning[],
  repoId: string,
  repoName: string,
): CanopyJsonRepoEntry['hooks'] {
  const normalized = normalizeHookInputMap(hooks);
  if (!normalized) {
    return undefined;
  }

  const nextHooks: NonNullable<CanopyJsonRepoEntry['hooks']> = {};
  let strippedLocalSelections = false;
  for (const [triggerName, actions] of Object.entries(normalized)) {
    if (!isHookTriggerName(triggerName)) {
      continue;
    }
    if (actions === null) {
      nextHooks[triggerName] = null;
      continue;
    }
    if (Array.isArray(actions)) {
      const portable = portableManifestHookActions(actions);
      nextHooks[triggerName] = portable.actions;
      strippedLocalSelections ||= portable.strippedLocalSelections;
    }
  }

  if (strippedLocalSelections) {
    warnings.push({
      code: 'local-hook-plugin-selections',
      repoId,
      repoName,
      message: `${repoName} hook plugin selections and installed mentions remain local and were omitted from canopy.json.`,
    });
  }

  return Object.keys(nextHooks).length > 0 ? nextHooks : undefined;
}

function portableManifestHookActions(actions: HookAction[]): {
  actions: HookAction[];
  strippedLocalSelections: boolean;
} {
  let strippedLocalSelections = false;
  const portableActions = actions.map((action) => {
    const portableAction = { ...action };
    if (
      (portableAction.type === 'pipeline' || portableAction.type === 'chat') &&
      pipelineHookBindingsEnabled()
    ) {
      delete portableAction.executionContext;
      delete portableAction.localExecutionContextOverlay;
    }
    const hasLocalOnlyPluginState =
      portableAction.type === 'chat' &&
      (portableAction.pluginSelections !== undefined ||
        portableAction.localPluginSelectionOverlay === true ||
        portableAction.localPluginSelectionOverlayKey !== undefined ||
        portableAction.promptReferences?.some(
          (reference) =>
            reference.kind === 'plugin' &&
            reference.plugin.kind === 'installed',
        ) === true);
    if (!hasLocalOnlyPluginState) {
      return portableAction;
    }
    strippedLocalSelections = true;
    delete portableAction.pluginSelections;
    delete portableAction.localPluginSelectionOverlay;
    delete portableAction.localPluginSelectionOverlayKey;
    if (portableAction.type === 'chat' && portableAction.promptReferences) {
      const references = portableAction.promptReferences.filter(
        (reference) =>
          reference.kind !== 'plugin' || reference.plugin.kind !== 'installed',
      );
      if (references.length > 0) portableAction.promptReferences = references;
      else delete portableAction.promptReferences;
    }
    return portableAction;
  });
  return { actions: portableActions, strippedLocalSelections };
}

function pipelineHookBindingsEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
  );
}

function extractLocalHookOverlays(
  hooks: WorkspaceConfigFile['hooks'],
): HookOverrides | undefined {
  const normalized = normalizeHookInputMap(hooks);
  if (!normalized) {
    return undefined;
  }

  const overlays: HookOverrides = {};
  for (const [triggerName, actions] of Object.entries(normalized)) {
    if (actions === null) {
      overlays[triggerName] = null;
      continue;
    }
    if (!Array.isArray(actions)) {
      continue;
    }

    const actionOverlays: HookAction[] = actions.flatMap(
      (action): HookAction[] => {
        if (
          action.type === 'pipeline' &&
          action.executionContext !== undefined &&
          pipelineHookBindingsEnabled()
        ) {
          return [
            {
              type: 'pipeline',
              source: action.source,
              id: action.id,
              executionContext: action.executionContext,
              localExecutionContextOverlay: true,
            },
          ];
        }
        if (action.type !== 'chat') return [];
        const hasExecutionContext =
          action.executionContext !== undefined &&
          pipelineHookBindingsEnabled();
        const hasLocalPluginState =
          action.pluginSelections ||
          action.promptReferences?.some(
            (reference) =>
              reference.kind === 'plugin' &&
              reference.plugin.kind === 'installed',
          );
        return hasExecutionContext || hasLocalPluginState
          ? [
              {
                type: 'chat',
                prompt: action.prompt,
                ...(hasExecutionContext
                  ? {
                      executionContext: action.executionContext,
                      localExecutionContextOverlay: true as const,
                    }
                  : {}),
                ...(hasLocalPluginState
                  ? {
                      localPluginSelectionOverlay: true as const,
                      localPluginSelectionOverlayKey:
                        getChatHookActionOverlayKey(action),
                    }
                  : {}),
                ...(action.pluginSelections
                  ? { pluginSelections: action.pluginSelections }
                  : {}),
                ...(action.promptReferences
                  ? { promptReferences: action.promptReferences }
                  : {}),
              },
            ]
          : [];
      },
    );
    if (actionOverlays.length > 0) {
      overlays[triggerName] = actionOverlays;
    }
  }

  return Object.keys(overlays).length > 0 ? overlays : undefined;
}

async function ensureDefaultReposDir(): Promise<string> {
  const reposDir = getDefaultReposDir();
  await mkdir(reposDir, { recursive: true });
  return reposDir;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function formatRepairIssues(issues: WorkspaceWorktreeRepairIssue[]): string {
  return issues.map((issue) => issue.message).join('; ');
}

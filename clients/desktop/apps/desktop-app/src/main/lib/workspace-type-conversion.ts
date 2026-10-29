import {
  checkW5ExpectedRevision,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import {
  withW5Commit,
  W5RevisionConflictError,
  W5FileWriteRefusedError,
} from './w5-commit-log-file-store';
import {
  w5CompositionLocks,
  admitW5Composition,
} from './w5-composition-operation';
import { runKeyedW5Operation, type W5KeyedAttempt } from './w5-keyed-operation';
import type { W5CommitOptions } from './w5-commit-scope';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import { getDefaultWorkspaceClaudeMd } from '@canopy/desktop-shared/constants/workspace-templates';
import type {
  CanopyJsonFile,
  ClaudeMdConversionMode,
  MultiRepoSidebarItem,
  SidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import { notifyPortalStructureChanged } from '../portal/portal-event-bus';
import { readCanopyJson, writeCanopyJson } from './canopy-json';
import { serializeWorkspaceMutation } from './chat-project-operation-queue';
import { pathExists } from './fs-utils';
import {
  resolveOptionalProjectInstructionFile,
  writeProjectInstructionFile,
} from './instruction-files';
import { mergeMultiRepoGuidance } from './multi-repo-guidance';
import {
  getWorkspaceIndexRepository,
  readAllSidebarItems,
  toSidebarItemWorkspaceConfig,
} from './sidebar-items';
import { validateId } from './validation';
import {
  WORKSPACE_INDEX_STORAGE,
  WORKSPACE_MANIFEST_STORAGE,
  withStorageAdmission,
} from './w5-storage';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
  updateWorkspaceConfig,
} from './workspace-persistence';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';

/** The caller of a project type conversion (CAN-3819). */
export type WorkspaceTypeConversionSource =
  /** `workspace:convert-type` from the project settings. */
  'workspace_settings';

/** `core.workspace.type.convert`. */
export interface WorkspaceTypeConversionRequest extends W5BoundaryOptions {
  workspaceId: string;
  /** `multi-repo` converts a single-repo project; `single-repo` the reverse. */
  targetType: 'multi-repo' | 'single-repo';
  /** How a single-repo project's instructions file takes the multi-repo guidance. */
  claudeMdMode?: ClaudeMdConversionMode;
  source: WorkspaceTypeConversionSource;
}

export type WorkspaceTypeConversionRefusal =
  | 'not-found'
  | 'organization-owned'
  | 'has-worktrees'
  | 'no-source-repository'
  | 'configuration-unavailable'
  | 'worktrees-unavailable';

/** The conversion was refused before any project file was written. */
export class WorkspaceTypeConversionRefusedError extends Error {
  constructor(
    readonly reason: WorkspaceTypeConversionRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceTypeConversionRefusedError';
  }
}

const ORG_PROJECT_CONVERT_REFUSAL =
  "Organization projects can't be converted. Create a Multi-Repo project and add this repository instead.";
const HAS_WORKTREES_REFUSAL =
  'Remove all worktrees before converting this project';
const WORKTREES_UNAVAILABLE_REFUSAL =
  "Couldn't read this project's worktrees, so it wasn't converted. Try again.";
const CONFIGURATION_UNAVAILABLE_REFUSAL =
  "Couldn't read this project's settings, so it wasn't converted. Try again.";

/**
 * Refuses a project whose `workspace.json` cannot be read, before the index
 * takes the new type, so the two are not left disagreeing (CAN-3563).
 */
async function assertConfigurationReadable(workspaceId: string): Promise<void> {
  const { authority } = await readWorkspaceConfigDetailed(workspaceId);
  if (authority === 'absent') throw notFound(workspaceId);
  if (authority === 'unreadable') {
    throw refuse(
      'configuration-unavailable',
      CONFIGURATION_UNAVAILABLE_REFUSAL,
    );
  }
}

/**
 * Refuses unless the project provably has no worktrees: the sidebar projects
 * unreadable lists and in-memory removals as empty, so durable rows are read.
 */
async function assertNoWorktrees(
  workspaceId: string,
  projected: readonly unknown[],
): Promise<void> {
  if (projected.length > 0) {
    throw refuse('has-worktrees', HAS_WORKTREES_REFUSAL);
  }
  const { worktrees, authority } = await readWorkspaceWorktreesDetailed(
    workspaceId,
    { includeRecentlyRemoved: true },
  );
  if (authority === 'unreadable' || authority === 'partial') {
    throw refuse('worktrees-unavailable', WORKTREES_UNAVAILABLE_REFUSAL);
  }
  if (worktrees.length > 0) {
    throw refuse('has-worktrees', HAS_WORKTREES_REFUSAL);
  }
}
const WORKSPACE_GITIGNORE_HEADER = `# ${BRAND.displayName} multi-repo child repositories`;
const WORKSPACE_GITIGNORE_ENTRY = 'repos/';

function refuse(
  reason: WorkspaceTypeConversionRefusal,
  message: string,
): WorkspaceTypeConversionRefusedError {
  return new WorkspaceTypeConversionRefusedError(reason, message);
}

function notFound(workspaceId: string): WorkspaceTypeConversionRefusedError {
  return refuse('not-found', `Project ${workspaceId} not found`);
}

async function ensureWorkspaceReposGitignore(repoPath: string): Promise<void> {
  const gitignorePath = join(repoPath, '.gitignore');
  const existing = (await pathExists(gitignorePath))
    ? await readFile(gitignorePath, 'utf8')
    : '';
  const lines = existing.split(/\r?\n/);
  const trimmedSet = new Set(lines.map((l) => l.trim()));

  if (!trimmedSet.has(WORKSPACE_GITIGNORE_HEADER)) {
    lines.push('', WORKSPACE_GITIGNORE_HEADER);
  }
  if (!trimmedSet.has(WORKSPACE_GITIGNORE_ENTRY)) {
    lines.push(WORKSPACE_GITIGNORE_ENTRY);
  }

  await writeFile(gitignorePath, `${lines.join('\n')}\n`, 'utf8');
}

/**
 * Turns the project's repository into a multi-repo source repository
 * (`.gitignore`, `canopy.json` and the instructions file) and returns the
 * converted project.
 */
async function toMultiRepo(
  project: SingleRepoSidebarItem,
  claudeMdMode: ClaudeMdConversionMode | undefined,
  attempt?: W5KeyedAttempt,
): Promise<MultiRepoSidebarItem> {
  // An organization project is the organization's; converting it in place
  // would leave its server record single-repo (CAN-3546).
  if (project.owner?.type === 'organization') {
    throw refuse('organization-owned', ORG_PROJECT_CONVERT_REFUSAL);
  }
  await assertNoWorktrees(project.id, project.worktrees);
  await assertConfigurationReadable(project.id);

  const repoPath = project.repoPath;
  const instructions =
    claudeMdMode === 'unchanged'
      ? undefined
      : await resolveOptionalProjectInstructionFile(repoPath);
  attempt?.beforeEffects();
  await ensureWorkspaceReposGitignore(repoPath);
  const manifest =
    (await readCanopyJson(repoPath)) ??
    ({
      version: 1,
    } satisfies CanopyJsonFile);
  await writeCanopyJson(repoPath, {
    ...manifest,
    version: 1,
    repos: [],
  });

  if (instructions) {
    const defaultInstructions = getDefaultWorkspaceClaudeMd(project.name);
    if (!instructions.exists || claudeMdMode === 'replace') {
      await writeProjectInstructionFile(instructions, defaultInstructions);
    } else if (claudeMdMode === 'update') {
      const current = await readFile(instructions.filePath, 'utf8');
      await writeProjectInstructionFile(
        instructions,
        mergeMultiRepoGuidance(current, defaultInstructions),
      );
    }
  }

  return {
    type: 'multi-repo',
    id: project.id,
    name: project.name,
    color: project.color,
    repos: [],
    worktrees: project.worktrees,
    collapsed: project.collapsed,
    order: project.order,
    pinned: project.pinned,
    itemSortMode: project.itemSortMode,
    defaultPluginSelections: project.defaultPluginSelections,
    sourceRepoPath: project.repoPath,
    scripts: project.scripts,
    activitySectionOrder: project.activitySectionOrder,
  };
}

/**
 * Turns the project's source repository back into a plain repository (its
 * `canopy.json` loses `repos`) and returns the converted project.
 */
async function toSingleRepo(
  workspace: MultiRepoSidebarItem,
  attempt?: W5KeyedAttempt,
): Promise<SingleRepoSidebarItem> {
  await assertNoWorktrees(workspace.id, workspace.worktrees);
  await assertConfigurationReadable(workspace.id);
  if (!workspace.sourceRepoPath) {
    throw refuse(
      'no-source-repository',
      'Project does not have a source repository',
    );
  }
  const referenceRepoPath = await resolveWorkspaceReferenceRepoPath(
    workspace.sourceRepoPath,
  );

  const manifest =
    (await readCanopyJson(referenceRepoPath)) ??
    ({
      version: 1,
      repos: [],
    } satisfies CanopyJsonFile);
  const nextManifest: CanopyJsonFile = {
    ...manifest,
    version: 1,
  };
  delete nextManifest.repos;
  attempt?.beforeEffects();
  await writeCanopyJson(referenceRepoPath, nextManifest);

  return {
    type: 'single-repo',
    id: workspace.id,
    name: workspace.name,
    repoPath: referenceRepoPath,
    color: workspace.color,
    worktrees: workspace.worktrees,
    collapsed: workspace.collapsed,
    order: workspace.order,
    pinned: workspace.pinned,
    itemSortMode: workspace.itemSortMode,
    defaultPluginSelections: workspace.defaultPluginSelections,
    scripts: workspace.scripts,
    activitySectionOrder: workspace.activitySectionOrder,
  };
}

/** Stages the index and manifest together, without repository-file effects. */
async function recordConversion(
  converted: SidebarItem,
  options: W5CommitOptions,
): Promise<void> {
  async function stageConversionRecords(): Promise<void> {
    await getWorkspaceIndexRepository().update(({ entries }) => {
      const target = entries.find((entry) => entry.id === converted.id);
      // Deleted since the read; the repository refuses an unreadable index.
      if (!target) throw notFound(converted.id);
      return {
        result: undefined,
        entries: entries.map((entry) =>
          entry === target ? { ...entry, type: converted.type } : entry,
        ),
      };
    });
    const config = toSidebarItemWorkspaceConfig(converted);
    await updateWorkspaceConfig(converted.id, (current, read): void => {
      if (read.authority === 'absent') throw notFound(converted.id);
      Object.assign(current, config);
    });
  }
  await withW5Commit(
    {
      ...options,
      locks: w5CompositionLocks({ index: true, manifests: [converted.id] }),
      outcome: null,
    },
    stageConversionRecords,
  );
}

/**
 * The typed in-process `core.workspace.type.convert` boundary (CAN-3819):
 * converts an empty single-repo project to a multi-repo project whose source
 * repository is the project's repository, or back, from the project settings
 * (`workspace:convert-type`).
 *
 * It runs in the workspace mutation queue. Its admission (the project of the
 * other type, no worktrees, not an organization project for a conversion to
 * multi-repo, a source repository for a conversion to single-repo) runs
 * before any file is written. The repository files are written first, then
 * this workspace's index entry and manifest in one canonical decision, so
 * another project's manifest or worktree list is never rewritten from a snapshot (F12). The
 * converted manifest keeps the fields a sidebar save of the converted project
 * keeps, as before. A keyed attempt reserves before file effects; failures after
 * those effects retain recovery state. Canonical files, workspace revision and
 * saved outcome decide together. The operation stays unregistered.
 */
export function convertWorkspaceType(
  request: WorkspaceTypeConversionRequest,
): Promise<void> {
  return withStorageAdmission(
    [WORKSPACE_INDEX_STORAGE, WORKSPACE_MANIFEST_STORAGE],
    async () => {
      validateId(request.workspaceId, 'workspaceId');
      const operation = 'core.workspace.type.convert';
      const { idempotencyKey } = request;
      const parameters = { ...request };
      delete parameters.expectedRevision;
      delete parameters.idempotencyKey;
      if (idempotencyKey === undefined)
        return convertAdmittedWorkspaceType(request, { operation });
      return runKeyedW5Operation(
        {
          operation,
          caller: 'desktop-host:workspace-type-conversion',
          idempotencyKey,
          parameters,
          isPreEffectRefusal: (error) =>
            error instanceof WorkspaceTypeConversionRefusedError ||
            error instanceof W5RevisionConflictError ||
            error instanceof W5FileWriteRefusedError,
        },
        (outcome): void => {
          if (outcome !== null)
            throw new Error('Invalid saved conversion outcome');
        },
        (binding, attempt) =>
          convertAdmittedWorkspaceType(request, binding, attempt),
      );
    },
  );
}

async function convertAdmittedWorkspaceType(
  request: WorkspaceTypeConversionRequest,
  options: W5CommitOptions,
  attempt?: W5KeyedAttempt,
): Promise<void> {
  const { workspaceId, targetType } = request;
  const resource = { kind: 'workspace', workspaceId } as const;
  await serializeWorkspaceMutation(async (): Promise<void> => {
    await checkW5ExpectedRevision(resource, request.expectedRevision);
    const { items } = await readAllSidebarItems({
      persistRemovalCleanup: false,
    });
    let converted: SidebarItem;
    if (targetType === 'multi-repo') {
      const project = items.find(
        (item): item is SingleRepoSidebarItem =>
          item.type === 'single-repo' && item.id === workspaceId,
      );
      if (!project) throw notFound(workspaceId);
      converted = await admitW5Composition(attempt, () =>
        toMultiRepo(project, request.claudeMdMode, attempt),
      );
    } else {
      const workspace = items.find(
        (item): item is MultiRepoSidebarItem =>
          item.type === 'multi-repo' && item.id === workspaceId,
      );
      if (!workspace) throw notFound(workspaceId);
      converted = await admitW5Composition(attempt, () =>
        toSingleRepo(workspace, attempt),
      );
    }
    await recordConversion(converted, {
      ...options,
      expectedRevisions: w5ExpectedRevision(resource, request.expectedRevision),
    });
    // Refresh path registries only after the canonical decision.
    await readAllSidebarItems({ persistRemovalCleanup: false });
    notifyPortalStructureChanged();
  });
}

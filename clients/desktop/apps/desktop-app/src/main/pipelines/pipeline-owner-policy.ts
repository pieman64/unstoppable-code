import { backgroundExecutionDeniedMessage } from '@canopy/desktop-shared/lib/automation-context-copy';
import type {
  PipelineOwnershipPort,
  PipelineOwnershipWorktreeTarget,
} from '@canopy/desktop-shared/node/pipelines/executor';
import { isTopLevelGlobalRun } from '@canopy/desktop-shared/node/pipelines/executor';
import { normalizePipeline } from '@canopy/desktop-shared/pipelines/normalize-pipeline';
import { getStoredPipelinePathWithSource } from '@canopy/desktop-shared/pipelines/store';
import type {
  Pipeline,
  PipelineExecutionScope,
  ResolvedPipelineExecutionTarget,
} from '@canopy/desktop-shared/types/pipeline';
import {
  parseWorkspaceContext,
  serializeWorkspaceContext,
} from '@canopy/protocol/workspace-context';
import {
  decideSameOwnerAccess,
  resolveProjectSavedOwner,
  type ProjectOwnerTarget,
  type ResolvedProjectOwner,
} from '../lib/project-owner';
import {
  backgroundExecutionContextEnabled,
  captureBackgroundExecutionContext,
  resolveBackgroundTargetContext,
} from '../services/background-execution-context';
import {
  isPipelineLocalMetadataReadable,
  readPipelineLocalMetadata,
  recordUserPipelineOwner,
} from './pipeline-local-metadata-store';

/** The selected owner, or Personal while organization projects are off. */
export async function selectedOwnerContext(): Promise<string> {
  if (!backgroundExecutionContextEnabled()) return 'personal';
  return (await captureBackgroundExecutionContext()) ?? 'personal';
}

/** Whether `pipelineId` names a pipeline in the local user pipeline store. */
export function isLocalUserPipeline(pipelineId: string): boolean {
  const stored = getStoredPipelinePathWithSource(pipelineId);
  return stored.success && stored.data?.source === 'user';
}

/**
 * The stored owner of a user pipeline. A legacy pipeline without one takes
 * the selected owner now and keeps it.
 */
export async function getUserPipelineOwner(
  pipelineId: string,
): Promise<string> {
  const stored = readPipelineLocalMetadata({
    type: 'stored',
    source: 'user',
    value: pipelineId,
  }).owner;
  if (stored !== undefined) return stored;
  const owner = await selectedOwnerContext();
  recordUserPipelineOwner(pipelineId, owner);
  return owner;
}

type OwnerResult = { owner: string } | { refusal: string };

export interface ExecutionOwnerRequest {
  /** A trusted caller's binding: hook, automation, or foreground org dispatch. */
  explicit: string | undefined;
  /** The selected context captured at dispatch (absent with the flag off). */
  captured: string | undefined;
  scope: PipelineExecutionScope | undefined;
  parentExecutionId: string | undefined;
  projectId: string | undefined;
  worktreeId: string | undefined;
  target?: ResolvedPipelineExecutionTarget;
  /** Set only when the run's pipeline is in the local user pipeline store. */
  userPipelineId: string | undefined;
}

/**
 * The owner every top-level run records in `execution_context`: an explicit
 * binding; for a global run of a user pipeline, the pipeline's owner; for any
 * other run without a project, the selected context; otherwise the target
 * project's saved owner (App Advisor's is Personal). With organization
 * projects off, everything but an explicit binding is Personal.
 */
export async function resolveExecutionOwnerContext(
  request: ExecutionOwnerRequest,
): Promise<OwnerResult> {
  if (request.explicit !== undefined) return { owner: request.explicit };
  if (!backgroundExecutionContextEnabled()) return { owner: 'personal' };
  if (
    request.userPipelineId !== undefined &&
    isTopLevelGlobalRun({
      scope: request.scope,
      parentExecutionId: request.parentExecutionId,
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      target: request.target,
    })
  ) {
    // An owner that can't be read refuses the run, like an unknown project.
    if (!isPipelineLocalMetadataReadable())
      return {
        refusal: backgroundExecutionDeniedMessage('unknown-provenance'),
      };
    return { owner: await getUserPipelineOwner(request.userPipelineId) };
  }
  if (!request.projectId) {
    return { owner: request.captured ?? (await selectedOwnerContext()) };
  }
  const saved = await resolveProjectSavedOwner({
    projectId: request.projectId,
    ...(request.worktreeId ? { worktreeId: request.worktreeId } : {}),
  });
  if (saved.kind === 'unknown')
    return { refusal: backgroundExecutionDeniedMessage('unknown-provenance') };
  if (saved.kind === 'none') return { owner: 'personal' };
  return { owner: serializeWorkspaceContext(saved) };
}

/**
 * The owner of a pipeline an agent writes inside a project: that project's
 * saved owner, or the selected context for App Advisor.
 */
export async function agentPipelineOwnerContext(target: {
  projectId: string;
  worktreeId?: string;
}): Promise<OwnerResult> {
  if (!backgroundExecutionContextEnabled()) return { owner: 'personal' };
  const saved = await resolveProjectSavedOwner(target);
  if (saved.kind === 'unknown')
    return { refusal: backgroundExecutionDeniedMessage('unknown-provenance') };
  if (saved.kind === 'none') return { owner: await selectedOwnerContext() };
  return { owner: serializeWorkspaceContext(saved) };
}

function callerOwner(
  executionContext: string | undefined,
): ResolvedProjectOwner {
  return (
    parseWorkspaceContext(executionContext ?? 'personal') ?? {
      kind: 'unknown',
    }
  );
}

/**
 * A Personal project linked to the caller's organization runs in that
 * organization, as {@link resolveBackgroundTargetContext} decides for the run
 * itself, so a run bound to the organization may target it.
 */
async function isPersonalProjectLinkedToCaller(
  caller: ResolvedProjectOwner,
  target: ProjectOwnerTarget,
): Promise<boolean> {
  if (caller.kind !== 'organization') return false;
  try {
    const resolved = await resolveBackgroundTargetContext(target, caller);
    return resolved.matches && resolved.targetOwner.kind === 'personal';
  } catch {
    return false;
  }
}

async function sameOwnerTargetError(
  executionContext: string | undefined,
  target: ProjectOwnerTarget,
): Promise<string | null> {
  const caller = callerOwner(executionContext);
  const decision = await decideSameOwnerAccess(caller, target);
  switch (decision.kind) {
    case 'allowed':
      return null;
    case 'hidden':
      if (await isPersonalProjectLinkedToCaller(caller, target)) return null;
      return `Project \`${target.projectId}\` isn't available to this pipeline`;
    case 'caller_owner_unknown':
    case 'target_owner_unknown':
      return `Project \`${target.projectId}\` can't be checked right now. Try again.`;
  }
}

/**
 * Refuse a `run-pipeline` worktree target another owner holds. The message
 * names only the ID the author wrote. Not flag-gated.
 */
export async function assertRunPipelineTargetOwner(args: {
  executionContext: string | undefined;
  target: PipelineOwnershipWorktreeTarget | ResolvedPipelineExecutionTarget;
}): Promise<void> {
  if (args.target.scope !== 'worktree') return;
  const error = await sameOwnerTargetError(args.executionContext, {
    projectId: args.target.workspace_id,
    worktreeId: args.target.worktree_id,
  });
  if (error !== null) throw new Error(error);
}

function isLiteral(value: string): boolean {
  return !value.includes('${{');
}

/**
 * Check the literal `run-pipeline` worktree targets of a pipeline that can
 * run globally against the owner it is saved in. A project-scoped pipeline
 * takes its target project's owner at run time, so it is not checked here.
 * Returns the first refusal, or `null`.
 */
export async function validatePipelineOwnerTargetsOnSave(
  pipeline: Pipeline,
  ownerContext: string,
): Promise<string | null> {
  let normalized: ReturnType<typeof normalizePipeline>;
  try {
    normalized = normalizePipeline(pipeline);
  } catch {
    // Invalid pipelines are refused by the store's own validation.
    return null;
  }
  if (!normalized.scope.includes('global')) return null;
  for (const job of Object.values(normalized.jobs)) {
    for (const step of job.steps) {
      const target = step.target;
      if (target?.scope !== 'worktree' || !isLiteral(target.workspace_id))
        continue;
      const worktreeId =
        'id' in target.worktree && isLiteral(target.worktree.id)
          ? target.worktree.id
          : undefined;
      const error = await sameOwnerTargetError(ownerContext, {
        projectId: target.workspace_id,
        ...(worktreeId ? { worktreeId } : {}),
      });
      if (error !== null) return error;
    }
  }
  return null;
}

export function createDesktopPipelineOwnershipPort(): PipelineOwnershipPort {
  return {
    authorizeTarget: assertRunPipelineTargetOwner,
    readAgentAuthor: (locator) =>
      readPipelineLocalMetadata(locator).agentAuthor,
  };
}

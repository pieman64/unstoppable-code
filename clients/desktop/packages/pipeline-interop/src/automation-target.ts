import {
  impliedTargetContexts,
  intersectTargetContexts,
  validateSharedAutomationTargetRequirement,
  type AutomationPipelineTargetKind,
  type SharedAutomationActionType,
  type SharedAutomationTargetRequirement,
  type TargetContext,
} from '@canopy/protocol/automations';
import { executionContextSatisfies, normalizePipelineScopes } from './scope';
import type { PipelineExecutionScope } from '@canopy/protocol/pipelines';

/** Resolved means a successfully parsed, verified execution definition. */
export type AutomationPipelineResolution =
  | { status: 'resolved'; scopes: unknown }
  | { status: 'pending' }
  | { status: 'error'; error: string };

export type AutomationTargetResolution =
  | { status: 'resolved'; contexts: TargetContext[] }
  | { status: 'pending'; contexts: TargetContext[] }
  | { status: 'error'; contexts: TargetContext[]; error: string };

export type AutomationDestinationKind = AutomationPipelineTargetKind;
export type AutomationDestinationProjectKind =
  | 'cowork'
  | 'single-repo'
  | 'multi-repo';

export const PIPELINE_TARGET_NO_PROJECT_SCOPE_ERROR =
  "This workflow can't run without a project. Choose a workflow that runs with no project, or choose a project.";
export const PIPELINE_TARGET_REQUIREMENT_GLOBAL_ERROR =
  "A workflow automation with no project can't limit where it runs. Remove the run restriction or choose a project.";

/**
 * The execution scope a pipeline automation run needs. `undefined` is a
 * legacy action with no target: a worktree on a code project, the project
 * folder on a cowork project.
 */
export function automationDestinationExecutionScope(
  destination: AutomationDestinationKind | undefined,
  projectKind: AutomationDestinationProjectKind | undefined,
): PipelineExecutionScope {
  switch (destination) {
    case 'global':
      return 'global';
    case 'project':
      return 'directory';
    case 'new_worktree':
      return 'worktree';
    case 'task':
    case undefined:
      return projectKind === 'cowork' ? 'directory' : 'worktree';
  }
}

/**
 * Whether verified pipeline scopes admit a destination. Keeps the
 * directory-in-worktree rule of {@link executionContextSatisfies}; a new
 * worktree each run never applies to a cowork project.
 */
export function pipelineSupportsAutomationDestination(
  scopes: readonly PipelineExecutionScope[],
  destination: AutomationDestinationKind | undefined,
  projectKind: AutomationDestinationProjectKind | undefined,
): boolean {
  if (destination === 'new_worktree' && projectKind === 'cowork') return false;
  return executionContextSatisfies(
    scopes,
    automationDestinationExecutionScope(destination, projectKind),
  );
}

function globalTargetRequirement(
  requirement: SharedAutomationTargetRequirement | undefined,
  pipeline: AutomationPipelineResolution | undefined,
): AutomationTargetResolution {
  if (requirement !== undefined)
    return {
      status: 'error',
      contexts: [],
      error: PIPELINE_TARGET_REQUIREMENT_GLOBAL_ERROR,
    };
  if (!pipeline || pipeline.status === 'pending')
    return { status: 'pending', contexts: [] };
  if (pipeline.status === 'error') return { ...pipeline, contexts: [] };
  try {
    return pipelineSupportsAutomationDestination(
      normalizePipelineScopes(pipeline.scopes, 'Pipeline'),
      'global',
      undefined,
    )
      ? { status: 'resolved', contexts: [] }
      : {
          status: 'error',
          contexts: [],
          error: PIPELINE_TARGET_NO_PROJECT_SCOPE_ERROR,
        };
  } catch (error) {
    return {
      status: 'error',
      contexts: [],
      error:
        error instanceof Error
          ? error.message
          : 'Workflow scopes could not be verified.',
    };
  }
}

/** Project contexts where verified scopes admit an explicit destination. */
function destinationTargetContexts(
  scopes: readonly PipelineExecutionScope[],
  destination: AutomationDestinationKind | undefined,
): TargetContext[] {
  if (destination === undefined) return pipelineScopeTargetContexts(scopes);
  const contexts: TargetContext[] = [];
  if (pipelineSupportsAutomationDestination(scopes, destination, 'cowork'))
    contexts.push('cowork');
  if (pipelineSupportsAutomationDestination(scopes, destination, 'single-repo'))
    contexts.push('worktree');
  return contexts;
}

export function pipelineScopeTargetContexts(
  scopes: readonly PipelineExecutionScope[],
): TargetContext[] {
  const contexts: TargetContext[] = [];
  if (executionContextSatisfies(scopes, 'directory')) contexts.push('cowork');
  if (executionContextSatisfies(scopes, 'worktree')) contexts.push('worktree');
  return contexts;
}

/**
 * Contexts an automation may run in. `destination` applies to
 * `worktree_pipeline` only; omitted keeps the legacy rules. A `global`
 * destination resolves with no contexts: callers check the destination
 * before reading an empty list as "nowhere to run".
 */
export function resolveAutomationTargetRequirement(
  action: SharedAutomationActionType,
  requirement?: SharedAutomationTargetRequirement,
  pipeline?: AutomationPipelineResolution,
  destination?: AutomationDestinationKind,
): AutomationTargetResolution {
  if (action === 'worktree_pipeline' && destination === 'global')
    return globalTargetRequirement(requirement, pipeline);
  const implied = impliedTargetContexts(action);
  if (requirement !== undefined) {
    const validated = validateSharedAutomationTargetRequirement(
      requirement,
      action,
    );
    if (!validated.ok)
      return { status: 'error', contexts: [], error: validated.error };
  }
  const contexts = intersectTargetContexts(
    implied,
    requirement?.contexts ?? implied,
    // Cowork projects never create a worktree each run.
    destination === 'new_worktree' ? ['worktree'] : implied,
  );
  if (action !== 'worktree_pipeline') return { status: 'resolved', contexts };
  if (!pipeline || pipeline.status === 'pending')
    return { status: 'pending', contexts };
  if (pipeline.status === 'error') return { ...pipeline, contexts };
  try {
    const effective = intersectTargetContexts(
      contexts,
      destinationTargetContexts(
        normalizePipelineScopes(pipeline.scopes, 'Pipeline'),
        destination,
      ),
    );
    return effective.length > 0
      ? { status: 'resolved', contexts: effective }
      : {
          status: 'error',
          contexts: [],
          error:
            'This workflow has no compatible automation target. Choose another workflow or edit its target requirement.',
        };
  } catch (error) {
    return {
      status: 'error',
      contexts,
      error:
        error instanceof Error
          ? error.message
          : 'Workflow scopes could not be verified.',
    };
  }
}

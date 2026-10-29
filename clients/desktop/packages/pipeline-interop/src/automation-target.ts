import {
  impliedTargetContexts,
  intersectTargetContexts,
  validateSharedAutomationTargetRequirement,
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

export function pipelineScopeTargetContexts(
  scopes: readonly PipelineExecutionScope[],
): TargetContext[] {
  const contexts: TargetContext[] = [];
  if (executionContextSatisfies(scopes, 'directory')) contexts.push('cowork');
  if (executionContextSatisfies(scopes, 'worktree')) contexts.push('worktree');
  return contexts;
}

export function resolveAutomationTargetRequirement(
  action: SharedAutomationActionType,
  requirement?: SharedAutomationTargetRequirement,
  pipeline?: AutomationPipelineResolution,
): AutomationTargetResolution {
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
  );
  if (action !== 'worktree_pipeline') return { status: 'resolved', contexts };
  if (!pipeline || pipeline.status === 'pending')
    return { status: 'pending', contexts };
  if (pipeline.status === 'error') return { ...pipeline, contexts };
  try {
    const effective = intersectTargetContexts(
      contexts,
      pipelineScopeTargetContexts(
        normalizePipelineScopes(pipeline.scopes, 'Pipeline'),
      ),
    );
    return effective.length > 0
      ? { status: 'resolved', contexts: effective }
      : {
          status: 'error',
          contexts: [],
          error:
            'This pipeline has no compatible automation target. Choose another pipeline or edit its target requirement.',
        };
  } catch (error) {
    return {
      status: 'error',
      contexts,
      error:
        error instanceof Error
          ? error.message
          : 'Pipeline scopes could not be verified.',
    };
  }
}

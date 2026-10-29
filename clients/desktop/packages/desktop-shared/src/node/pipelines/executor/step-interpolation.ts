import type { NormalizedStep } from './types';
import type { buildExpressionContext } from './execution-context';
import { interpolateExpression } from './expression-evaluator';
import type {
  PipelineRunTarget,
  PipelineScalar,
} from '@canopy/desktop-shared/types/pipeline';

type ExpressionContext = ReturnType<typeof buildExpressionContext>;

function interpolateScalars(
  values: Record<string, PipelineScalar>,
  context: ExpressionContext,
): Record<string, PipelineScalar> {
  const result: Record<string, PipelineScalar> = {};
  for (const [key, value] of Object.entries(values)) {
    result[key] =
      typeof value === 'string' ? interpolateExpression(value, context) : value;
  }
  return result;
}

function interpolateTarget(
  target: PipelineRunTarget | undefined,
  context: ExpressionContext,
): PipelineRunTarget | undefined {
  if (!target) {
    return undefined;
  }
  if (target.scope === 'directory') {
    return target.path
      ? {
          scope: 'directory',
          path: interpolateExpression(target.path, context),
        }
      : target;
  }
  if (target.scope !== 'worktree') {
    return target;
  }

  const interpolated = {
    ...target,
    workspace_id: interpolateExpression(target.workspace_id, context),
    worktree: {
      id: interpolateExpression(target.worktree.id, context),
    },
  };

  return interpolated;
}

export function interpolateNormalizedStep(
  step: NormalizedStep,
  context: ExpressionContext,
): NormalizedStep {
  const interpolated: NormalizedStep = { ...step };

  if (interpolated.run) {
    interpolated.run = interpolateExpression(interpolated.run, context);
  }

  if (interpolated.env) {
    interpolated.env = interpolateScalars(interpolated.env, context);
  }

  if (interpolated.with) {
    interpolated.with = interpolateScalars(interpolated.with, context);
  }

  interpolated.target = interpolateTarget(interpolated.target, context);

  return interpolated;
}

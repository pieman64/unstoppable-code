import type { Step } from '@canopy/execution-engine/types/pipeline';
import type { PipelineStepKind } from '@canopy/ui-app';

/** A step's kind is neutral; an incomplete step needs attention. */
export function stepKind(step: Step): PipelineStepKind {
  if (step.uses) return 'action';
  if (step.run) return 'script';
  return 'incomplete';
}

export function stepSummary(step: Step): string {
  if (step.uses) return step.uses;
  if (step.run) return step.run.split('\n')[0] ?? '';
  return 'Not configured';
}

export function stepLabel(step: Step, stepIndex: number): string {
  return step.name || step.id || `Step ${stepIndex + 1}`;
}

import type { Pipeline } from '../types/pipeline';
import { parsePipelineText } from '../pipelines/parse-pipeline';

export const AGENT_PIPELINE_RUN_STEP_POLICY_ERROR =
  'Agent-authored pipeline definitions cannot include shell run steps. Use an existing trusted action through uses, or configure shell pipelines manually in the pipeline editor.';

const AGENT_PIPELINE_INLINE_CHILD_POLICY_ERROR =
  'Agent-authored inline child pipeline definitions must contain valid pipeline YAML.';
const AGENT_PIPELINE_MAX_INLINE_DEPTH = 8;
const AGENT_PIPELINE_INLINE_DEPTH_POLICY_ERROR = `Agent-authored inline child pipelines cannot exceed ${AGENT_PIPELINE_MAX_INLINE_DEPTH} nesting levels.`;

function validatePipeline(
  content: Pipeline,
  depth: number,
  visitedPipelines: WeakSet<object>,
  visitedInlineYaml: Set<string>,
): string | null {
  if (visitedPipelines.has(content)) return null;
  visitedPipelines.add(content);

  for (const job of Object.values(content.jobs)) {
    for (const step of job.steps) {
      if (step.run !== undefined) {
        return AGENT_PIPELINE_RUN_STEP_POLICY_ERROR;
      }
      if (step.uses !== 'builtin/run-pipeline') continue;

      const referencedPipeline = step.with?.pipeline;
      if (typeof referencedPipeline === 'string' && referencedPipeline.trim()) {
        return AGENT_PIPELINE_RUN_STEP_POLICY_ERROR;
      }

      const inlineYaml = step.with?.pipeline_yaml;
      if (typeof inlineYaml !== 'string' || !inlineYaml.trim()) continue;
      if (visitedInlineYaml.has(inlineYaml)) continue;
      if (depth >= AGENT_PIPELINE_MAX_INLINE_DEPTH) {
        return AGENT_PIPELINE_INLINE_DEPTH_POLICY_ERROR;
      }
      visitedInlineYaml.add(inlineYaml);

      let child: Pipeline;
      try {
        child = parsePipelineText(inlineYaml);
      } catch {
        return AGENT_PIPELINE_INLINE_CHILD_POLICY_ERROR;
      }
      const childError = validatePipeline(
        child,
        depth + 1,
        visitedPipelines,
        visitedInlineYaml,
      );
      if (childError) return childError;
    }
  }
  return null;
}

/**
 * Pure policy for pipeline definitions supplied through agent-facing actions.
 * Trusted stored definitions remain runnable; only agent-authored YAML is
 * restricted to declarative action steps.
 */
export function validateAgentPipelineMutationPolicy(
  content: Pipeline,
): string | null {
  return validatePipeline(content, 0, new WeakSet(), new Set());
}

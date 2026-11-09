import type { Pipeline } from '@canopy/execution-engine/types/pipeline';
import { parsePipelineText } from '../pipelines/parse-pipeline';
import { SEND_AGENT_MESSAGE_AUTHORITY_INPUTS } from '../pipelines/host-send-agent-message';

export const AGENT_PIPELINE_RUN_STEP_POLICY_ERROR =
  'Agent-authored pipeline definitions cannot include shell run steps. Use an existing trusted action through uses, or configure shell pipelines manually in the pipeline editor.';

/**
 * D11 at save time: an agent-authored `send-agent-message` step that names a
 * chat can't change its settings or bring plugins through its references.
 * Run time refuses the same through the shared input list.
 */
export const AGENT_PIPELINE_SESSION_AUTHORITY_POLICY_ERROR =
  "Agent-authored pipelines cannot change an existing chat's model, plan mode, approval mode, or plugins.";

const AGENT_PIPELINE_INLINE_CHILD_POLICY_ERROR =
  'Agent-authored inline child pipeline definitions must contain valid pipeline YAML.';
const AGENT_PIPELINE_MAX_INLINE_DEPTH = 8;
const AGENT_PIPELINE_INLINE_DEPTH_POLICY_ERROR = `Agent-authored inline child pipelines cannot exceed ${AGENT_PIPELINE_MAX_INLINE_DEPTH} nesting levels.`;

/** A `with` value that is set: a non-blank string (literal or expression) or any other scalar. */
function isSetInput(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  return value !== undefined && value !== null;
}

function hasPluginReference(entries: unknown[]): boolean {
  return entries.some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'kind' in entry &&
      entry.kind === 'plugin',
  );
}

/**
 * `text_references` that may bring plugins: an expression (unknown until run
 * time, so it fails closed) or a list with a plugin entry. Unparseable JSON is
 * left to run-time validation.
 */
function mayReferencePlugins(value: unknown): boolean {
  if (Array.isArray(value)) return hasPluginReference(value);
  if (typeof value !== 'string' || !value.trim()) return false;
  if (value.includes('${{')) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  return Array.isArray(parsed) && hasPluginReference(parsed);
}

/**
 * A `builtin/…` ref's action path as the resolver reaches it: it trims the
 * part after `builtin/` and resolves it, so `./`, `..` and a trailing slash
 * (or a Windows backslash) name the same action.
 */
function builtinActionPath(uses: string): string | undefined {
  const [scope, ...parts] = uses.split('/');
  if (scope !== 'builtin') return undefined;
  const segments: string[] = [];
  for (const segment of parts.join('/').trim().split(/[\\/]/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

function changesChatAuthority(
  inputs: Record<string, unknown> | undefined,
): boolean {
  if (!inputs || !isSetInput(inputs.chat_id)) return false;
  return (
    SEND_AGENT_MESSAGE_AUTHORITY_INPUTS.some((name) =>
      isSetInput(inputs[name]),
    ) || mayReferencePlugins(inputs.text_references)
  );
}

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
      const actionPath =
        step.uses !== undefined ? builtinActionPath(step.uses) : undefined;
      if (
        actionPath === 'send-agent-message' &&
        changesChatAuthority(step.with)
      ) {
        return AGENT_PIPELINE_SESSION_AUTHORITY_POLICY_ERROR;
      }
      // Normalized too, so an inline child can't hide the step above.
      if (actionPath !== 'run-pipeline') continue;

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

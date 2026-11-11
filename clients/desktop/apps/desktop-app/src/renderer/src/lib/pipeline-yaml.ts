import * as yaml from 'js-yaml';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import type { Pipeline } from '@canopy/execution-engine/types/pipeline';
import { getDraftValidation } from './pipelineEditor';

/**
 * Shared Pipeline↔YAML helpers used by both the raw-YAML editor
 * (`usePipelineEditorSession`) and the renderer live-edit bridge
 * (`PipelineEditorRuntimeBridge`). Kept in a plain lib module (rather than
 * exported from the editor component) so the bridge can import them without
 * pulling in a React component and so neither file trips the
 * `react-refresh/only-export-components` rule.
 */

/**
 * Serialize a `Pipeline` to the canonical document YAML (`{ pipeline }`) using
 * the same `js-yaml` options the editor persists with.
 */
export function serializePipelineToYaml(pipeline: Pipeline): string {
  return yaml.dump({ pipeline }, { lineWidth: 120, noRefs: true });
}

/**
 * Parse YAML text and validate the resulting pipeline.
 * Returns the parsed Pipeline on success, or an error string on failure.
 */
export function tryParseAndValidateYaml(
  text: string,
): { success: true; pipeline: Pipeline } | { success: false; error: string } {
  let parsed: Pipeline;
  try {
    parsed = parsePipelineText(text);
  } catch (err: unknown) {
    return {
      success: false,
      error: `Invalid workflow definition: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { success: false, error: 'YAML must define a workflow object' };
  }

  if (!parsed.jobs || typeof parsed.jobs !== 'object') {
    return { success: false, error: 'Workflow must define a "jobs" object' };
  }

  const issues = getDraftValidation(parsed);
  const errors = issues.filter((v) => v.type === 'error');
  if (errors.length > 0) {
    const messages = errors.map((e) => `${e.path}: ${e.message}`);
    return { success: false, error: messages.join('\n') };
  }

  return { success: true, pipeline: parsed };
}

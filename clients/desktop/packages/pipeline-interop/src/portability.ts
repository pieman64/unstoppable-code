import { isPortablePipelineTriggerType } from '@canopy/protocol/pipelines';
import {
  getTriggerTypes,
  type Pipeline,
  type PipelineTrigger,
} from './document';
import { parsePipelineText } from './parse-pipeline';

/** Why a definition that declares `workflow` is refused on its way out. */
export const LOCAL_ONLY_PIPELINE_TRIGGER_MESSAGE =
  "Workflows with a Workflow trigger can't be shared yet.";

/**
 * How deep inline child pipelines are followed. A pipeline with inline
 * children deeper than this is treated as local-only: it fails closed rather
 * than leaving an unchecked child on its way out.
 */
const MAX_INLINE_CHILD_DEPTH = 8;

/**
 * Whether a trigger value names a trigger that must not leave this machine.
 * `workflow` is readable and runnable locally, but released desktops and web
 * can't store it yet (CAN-5782).
 */
export function declaresLocalOnlyPipelineTrigger(
  trigger: PipelineTrigger | undefined | null,
): boolean {
  return getTriggerTypes(trigger).some(
    (type) => !isPortablePipelineTriggerType(type),
  );
}

/**
 * Whether a pipeline, or any literal inline child it runs through
 * `with.pipeline_yaml`, declares a local-only trigger.
 * Every path that carries a definition off this machine (shares, automation
 * shares, capability packages and their child pipelines) refuses one, even
 * beside other triggers. Child pipelines referenced by id or path are files
 * of their own, checked where they are packaged.
 */
export function pipelineDeclaresLocalOnlyTrigger(
  pipeline: Pipeline,
  depth = 0,
): boolean {
  if (declaresLocalOnlyPipelineTrigger(pipeline.on)) return true;
  for (const job of Object.values(pipeline.jobs)) {
    // Raw text is parsed, not normalized, so a job may lack its steps.
    if (!Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      // Every literal `with.pipeline_yaml` is checked, whatever `uses` says:
      // aliases such as `builtin/./run-pipeline` resolve to the same action,
      // and a stray match only over-refuses.
      const inline = step.with?.pipeline_yaml;
      if (typeof inline !== 'string') continue;
      // Too deep to check: refuse rather than share an unchecked child.
      if (depth >= MAX_INLINE_CHILD_DEPTH) return true;
      let child: Pipeline;
      try {
        child = parsePipelineText(inline);
      } catch {
        continue;
      }
      if (pipelineDeclaresLocalOnlyTrigger(child, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * {@link pipelineDeclaresLocalOnlyTrigger} for raw YAML or JSON. Text that
 * does not parse is left to the caller's own validation and reads as false.
 */
export function rawPipelineDeclaresLocalOnlyTrigger(raw: string): boolean {
  let pipeline: Pipeline;
  try {
    pipeline = parsePipelineText(raw);
  } catch {
    return false;
  }
  return pipelineDeclaresLocalOnlyTrigger(pipeline);
}

import type { PipelineSenderSource } from './sender-context';

/**
 * Whether a pipeline send belongs to an automation's run: the automation's
 * own send, or a step in a run it started (CAN-4551). Both come from trusted
 * fields, never step inputs.
 */
export function isAutomationRunSource(source: PipelineSenderSource): boolean {
  return source.kind === 'automation' || source.automation !== undefined;
}

/**
 * The chat automation pipelines Labs experiment (CAN-4551, 7b): while it is
 * on, a person's save of a convertible chat automation stores it as a
 * pipeline it owns; while it is off, saving converts it back. Reads never
 * depend on it.
 */
import type { LabsExperimentsSnapshot } from '@canopy/desktop-shared/lib/labs-experiments';

export const CHAT_AUTOMATION_PIPELINES_EXPERIMENT_ID =
  'chat-automation-pipelines';

/** Main's evaluation; an unready or missing one is off, so saves stay native. */
export function chatAutomationPipelinesEnabledIn(
  snapshot: Pick<LabsExperimentsSnapshot, 'ready' | 'experiments'>,
): boolean {
  return (
    snapshot.ready &&
    snapshot.experiments.some(
      (entry) =>
        entry.id === CHAT_AUTOMATION_PIPELINES_EXPERIMENT_ID && entry.enabled,
    )
  );
}

export async function chatAutomationPipelinesEnabled(): Promise<boolean> {
  const { getLabsExperimentsService } =
    await import('../services/labs-experiments-runtime');
  return chatAutomationPipelinesEnabledIn(
    getLabsExperimentsService().getSnapshot(),
  );
}

import { CUSTOMIZE_LABEL } from '@canopy/protocol/ui-labels';
import type {
  PipelineReturnTarget,
  PluginsNavigationIntent,
} from '@/stores/navigationStore';
import type { WorkflowEditTarget } from './edit-target';

/** Where the edit shell's Back goes from one target. */
export type WorkflowEditBackResolution =
  | { kind: 'edit'; target: WorkflowEditTarget }
  | { kind: 'library' }
  | { kind: 'plugins'; intent: PluginsNavigationIntent };

/** The pipeline a "Similar pipelines" recommendation was opened from. */
function pipelineTargetFromReturn(
  origin: PipelineReturnTarget,
): WorkflowEditTarget {
  return {
    kind: 'pipeline',
    pipelineId: origin.pipelineId,
    ...(origin.cwd !== undefined ? { cwd: origin.cwd } : {}),
    ...(origin.filePath !== undefined ? { filePath: origin.filePath } : {}),
    ...(origin.source !== undefined ? { source: origin.source } : {}),
    ...(origin.sharedRemoteId !== undefined
      ? { sharedRemoteId: origin.sharedRemoteId }
      : {}),
    ...(origin.returnToEntryId !== undefined
      ? { returnToEntryId: origin.returnToEntryId }
      : {}),
    ...(origin.returnToEntryContext !== undefined
      ? { returnToEntryContext: origin.returnToEntryContext }
      : {}),
    ...(origin.returnToPipeline !== undefined
      ? { returnToPipeline: origin.returnToPipeline }
      : {}),
    ...(origin.returnToMarketplace !== undefined
      ? { returnToMarketplace: origin.returnToMarketplace }
      : {}),
  };
}

/**
 * Resolves Back for the shell (CAN-4072), one level at a time. An explicit
 * `returnTo` wins. A pipeline then falls back to the cross-page origins the
 * pipeline editor's Back restored before the shell (CAN-2382): the source
 * pipeline with its own origin, the capability detail with its stack, a
 * single capability detail, or Customize search. Everything else returns
 * to the Library.
 */
export function resolveWorkflowEditBack(
  target: WorkflowEditTarget,
): WorkflowEditBackResolution {
  if (target.returnTo !== undefined) {
    return { kind: 'edit', target: target.returnTo };
  }
  if (target.kind !== 'pipeline') return { kind: 'library' };
  const {
    returnToPipeline,
    returnToEntryContext,
    returnToEntryId,
    returnToMarketplace,
  } = target;
  if (returnToPipeline) {
    return { kind: 'edit', target: pipelineTargetFromReturn(returnToPipeline) };
  }
  if (returnToEntryContext) {
    return {
      kind: 'plugins',
      intent: {
        kind: 'entry-detail',
        entryId: returnToEntryContext.entryId,
        from: {
          kind: 'entry-context',
          stack: returnToEntryContext.stack,
          pipelineReturn: returnToEntryContext.pipelineReturn,
          fromInstalled: returnToEntryContext.fromInstalled,
          managementReturn: returnToEntryContext.managementReturn,
          marketplace: returnToEntryContext.marketplace,
        },
      },
    };
  }
  if (returnToEntryId) {
    return {
      kind: 'plugins',
      intent: { kind: 'entry-detail', entryId: returnToEntryId },
    };
  }
  if (returnToMarketplace) {
    return {
      kind: 'plugins',
      intent: { kind: 'marketplace-browse', ...returnToMarketplace },
    };
  }
  return { kind: 'library' };
}

/** Short label for the shell's Back, naming where it goes. */
export function workflowEditBackLabel(target: WorkflowEditTarget): string {
  const back = resolveWorkflowEditBack(target);
  switch (back.kind) {
    case 'library':
      return 'Library';
    case 'plugins':
      return CUSTOMIZE_LABEL;
    case 'edit':
      return back.target.kind === 'pipeline' ? 'Pipeline' : 'Automation';
  }
}

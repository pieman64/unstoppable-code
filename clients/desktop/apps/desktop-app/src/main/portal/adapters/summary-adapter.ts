import type {
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
} from '@canopy/desktop-shared/types';
import { refreshWorktreeSummary } from '../../services/worktree-summary-service';
import type { PortalAdapterContext } from './types';
import { isRecord } from './validation';

export function handlePortalSummaryRefresh(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.summary.refresh']
  >,
  context: PortalAdapterContext,
): void {
  if (
    !isRecord(command.payload) ||
    typeof command.payload.projectId !== 'string' ||
    typeof command.payload.worktreeId !== 'string'
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid summary refresh payload.',
    );
    return;
  }

  try {
    refreshWorktreeSummary(
      command.payload.projectId,
      command.payload.worktreeId,
      context.getWindow,
    );
    // Unlike the synchronous PR refresh precedents (#1936/#1962), summary
    // generation is long-running LLM work. ACK the bounded trigger now; the
    // resulting worktree_summary delta reports progress/result asynchronously.
    context.complete(command);
  } catch (error) {
    context.fail(
      command,
      'invalid_payload',
      error instanceof Error ? error.message : String(error),
    );
  }
}

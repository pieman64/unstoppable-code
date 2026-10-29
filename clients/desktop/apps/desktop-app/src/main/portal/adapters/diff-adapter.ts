import type {
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
  PortalDiffSnapshotPayload,
} from '@canopy/desktop-shared/types';
import { PORTAL_DIFF_COMBINED_FILE_PATH } from '@canopy/desktop-shared/types';
import { readDiff } from '../../services/diff-service';
import { createPortalEvent } from '../portal-event-bus';
import type { PortalAdapterContext } from './types';
import { failServiceError, isRecord } from './validation';

export async function handlePortalDiffRead(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.diff.read']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid diff read payload.');
    return;
  }
  try {
    const diff = await readDiff(command.payload);
    const snapshot: PortalDiffSnapshotPayload = {
      workspaceLocalId: diff.workspaceLocalId,
      worktreeLocalId: diff.worktreeLocalId,
      filePath: diff.filePath ?? PORTAL_DIFF_COMBINED_FILE_PATH,
      ...(command.payload.repoId ? { repoId: command.payload.repoId } : {}),
      files: diff.files,
      patch: diff.patch ?? '',
      ...(diff.rangeLabel ? { rangeLabel: diff.rangeLabel } : {}),
    };
    context.enqueueEvent(
      createPortalEvent('portal.diff.snapshot', snapshot, {
        commandId: command.id,
      }),
    );
    context.complete(command, diff);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

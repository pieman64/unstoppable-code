import type {
  PortalChangedFile,
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
  PortalDiffPayload,
  PortalDiffSnapshotPayload,
} from '@canopy/desktop-shared/types';
import { PORTAL_DIFF_COMBINED_FILE_PATH } from '@canopy/desktop-shared/types';
import { PORTAL_EVENT_BATCH_MAX_BYTES } from '@canopy/protocol/portal';
import { readDiff } from '../../services/diff-service';
import { sortChangedFiles } from '../changed-files-paging';
import {
  createCommandCompletedPayload,
  createPortalEvent,
} from '../portal-event-bus';
import { portalEventMaxRoutedByteLength } from '../portal-outbox';
import type { PortalAdapterContext } from './types';
import { failServiceError, isRecord } from './validation';

const DIFF_EVENT_BUDGET = PORTAL_EVENT_BATCH_MAX_BYTES - 4096;

interface DiffEvents {
  readonly snapshot: PortalDiffSnapshotPayload;
  readonly result: PortalDiffPayload;
}

/**
 * `readDiff` returns the full changed-files roster even for one file. Both the
 * snapshot and the completion carry it in single unsplittable events, so cut
 * the roster (keeping the selected file, then sorted order) to fit the batch
 * cap and mark it `truncated`. The patch itself is never cut here.
 */
export function boundDiffRoster(
  build: (files: PortalChangedFile[], truncated: boolean) => DiffEvents,
  files: PortalChangedFile[],
  selected: { readonly filePath?: string; readonly repoId?: string },
  measure: (events: DiffEvents) => number,
): DiffEvents {
  const full = build(files, false);
  if (measure(full) <= DIFF_EVENT_BUDGET) return full;

  const isSelected = (file: PortalChangedFile): boolean =>
    file.filePath === selected.filePath &&
    (selected.repoId === undefined ||
      file.repoId === undefined ||
      file.repoId === selected.repoId);
  const kept = files.filter(isSelected);
  const rest = sortChangedFiles(files.filter((file) => !isSelected(file)));
  // Largest prefix of `rest` that still fits; measuring is linear, so search.
  let low = 0;
  let high = rest.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = build([...kept, ...rest.slice(0, mid)], true);
    if (measure(candidate) <= DIFF_EVENT_BUDGET) low = mid;
    else high = mid - 1;
  }
  return build([...kept, ...rest.slice(0, low)], true);
}

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
    const repoId = command.payload.repoId;
    const build = (
      files: PortalChangedFile[],
      truncated: boolean,
    ): DiffEvents => ({
      snapshot: {
        workspaceLocalId: diff.workspaceLocalId,
        worktreeLocalId: diff.worktreeLocalId,
        filePath: diff.filePath ?? PORTAL_DIFF_COMBINED_FILE_PATH,
        ...(repoId ? { repoId } : {}),
        files,
        patch: diff.patch ?? '',
        ...(diff.rangeLabel ? { rangeLabel: diff.rangeLabel } : {}),
        ...(truncated ? { truncated } : {}),
      },
      result: { ...diff, files, ...(truncated ? { truncated } : {}) },
    });
    const measure = (events: DiffEvents): number =>
      Math.max(
        portalEventMaxRoutedByteLength(
          createPortalEvent('portal.diff.snapshot', events.snapshot, {
            commandId: command.id,
          }),
        ),
        portalEventMaxRoutedByteLength(
          createPortalEvent(
            'portal.command.completed',
            createCommandCompletedPayload(command, events.result),
            { commandId: command.id },
          ),
        ),
      );
    const bounded = boundDiffRoster(
      build,
      diff.files,
      { filePath: diff.filePath, ...(repoId ? { repoId } : {}) },
      measure,
    );
    context.enqueueEvent(
      createPortalEvent('portal.diff.snapshot', bounded.snapshot, {
        commandId: command.id,
      }),
    );
    context.complete(command, bounded.result);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

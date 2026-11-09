import { safeErrorProperty } from '@canopy/desktop-shared/ipc/app-error-rejection';
import {
  CoworkFolderMissingSchema,
  readCoworkFolderMissing,
  type CoworkFolderMissing,
} from '@canopy/protocol/canopy-core/core';

/** Recovery is explicit carrier data, never inferred from the displayed sentence.
 * The bridge lookup is scoped to this submission's project and used only for
 * presentation; the backend independently validates every write and cleanup. */
export function resolveCoworkFolderMissing(
  error: unknown,
  workspaceId: string,
): CoworkFolderMissing | undefined {
  const direct = readCoworkFolderMissing(error);
  if (direct?.workspaceId === workspaceId) return direct;
  const message = safeErrorProperty(error, 'message');
  if (typeof message !== 'string') return undefined;
  const parsed = CoworkFolderMissingSchema.safeParse(
    window.appErrors?.resolveCoworkFolderMissing?.(message, workspaceId),
  );
  return parsed.success && parsed.data.workspaceId === workspaceId
    ? parsed.data
    : undefined;
}

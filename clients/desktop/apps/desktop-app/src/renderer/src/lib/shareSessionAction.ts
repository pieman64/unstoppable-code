import { extractIpcErrorMessage } from '@/lib/errors';
import type { CanopyApi } from '@canopy/desktop-shared/types';
import { useShareSessionStatusStore } from '@/stores/shareSessionStatusStore';

export interface ShareSessionActionTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export interface ShareSessionActionOptions {
  ownerDocument?: Document;
  exportSession?: NonNullable<CanopyApi['chat']['exportSession']>;
}

/**
 * Uploads a private, account-scoped, importable session snapshot export.
 * This is distinct from redacted synchronized run sharing.
 */
export async function shareSessionAction(
  { projectId, worktreeId, chatId }: ShareSessionActionTarget,
  options: ShareSessionActionOptions = {},
): Promise<void> {
  const statusStore = useShareSessionStatusStore.getState();
  const target = { projectId, worktreeId, chatId };
  const operationId = statusStore.begin(
    target,
    options.ownerDocument ?? document,
  );
  if (!options.exportSession && !window.api.chat.exportSession) {
    statusStore.fail(operationId, 'Session export is not available.');
    return;
  }

  try {
    // Checkpoint main's canonical state so the uploaded session includes the
    // newest committed messages.
    await window.api.chat.flushScope({ projectId, worktreeId });
    const response = options.exportSession
      ? await options.exportSession(target)
      : await window.api.chat.exportSession(target);
    statusStore.succeed(operationId, response);
  } catch (error: unknown) {
    statusStore.fail(operationId, extractIpcErrorMessage(error));
  }
}

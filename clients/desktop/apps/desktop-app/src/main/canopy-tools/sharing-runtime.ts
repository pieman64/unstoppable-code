import { randomUUID } from 'node:crypto';
import type {
  AppAdvisorAction,
  AppAdvisorActionResponse,
} from '@canopy/desktop-shared/types';
import { sharingOpenDialogSchema } from '@canopy/desktop-shared/lib/sharing-action-schema';
import { requestAppAdvisorRendererTool } from '../ipc/app-advisor';
import { mainWindowOnlyToolSurfaces } from './show-files-runtime';
import type { WorktreeActionRuntime } from './worktree-actions';

export async function openShareDialog(
  action: Extract<AppAdvisorAction, { type: 'sharing.open_dialog' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const requestId = randomUUID();
  const parsed = sharingOpenDialogSchema.safeParse(action);
  if (!parsed.success)
    return {
      requestId,
      ok: false,
      error: { code: 'invalid_target', message: 'Invalid sharing target.' },
    };
  try {
    const response = await requestAppAdvisorRendererTool(
      {
        kind: 'dispatch_action',
        requestId,
        action: parsed.data,
        originWorktreeId: runtime.worktreeId,
        originChatTabId: runtime.chatId,
      },
      mainWindowOnlyToolSurfaces(runtime.getWindow),
    );
    return response.ok
      ? {
          ...response,
          result: {
            message: 'Share dialog requested; the user confirms in the app.',
          },
        }
      : response;
  } catch {
    return {
      requestId,
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Could not request sharing in the main app window.',
      },
    };
  }
}

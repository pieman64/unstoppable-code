import { randomUUID } from 'node:crypto';
import type {
  AppAdvisorAction,
  AppAdvisorActionResponse,
} from '@canopy/desktop-shared/types';
import { sharingOpenDialogSchema } from '@canopy/desktop-shared/lib/sharing-action-schema';
import {
  getSessionInterfaceToolRegistry,
  interfaceToolAudience,
} from '../agents/interface-tool-binding';
import { presentAppAdvisorAction } from '../app-advisor/presentation-tools';
import type { WorktreeActionRuntime } from './worktree-actions';

/**
 * CAN-5830: the share dialog is presentation, so it reaches the main window
 * only through its interface lease (`ui.app_advisor.present`), never through
 * a window accessor. A chat driven from another computer uses that
 * computer's interface lease.
 */
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
    const response = await presentAppAdvisorAction({
      action: parsed.data,
      requestId,
      destination: {
        projectId: runtime.projectId,
        worktreeId: runtime.worktreeId,
        chatId: runtime.chatId,
      },
      boundTools:
        getSessionInterfaceToolRegistry()?.availableFor(
          interfaceToolAudience(runtime.chatId),
        ) ?? [],
    });
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

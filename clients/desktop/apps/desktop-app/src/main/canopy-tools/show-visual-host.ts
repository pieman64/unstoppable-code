import type { StageVisualDocument } from '../lib/chat-visual-contracts';
import type { ShowVisualHost } from './show-visual-runtime';
import type { VisualMeasureResult } from '../browser/visual-preview-types';
import { stageVisualThroughCore } from './visual-core-client';

/**
 * The trusted ShowVisual host for one authenticated chat route. Scope, chat,
 * and working directory come from the session, never from tool arguments.
 * Staging goes through `core.chat.visual.stage`; measuring stays a main host
 * render capability (CAN-6040).
 */
export function createShowVisualHost(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  cwd: string;
}): ShowVisualHost {
  const scope = { projectId: target.projectId, worktreeId: target.worktreeId };
  return {
    scope,
    chatId: target.chatId,
    cwd: target.cwd,
    measureVisual: async (prepared, options): Promise<VisualMeasureResult> => {
      // Window code is loaded only when a visual reaches measurement.
      const { getVisualPreviewService } =
        await import('../browser/visual-preview-service');
      return getVisualPreviewService().measure({ prepared, ...options });
    },
    stageVisual: async (document: StageVisualDocument): Promise<void> => {
      await stageVisualThroughCore(
        { ...scope, chatId: target.chatId },
        document,
      );
    },
  };
}

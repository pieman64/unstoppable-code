import type {
  StageVisualDocument,
  VisualStagingSidecar,
} from '../lib/chat-visual-contracts';
import type { ShowVisualHost } from './show-visual-runtime';
import type { VisualMeasureResult } from '../browser/visual-preview-types';

/**
 * The trusted ShowVisual host for one authenticated chat route. Scope, chat,
 * and working directory come from the session, never from tool arguments, and
 * staging goes through the main-owned chat-state writer.
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
    stageVisual: async (
      document: StageVisualDocument,
    ): Promise<VisualStagingSidecar> => {
      // Loaded on first use so tool routes stay off the chat-state module graph.
      const { getChatStateService } =
        await import('../services/chat-state-service');
      return getChatStateService().stageVisual(
        scope,
        { chatId: target.chatId },
        document,
      );
    },
  };
}

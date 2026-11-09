import { CanopyOperationError } from '@canopy/core-runtime';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import type {
  CoreChatVisualStageParams,
  CoreChatVisualStageResult,
} from '@canopy/protocol/canopy-core';
import type {
  StageVisualDocument,
  VisualStagingSidecar,
} from '../lib/chat-visual-contracts';
import type { DesktopDomainAdapter } from './desktop-runtime';

/** The staging writer behind `core.chat.visual.stage`; the chat state service by default, tests inject one. */
export interface CoreChatVisualStageHost {
  stage(
    target: { projectId: string; worktreeId: string; chatId: string },
    document: StageVisualDocument,
  ): Promise<VisualStagingSidecar>;
}

const desktopVisualStageHost: CoreChatVisualStageHost = {
  stage: async (target, document) => {
    // Loaded on first use so the dispatcher stays off the chat-state graph.
    const { getChatStateService } =
      await import('../services/chat-state-service');
    return getChatStateService().stageVisual(
      { projectId: target.projectId, worktreeId: target.worktreeId },
      { chatId: target.chatId },
      document,
    );
  },
};

function documentOf(
  visual: CoreChatVisualStageParams['visual'],
): StageVisualDocument {
  return {
    visualId: visual.visualId,
    html: visual.html,
    title: visual.title,
    maxHeight: visual.maxHeight,
    ...(visual.heights ? { heights: visual.heights } : {}),
    ...(visual.codexCallId ? { codexCallId: visual.codexCallId } : {}),
  };
}

/**
 * `core.chat.visual.stage` on the desktop dispatcher (CAN-5996): writes a
 * prepared ShowVisual document into the recipient chat's transcript staging
 * through the chat state service, whose staging store re-checks the id, the
 * title, UTF-8 and the prepared-document limit.
 */
export function createCoreChatVisualStageAdapter(
  host: CoreChatVisualStageHost = desktopVisualStageHost,
): DesktopDomainAdapter {
  const stages = new KeyedOutcomes<CoreChatVisualStageResult>({
    reusedError: (): CanopyOperationError =>
      new CanopyOperationError({
        kind: 'conflict',
        message: 'This idempotency key was used with other parameters.',
        retry: { kind: 'never' },
      }),
  });
  return {
    instructions: {
      'core.chat.visual.stage': (params, context) =>
        stages.run(context, params, async () => {
          let sidecar: VisualStagingSidecar;
          try {
            sidecar = await host.stage(
              {
                projectId: params.recipient.workspaceId,
                worktreeId: params.recipient.worktreeId,
                chatId: params.recipient.chatId,
              },
              documentOf(params.visual),
            );
          } catch {
            throw new CanopyOperationError({
              kind: 'failed_precondition',
              code: 'core.chat.visual.stage.unavailable',
              message: 'The visual could not be staged for this chat.',
              retry: { kind: 'never' },
            });
          }
          return {
            visualId: sidecar.visualId,
            byteLength: sidecar.byteLength,
            sha256: sidecar.sha256,
          };
        }),
    },
  };
}

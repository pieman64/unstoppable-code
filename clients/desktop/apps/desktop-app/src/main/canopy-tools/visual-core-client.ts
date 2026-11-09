import {
  CORE_CHAT_VISUAL_STAGE_GRANTS,
  type CanopyCallerDescriptor,
  type CoreChatVisualStageResult,
} from '@canopy/protocol/canopy-core';
import type { StageVisualDocument } from '../lib/chat-visual-contracts';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { activeAgentCoreOperations } from './active-agent-core-operations';

/**
 * ShowVisual acts as its own principal with only the chat write grant
 * (CAN-5996). Kept private to this module: the grant reaches only
 * `core.chat.visual.stage`.
 */
const AGENT_VISUALS_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-agent-visuals',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'mcp',
  grants: [CORE_CHAT_VISUAL_STAGE_GRANTS.write],
};

/**
 * Stages a prepared visual into the session's chat. The key is the visual's
 * own id, which ShowVisual mints once per call, so a replayed dispatch stages
 * once.
 */
export async function stageVisualThroughCore(
  target: { projectId: string; worktreeId: string; chatId: string },
  document: StageVisualDocument,
): Promise<CoreChatVisualStageResult> {
  const idempotencyKey = `agent-visual-stage:${target.chatId}:${document.visualId}`;
  return activeAgentCoreOperations('visuals').instruction(
    'core.chat.visual.stage',
    {
      recipient: {
        workspaceId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
      },
      visual: {
        visualId: document.visualId,
        html: document.html,
        title: document.title,
        maxHeight: document.maxHeight,
        ...(document.heights
          ? {
              heights: document.heights.map(
                ([width, height]): [number, number] => [width, height],
              ),
            }
          : {}),
        ...(document.codexCallId ? { codexCallId: document.codexCallId } : {}),
      },
      _meta: { idempotencyKey },
    },
    { caller: AGENT_VISUALS_CALLER, metadata: { idempotencyKey } },
  );
}

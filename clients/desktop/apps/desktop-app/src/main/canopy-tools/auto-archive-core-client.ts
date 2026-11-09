import { createHash, randomUUID } from 'node:crypto';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { AGENT_AUTO_ARCHIVE_PRINCIPAL_ID } from '../canopy-runtime/auto-archive-principal-guard';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { activeAgentCoreOperations } from './active-agent-core-operations';

/**
 * SetAutoArchive acts as its own principal with only the chat write grant
 * (CAN-6014). Kept private to this module; the chat command handler refuses
 * this principal anything but the `autoArchive` setting.
 */
const AGENT_AUTO_ARCHIVE_CALLER: CanopyCallerDescriptor = {
  principalId: AGENT_AUTO_ARCHIVE_PRINCIPAL_ID,
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'mcp',
  grants: ['core.chat.write'],
};

/** Sets or clears the session's own chat's auto-archive marker through core. */
export async function setAutoArchiveThroughCore(
  chat: { projectId: string; worktreeId: string; chatId: string },
  enabled: boolean,
  call: { invocationId?: string } = {},
): Promise<void> {
  // Only the provider's invocation identity is stable across a call's
  // replays; without one every call gets its own key. Command ids are
  // safe ids, so the key is a digest.
  const commandId = `agent-auto-archive-${createHash('sha256')
    .update(JSON.stringify([chat.chatId, call.invocationId ?? randomUUID()]))
    .digest('hex')
    .slice(0, 40)}`;
  const result = await activeAgentCoreOperations('autoArchive').instruction(
    'core.chat.update',
    {
      projectId: chat.projectId,
      worktreeId: chat.worktreeId,
      commandId,
      action: {
        type: 'chat.patch_tab_settings',
        tabId: chat.chatId,
        patch: { autoArchive: enabled ? true : null },
      },
      _meta: { idempotencyKey: commandId },
    },
    {
      caller: AGENT_AUTO_ARCHIVE_CALLER,
      metadata: { idempotencyKey: commandId },
    },
  );
  if (result.outcome !== 'applied' && result.outcome !== 'already_applied')
    throw new Error(
      `The auto-archive setting was ${result.outcome}${result.reason ? `: ${result.reason}` : ''}.`,
    );
}

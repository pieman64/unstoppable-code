import type { ChatStateSnapshot } from '@canopy/desktop-shared/types';
import type {
  CoreChatSendReceiptParams,
  CoreChatSendReceiptResult,
} from '@canopy/protocol/canopy-core';
import type { ChatTranscriptPageRequest } from '@canopy/desktop-shared/types';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import type { CanopyQueryOptions } from '@canopy/core-runtime';
import { getActiveDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import type { PortalAdapterContext } from './types';

function portalReadOptions(context: PortalAdapterContext): CanopyQueryOptions {
  if (!context.sessionId || context.canReadAssets?.() !== true)
    throw new Error('Portal asset authorization is unavailable.');
  return {
    caller: {
      principalId: 'local-desktop-user',
      clientInstanceId: `portal-session:${context.sessionId}`,
      authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
      interfaceKind: 'portal' as const,
      grants: ['core.chat.read'],
    },
  };
}

export async function queryPortalChatTranscriptPage(
  context: PortalAdapterContext,
  request: ChatTranscriptPageRequest,
): Promise<TranscriptPage> {
  const { projectId, worktreeId, chatId, standaloneHistory, ...params } =
    request;
  const { legacyResult } =
    await getActiveDesktopRuntime().queryChatTranscriptPageForLegacyIpc(
      {
        ...params,
        ...(standaloneHistory ? { standaloneHistory: true as const } : {}),
        scope: { workspaceId: projectId, worktreeId, chatId },
      },
      portalReadOptions(context),
    );
  if (context.canReadAssets?.() !== true)
    throw new Error('Portal asset authorization was revoked.');
  return legacyResult;
}

export async function queryPortalChatSendReceipt(
  context: PortalAdapterContext,
  request: CoreChatSendReceiptParams,
): Promise<CoreChatSendReceiptResult> {
  const result = await getActiveDesktopRuntime().query(
    'core.chat.send.receipt',
    request,
    portalReadOptions(context),
  );
  if (context.canReadAssets?.() !== true)
    throw new Error('Portal asset authorization was revoked.');
  return result;
}

export async function queryPortalChatState(
  context: PortalAdapterContext,
  request: { projectId: string; worktreeId: string },
): Promise<ChatStateSnapshot> {
  if (!context.sessionId) throw new Error('Portal session is unavailable.');
  const { legacyResult } =
    await getActiveDesktopRuntime().queryChatStateForLegacyIpc(
      {
        scope: {
          workspaceId: request.projectId,
          worktreeId: request.worktreeId,
        },
      },
      {
        caller: {
          principalId: 'local-desktop-user',
          clientInstanceId: `portal-session:${context.sessionId}`,
          authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
          interfaceKind: 'portal',
          grants: ['core.chat.read'],
        },
      },
    );
  return legacyResult;
}

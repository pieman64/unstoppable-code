import type {
  CanopyQueryHandlerMap,
  CanopyQueryResult,
} from '@canopy/protocol/canopy-core';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  CanopyOperationError,
  canopyCapabilityUnavailableError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

/** Where Work Entry chats live; defaults to Electron main's Work Entry registry. */
export interface CoreChatLocateHost {
  /** The Work Entry workspace id a request names, or null when it has no Work Entries. */
  workEntryWorkspace(workspaceId: string): string | null;
  locate(
    workspaceId: string,
    chatId: string,
  ): Promise<{ entryId: string | null; archivedInEntryId: string | null }>;
}

export function createDesktopChatLocateHost(): CoreChatLocateHost {
  return {
    workEntryWorkspace: (workspaceId) => {
      if (workspaceId === APP_ADVISOR_PROJECT_ID) return workspaceId;
      const resolved = resolveCoworkWorkspaceId(workspaceId);
      return isCoworkWorkspace(resolved) ? resolved : null;
    },
    locate: async (workspaceId, chatId) => {
      // Lazy: keeps the Work Entry registry's graph off startup.
      const { readWorkEntriesFileStrict, resolveWorkEntryForChat } =
        await import('../lib/cowork-work-entries');
      // The resolver reads the registry leniently, as empty when unreadable;
      // an unreadable registry must fail here instead of reading as a miss.
      await readWorkEntriesFileStrict(workspaceId);
      return resolveWorkEntryForChat(workspaceId, chatId);
    },
  };
}

export function createCoreChatLocateAdapter(
  host: CoreChatLocateHost = createDesktopChatLocateHost(),
): Pick<CanopyQueryHandlerMap<CanopyHandlerContext>, 'core.chat.locate'> {
  return {
    'core.chat.locate': async (
      params,
    ): Promise<CanopyQueryResult<'core.chat.locate'>> => {
      if (
        params.scope.targetId !== undefined ||
        (params.scope.authorityId !== undefined &&
          params.scope.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID)
      ) {
        throw canopyCapabilityUnavailableError(
          'The selected chat authority or target is unavailable.',
        );
      }
      const workspaceId = host.workEntryWorkspace(params.scope.workspaceId);
      if (workspaceId === null) {
        throw new CanopyOperationError({
          kind: 'capability_unavailable',
          message: 'Chats in this workspace are found by their worktree.',
          retry: { kind: 'never' },
        });
      }
      let located: { entryId: string | null; archivedInEntryId: string | null };
      try {
        located = await host.locate(workspaceId, params.chatId);
      } catch (error) {
        throw new CanopyOperationError(
          {
            kind: 'unavailable',
            code: 'core.chat.locate.unavailable',
            message: 'Work Entries cannot be read right now.',
            retry: { kind: 'same_request', delayMs: 1000 },
          },
          error,
        );
      }
      return {
        worktreeId: located.entryId,
        archivedInWorktreeId: located.archivedInEntryId,
      };
    },
  };
}

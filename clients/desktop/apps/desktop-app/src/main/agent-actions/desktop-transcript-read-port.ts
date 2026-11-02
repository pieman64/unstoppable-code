import {
  AgentPortError,
  type AgentActionCall,
  type AgentTranscriptReadOwner,
  type AgentTranscriptReadPort,
} from '@canopy/agent-actions';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import {
  agentActionCaller,
  createDesktopChatMetadataLookup,
  desktopEnvironmentPortDeps,
  toAgentPortError,
  type DesktopEnvironmentPortDeps,
} from './desktop-environment-port';

type Call = AgentActionCall<CanopyInjectedToolRuntime>;
type StandaloneOwner = {
  workspaceId: string;
  entryId: string | null;
  archivedInEntryId: string | null;
};

export interface DesktopTranscriptReadPortDeps extends Pick<
  DesktopEnvironmentPortDeps,
  'runtime' | 'listWorkEntries'
> {
  resolveStandaloneOwner(
    workspaceId: string,
    chatId: string,
  ): Promise<StandaloneOwner>;
}

/** Do not copy backend messages (which may include storage paths) into tool replies. */
async function readOperation<T>(
  operation: () => Promise<T>,
  hasCursor = false,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AgentPortError) {
      throw new AgentPortError(
        error.code,
        'Transcript read is unavailable.',
        error.retryable,
      );
    }
    if (error instanceof CanopyOperationError) {
      if (error.payload.kind === 'cancelled') {
        throw new AgentPortError('timeout', 'Transcript read was cancelled.');
      }
      if (
        error.payload.kind === 'failed_precondition' ||
        error.payload.code?.endsWith('.staleCursor') ||
        (hasCursor && error.payload.kind === 'invalid_argument')
      ) {
        throw new AgentPortError(
          'invalid_target',
          'Transcript target or cursor is invalid; restart the read.',
        );
      }
      const mapped = toAgentPortError(error);
      if (mapped instanceof AgentPortError) {
        throw new AgentPortError(
          mapped.code,
          'Transcript read is unavailable.',
          mapped.retryable,
        );
      }
    }
    throw new AgentPortError(
      'execution_failed',
      'Transcript read is unavailable.',
    );
  }
}

/** Dispatcher-only transcript reads following workspace-scoped metadata authorization. */
export function createDesktopTranscriptReadPort(
  deps: DesktopTranscriptReadPortDeps = desktopTranscriptReadPortDeps(),
): AgentTranscriptReadPort<CanopyInjectedToolRuntime> {
  const lookup = createDesktopChatMetadataLookup(deps);
  const options = (
    call: Call,
  ): {
    caller: ReturnType<typeof agentActionCaller>;
    signal?: AbortSignal;
  } => ({
    caller: agentActionCaller(call, ['core.chat.read']),
    signal: call.signal,
  });
  const notFound = (): never => {
    throw new AgentPortError('not_found', 'Transcript owner was not found.');
  };

  return {
    authorizeOwner: (target, call) =>
      readOperation(async (): Promise<AgentTranscriptReadOwner> => {
        const workspaceId = call.scope?.workspaceId;
        if (!workspaceId || call.signal?.aborted) {
          if (call.signal?.aborted)
            throw new AgentPortError(
              'timeout',
              'Transcript read was cancelled.',
            );
          return notFound();
        }
        const entries = await lookup.coworkEntries(workspaceId, call, true);
        if (entries) {
          const resolved = await deps.resolveStandaloneOwner(
            workspaceId,
            target.chatId,
          );
          const worktreeId = resolved.archivedInEntryId ?? resolved.entryId;
          if (
            resolved.workspaceId !== workspaceId ||
            !worktreeId ||
            !entries.some((entry) => entry.entryId === worktreeId)
          )
            return notFound();
          const chat = await lookup.findChatInWorktree(
            { workspaceId, worktreeId },
            target.chatId,
            call,
          );
          if (
            !chat ||
            chat.workspaceId !== workspaceId ||
            chat.worktreeId !== worktreeId
          )
            return notFound();
          return {
            scope: { workspaceId, worktreeId, chatId: target.chatId },
            entryId: worktreeId,
            ...(resolved.archivedInEntryId
              ? { archivedContainerId: resolved.archivedInEntryId }
              : {}),
          };
        }
        const chat = await lookup.findChat(workspaceId, target.chatId, call);
        if (!chat || chat.workspaceId !== workspaceId || !chat.worktreeId)
          return notFound();
        // A git chat lives in a listed live worktree; `archived` names that
        // worktree's own archive index, which the scope read resolves.
        return {
          scope: {
            workspaceId,
            worktreeId: chat.worktreeId,
            chatId: chat.chatId,
          },
        };
      }),
    page: (input, owner, call) =>
      readOperation(
        () =>
          deps.runtime().query(
            'core.chat.transcript.page',
            {
              ...input,
              scope: owner.scope,
              archivedContainerId: owner.archivedContainerId,
              standaloneHistory: owner.standaloneHistory,
            },
            options(call),
          ),
        input.cursor !== undefined,
      ),
    content: (input, owner, call) =>
      readOperation(() =>
        deps.runtime().query(
          'core.chat.content.read',
          {
            ...input,
            scope: owner.scope,
            archivedContainerId: owner.archivedContainerId,
            standaloneHistory: owner.standaloneHistory,
          },
          options(call),
        ),
      ),
    blocks: (input, owner, call) =>
      readOperation(async () => {
        const page = await deps.runtime().query(
          'core.chat.transcript.blocks.page',
          {
            ...input,
            projection: 'bounded-v1',
            scope: owner.scope,
            archivedContainerId: owner.archivedContainerId,
            standaloneHistory: owner.standaloneHistory,
          },
          options(call),
        );
        if (!('projection' in page) || page.projection !== 'bounded-v1') {
          throw new AgentPortError(
            'execution_failed',
            'Transcript block projection is unavailable.',
          );
        }
        return page;
      }, input.cursor !== undefined),
  };
}

export function desktopTranscriptReadPortDeps(): DesktopTranscriptReadPortDeps {
  const environment = desktopEnvironmentPortDeps();
  return {
    runtime: () => environment.runtime(),
    listWorkEntries: (workspaceId) => environment.listWorkEntries(workspaceId),
    resolveStandaloneOwner: async (
      workspaceId,
      chatId,
    ): Promise<StandaloneOwner> => {
      const { resolveStandaloneChatTarget } =
        await import('../services/standalone-chat-service');
      return resolveStandaloneChatTarget({
        projectLocalId: workspaceId,
        chatId,
      });
    },
  };
}

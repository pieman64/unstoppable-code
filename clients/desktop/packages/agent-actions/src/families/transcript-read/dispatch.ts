import { agentActionError, missingScopeResponse } from '../../action-support';
import { AgentPortError } from '../../port/environment-port';
import type {
  AgentTranscriptReadOwner,
  AgentTranscriptReadPort,
} from '../../port/transcript-read-port';
import {
  defineAgentActionFamily,
  type AgentActionFamily,
} from '../../surface/family';
import {
  TRANSCRIPT_READ_ACTION_TYPES,
  transcriptReadActionSchema,
  type TranscriptReadAction,
} from './actions';
import {
  transcriptReadActionCatalog,
  transcriptReadDispatchJsonSchema,
} from './catalog';
import { transcriptReadResult } from './results';

function snapshotOwner(
  owner: AgentTranscriptReadOwner,
): AgentTranscriptReadOwner {
  return Object.freeze({
    scope: Object.freeze({
      workspaceId: owner.scope.workspaceId,
      worktreeId: owner.scope.worktreeId,
      chatId: owner.scope.chatId,
    }),
    entryId: owner.entryId,
    archivedContainerId: owner.archivedContainerId,
    standaloneHistory: owner.standaloneHistory,
  });
}
function sameOwner(
  first: AgentTranscriptReadOwner,
  current: AgentTranscriptReadOwner,
): boolean {
  return (
    first.scope.workspaceId === current.scope.workspaceId &&
    first.scope.worktreeId === current.scope.worktreeId &&
    first.scope.chatId === current.scope.chatId &&
    first.entryId === current.entryId &&
    first.archivedContainerId === current.archivedContainerId &&
    first.standaloneHistory === current.standaloneHistory
  );
}

export interface TranscriptReadActionFamilyOptions<H> {
  port: AgentTranscriptReadPort<H>;
}
export function createTranscriptReadActionFamily<H>({
  port,
}: TranscriptReadActionFamilyOptions<H>): AgentActionFamily<H> {
  return defineAgentActionFamily<H, TranscriptReadAction>({
    id: 'transcript-read',
    types: TRANSCRIPT_READ_ACTION_TYPES,
    catalog: transcriptReadActionCatalog,
    supportedTypes: () => TRANSCRIPT_READ_ACTION_TYPES,
    actionSchema: transcriptReadActionSchema,
    dispatchJsonSchema: transcriptReadDispatchJsonSchema,
    dispatch: async (action, call) => {
      if (!call.scope) return missingScopeResponse(call, action.type);
      const cancelled = (): boolean => call.signal?.aborted === true;
      const aborted = (): ReturnType<typeof agentActionError> =>
        agentActionError(call, 'timeout', 'The transcript read was cancelled.');
      if (cancelled()) return aborted();
      try {
        const owner = snapshotOwner(
          await port.authorizeOwner(action.target, call),
        );
        if (cancelled()) return aborted();
        let result;
        switch (action.type) {
          case 'chat.transcript.page': {
            const { type, ...input } = action;
            void type;
            result = await port.page(input, owner, call);
            break;
          }
          case 'chat.content.read': {
            const { type, ...input } = action;
            void type;
            result = await port.content(input, owner, call);
            break;
          }
          case 'chat.transcript.blocks.page': {
            const { type, ...input } = action;
            void type;
            result = await port.blocks(
              { ...input, projection: 'bounded-v1' },
              owner,
              call,
            );
            break;
          }
        }
        if (cancelled()) return aborted();
        const currentOwner = await port.authorizeOwner(action.target, call);
        if (cancelled()) return aborted();
        if (!sameOwner(owner, currentOwner))
          return agentActionError(
            call,
            'authorization_conflict',
            'The transcript owner changed during the read. Retry after checking the owner.',
          );
        return transcriptReadResult(call, action.type, result);
      } catch (error) {
        // Host adapters translate core stale/foreign cursor failures to the
        // closed invalid_target code. Never expose backend exception strings.
        if (error instanceof AgentPortError) {
          return agentActionError(
            call,
            error.code,
            error.code === 'invalid_target'
              ? 'The target or cursor is no longer valid. Restart the read without a cursor using the exact owner and run locator.'
              : 'The transcript read could not be completed.',
            { retryable: error.retryable },
          );
        }
        return cancelled()
          ? aborted()
          : agentActionError(
              call,
              'execution_failed',
              'The transcript read failed.',
            );
      }
    },
  });
}

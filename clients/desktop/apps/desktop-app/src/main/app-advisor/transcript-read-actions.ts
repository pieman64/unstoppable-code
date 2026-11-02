import {
  AgentPortError,
  TRANSCRIPT_READ_ACTION_TYPES,
  createTranscriptReadActionFamily,
  type AgentActionCall,
  type AgentActionErrorCode,
  type TranscriptReadAction,
} from '@canopy/agent-actions';
import {
  APP_ADVISOR_PROJECT_ID,
  type AppAdvisorActionResponse,
} from '@canopy/desktop-shared/types';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import type { AppAdvisorDispatchAction } from './definitions';

export function isTranscriptReadActionType(
  action: AppAdvisorDispatchAction,
): action is TranscriptReadAction {
  return TRANSCRIPT_READ_ACTION_TYPES.some((type) => type === action.type);
}

/** The generic family erases host error-code types; keep Advisor's closed contract. */
function advisorReadErrorCode(code: string): AgentActionErrorCode {
  switch (code) {
    case 'invalid_payload':
    case 'invalid_target':
    case 'not_found':
    case 'unsupported_action':
    case 'stale_ui_state':
    case 'surface_unavailable':
    case 'execution_failed':
    case 'timeout':
    case 'read_only_source':
    case 'missing_capability':
    case 'authentication_failed':
    case 'authorization_conflict':
    case 'validation_failed':
    case 'quota_exceeded':
    case 'in_progress':
    case 'idempotency_conflict':
    case 'stale_content_hash':
    case 'navigation_failed':
      return code;
    default:
      return 'execution_failed';
  }
}

/** Main-owned global Advisor bridge. Model payloads never supply owner scope. */
export async function dispatchAdvisorTranscriptRead(
  action: TranscriptReadAction,
  host: CanopyInjectedToolRuntime,
  requestId: string,
  signal?: AbortSignal,
): Promise<AppAdvisorActionResponse> {
  const call: AgentActionCall<CanopyInjectedToolRuntime> = {
    host,
    toolUseId: requestId,
    signal,
  };
  const failure = (
    code: 'not_found' | 'timeout' | 'execution_failed',
  ): AppAdvisorActionResponse => ({
    requestId,
    ok: false,
    error: {
      code,
      message:
        code === 'timeout'
          ? 'Transcript read was cancelled.'
          : 'Transcript owner is unavailable.',
    },
  });
  if (signal?.aborted) return failure('timeout');
  try {
    const {
      agentActionCaller,
      createDesktopChatMetadataLookup,
      desktopEnvironmentPortDeps,
    } = await import('../agent-actions/desktop-environment-port');
    const { desktopAgentActionPorts } =
      await import('../agent-actions/desktop-host');
    const deps = desktopEnvironmentPortDeps();
    const lookup = createDesktopChatMetadataLookup(deps);
    let cursor: string | undefined;
    // shortcut: bounded by the local workspace inventory and its worktree/chat
    // metadata pages (100 rows/page), never transcript bodies. Replace the scan
    // with a canonical owner-index query if workspace counts make it costly;
    // do not add an Advisor cache or infer an owner from the selected UI/home.
    do {
      if (signal?.aborted) return failure('timeout');
      const page = await deps
        .runtime()
        .query(
          'core.workspace.list',
          { pageSize: 100, ...(cursor ? { cursor } : {}) },
          { caller: agentActionCaller(call, ['core.workspace.read']), signal },
        );
      for (const workspace of page.items) {
        if (signal?.aborted) return failure('timeout');
        if (workspace.workspaceId === APP_ADVISOR_PROJECT_ID) continue;
        const owner = await lookup.findChat(
          workspace.workspaceId,
          action.target.chatId,
          call,
        );
        if (
          !owner ||
          owner.workspaceId !== workspace.workspaceId ||
          !owner.worktreeId
        )
          continue;
        if (signal?.aborted) return failure('timeout');
        const family = createTranscriptReadActionFamily({
          port: desktopAgentActionPorts().transcriptRead,
        });
        const parsed = family.parse(action);
        if (!parsed?.ok) return failure('execution_failed');
        const response = await parsed.dispatch({
          ...call,
          scope: {
            workspaceId: owner.workspaceId,
            worktreeId: owner.worktreeId,
            chatId: owner.chatId,
          },
        });
        if ('text' in response) return failure('execution_failed');
        return {
          ...response,
          ...(response.error
            ? {
                error: {
                  ...response.error,
                  code: advisorReadErrorCode(response.error.code),
                },
              }
            : { error: undefined }),
        };
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return failure('not_found');
  } catch (error) {
    // Discovery errors are closed and sanitized too; never relay storage paths.
    if (signal?.aborted) return failure('timeout');
    return failure(
      error instanceof AgentPortError && error.code === 'not_found'
        ? 'not_found'
        : 'execution_failed',
    );
  }
}

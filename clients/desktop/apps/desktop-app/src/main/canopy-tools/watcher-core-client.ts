import { randomUUID } from 'node:crypto';
import type {
  AgentActionToolResult,
  SearchWatchersInput,
  SetupWatchersInput,
} from '@canopy/agent-actions';
import {
  CORE_INITIATED_WORK_WATCHER_GRANTS,
  WatcherJsonObjectSchema,
  type CanopyCallerDescriptor,
  type CanopyJsonValue,
  type WatcherCreateRequest,
  type WatcherRecipient,
  type WatcherReport,
} from '@canopy/protocol/canopy-core';
import type { AppAdvisorWatcherDestination } from '@canopy/desktop-shared/types';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { activeAgentCoreOperations } from './active-agent-core-operations';

/** The watcher tools act as their own principal, each call with only its operation's grant (CAN-5994). */
const AGENT_WATCHER_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-agent-watchers',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'mcp',
  grants: [
    CORE_INITIATED_WORK_WATCHER_GRANTS.read,
    CORE_INITIATED_WORK_WATCHER_GRANTS.write,
  ],
};

export function watcherRecipient(
  destination: AppAdvisorWatcherDestination,
): WatcherRecipient {
  return {
    workspaceId: destination.projectId,
    worktreeId: destination.worktreeId,
    chatId: destination.chatId,
    ...(destination.delegationId
      ? {
          delegation: {
            delegationId: destination.delegationId,
            ...(destination.delegationDescription
              ? { description: destination.delegationDescription }
              : {}),
            ...(destination.delegationDepth !== undefined
              ? { depth: destination.delegationDepth }
              : {}),
          },
        }
      : {}),
  };
}

/** A tool input as a JSON object for a watcher request. */
function jsonObject(value: object): Record<string, CanopyJsonValue> {
  return WatcherJsonObjectSchema.parse(JSON.parse(JSON.stringify(value)));
}

export const setupWatchersJson = (
  input: SetupWatchersInput<string>,
): Record<string, CanopyJsonValue> => jsonObject(input);

export const watcherRequestJson = jsonObject;

function toolResult(report: WatcherReport): AgentActionToolResult {
  return report.accepted
    ? { text: report.report }
    : { text: report.report, isError: true };
}

/**
 * The key one tool call's write carries. Only the provider's invocation
 * identity is stable across a call's replays; a tool-use id can be a
 * connection's JSON-RPC id, which a later connection reuses, so without an
 * invocation identity every call gets its own key.
 */
function writeKey(
  verb: 'create' | 'delete',
  destination: AppAdvisorWatcherDestination,
  invocationId: string | undefined,
): string {
  return `agent-watcher-${verb}:${destination.chatId}:${destination.delegationId ?? ''}:${invocationId ?? randomUUID()}`;
}

export async function listWatchersThroughCore(
  destination: AppAdvisorWatcherDestination,
  search: SearchWatchersInput,
  signal?: AbortSignal,
): Promise<AgentActionToolResult> {
  return toolResult(
    await activeAgentCoreOperations('watchers').query(
      'core.initiatedWork.watcher.list',
      { recipient: watcherRecipient(destination), search: jsonObject(search) },
      { caller: AGENT_WATCHER_CALLER, ...(signal ? { signal } : {}) },
    ),
  );
}

/** Creates watchers through core; the report keeps any integration failure. */
export async function createWatcherReportThroughCore(
  destination: AppAdvisorWatcherDestination,
  request: WatcherCreateRequest,
  call: { toolUseId?: string; invocationId?: string; signal?: AbortSignal },
): Promise<WatcherReport> {
  const idempotencyKey = writeKey('create', destination, call.invocationId);
  return activeAgentCoreOperations('watchers').instruction(
    'core.initiatedWork.watcher.create',
    {
      recipient: watcherRecipient(destination),
      request,
      ...(call.toolUseId ? { createdBy: call.toolUseId } : {}),
      _meta: { idempotencyKey },
    },
    {
      caller: AGENT_WATCHER_CALLER,
      metadata: { idempotencyKey },
      ...(call.signal ? { signal: call.signal } : {}),
    },
  );
}

export async function createWatcherThroughCore(
  destination: AppAdvisorWatcherDestination,
  request: WatcherCreateRequest,
  call: { toolUseId?: string; invocationId?: string; signal?: AbortSignal },
): Promise<AgentActionToolResult> {
  return toolResult(
    await createWatcherReportThroughCore(destination, request, call),
  );
}

export async function deleteWatchersThroughCore(
  destination: AppAdvisorWatcherDestination,
  watcherIds: readonly string[],
  call: { invocationId?: string; signal?: AbortSignal },
): Promise<AgentActionToolResult> {
  const idempotencyKey = writeKey('delete', destination, call.invocationId);
  return toolResult(
    await activeAgentCoreOperations('watchers').instruction(
      'core.initiatedWork.watcher.delete',
      {
        recipient: watcherRecipient(destination),
        watcherIds: [...watcherIds],
        _meta: { idempotencyKey },
      },
      {
        caller: AGENT_WATCHER_CALLER,
        metadata: { idempotencyKey },
        ...(call.signal ? { signal: call.signal } : {}),
      },
    ),
  );
}

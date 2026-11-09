import { randomUUID } from 'node:crypto';
import {
  CORE_AGENT_DEFERRED_TOOLS_GRANTS,
  DeferredToolsJsonObjectSchema,
  DeferredToolsSelectionsJsonSchema,
  type CanopyCallerDescriptor,
  type DeferredToolsRecipient,
  type DeferredToolsReport,
  type DeferredToolsSession,
} from '@canopy/protocol/canopy-core';
import {
  loadDeferredToolsSchema,
  searchDeferredToolsSchema,
} from '../deferred-tools/definitions';
import {
  deferredToolsUnavailable,
  executeLoadDeferredTools,
  type DeferredToolsExecutionResult,
  type DeferredToolsExecutorRuntime,
} from '../deferred-tools/executor';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { activeAgentCoreOperations } from './active-agent-core-operations';

/**
 * The deferred tools act as their own principal, each call with only its
 * operation's grant (CAN-5995). Kept private to this module: the chat write
 * grant reaches only `core.agent.deferredTools.load`.
 */
const AGENT_DEFERRED_TOOLS_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-agent-deferred-tools',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'mcp',
  grants: [
    CORE_AGENT_DEFERRED_TOOLS_GRANTS.search,
    CORE_AGENT_DEFERRED_TOOLS_GRANTS.load,
  ],
};

function plainJson(value: object): unknown {
  return JSON.parse(JSON.stringify(value));
}

/** The calling session's chat; never anything from tool input. */
function recipientOf(
  runtime: DeferredToolsExecutorRuntime,
): DeferredToolsRecipient {
  return {
    workspaceId: runtime.scope.projectId,
    worktreeId: runtime.scope.worktreeId,
    chatId: runtime.scope.chatId,
  };
}

function sessionOf(
  runtime: DeferredToolsExecutorRuntime,
): DeferredToolsSession {
  return {
    ...(runtime.providerType ? { providerType: runtime.providerType } : {}),
    ...(runtime.interfaceMode ? { interfaceMode: runtime.interfaceMode } : {}),
    ...(runtime.assistantMode ? { assistantMode: runtime.assistantMode } : {}),
    ...(runtime.pluginSelections
      ? {
          pluginSelections: DeferredToolsSelectionsJsonSchema.parse(
            plainJson(runtime.pluginSelections),
          ),
        }
      : {}),
  };
}

function toolResult(report: DeferredToolsReport): DeferredToolsExecutionResult {
  return report.accepted
    ? { text: report.report }
    : { text: report.report, isError: true };
}

export async function searchDeferredToolsThroughCore(
  rawArgs: unknown,
  runtime: DeferredToolsExecutorRuntime,
  call: { signal?: AbortSignal } = {},
): Promise<DeferredToolsExecutionResult> {
  if (runtime.allowed === false) return deferredToolsUnavailable();
  const parsed = searchDeferredToolsSchema.safeParse(rawArgs);
  if (!parsed.success)
    return {
      text: 'Invalid arguments for SearchDeferredTools.',
      isError: true,
    };
  return toolResult(
    await activeAgentCoreOperations('deferredTools').query(
      'core.agent.deferredTools.search',
      {
        recipient: recipientOf(runtime),
        session: sessionOf(runtime),
        input: DeferredToolsJsonObjectSchema.parse(plainJson(parsed.data)),
      },
      {
        caller: AGENT_DEFERRED_TOOLS_CALLER,
        ...(call.signal ? { signal: call.signal } : {}),
      },
    ),
  );
}

/**
 * Loads through core. A managed delegate's load goes to its run's own reload
 * controller in process, which is not a chat write; it applies the same
 * issued-ref and catalog checks.
 */
export async function loadDeferredToolsThroughCore(
  rawArgs: unknown,
  runtime: DeferredToolsExecutorRuntime,
  call: {
    toolUseId?: string;
    invocationId?: string;
    signal?: AbortSignal;
  } = {},
): Promise<DeferredToolsExecutionResult> {
  if (runtime.reloadSink)
    return executeLoadDeferredTools(rawArgs, runtime, {
      ...(call.toolUseId ? { toolUseId: call.toolUseId } : {}),
    });
  if (runtime.allowed === false) return deferredToolsUnavailable();
  const parsed = loadDeferredToolsSchema.safeParse(rawArgs);
  if (!parsed.success)
    return { text: 'Invalid arguments for LoadDeferredTools.', isError: true };
  // Only the provider's invocation identity is stable across a call's
  // replays; without one every call gets its own key. The tool call id the
  // reload waits for is part of the key too: a retry over a new connection
  // carries a new one, so it is a new load, which a live reload refuses.
  const idempotencyKey = `agent-deferred-load:${runtime.scope.chatId}:${call.invocationId ?? randomUUID()}:${call.toolUseId ?? ''}`;
  return toolResult(
    await activeAgentCoreOperations('deferredTools').instruction(
      'core.agent.deferredTools.load',
      {
        recipient: recipientOf(runtime),
        session: sessionOf(runtime),
        input: DeferredToolsJsonObjectSchema.parse(plainJson(parsed.data)),
        ...(call.toolUseId ? { toolCallId: call.toolUseId } : {}),
        _meta: { idempotencyKey },
      },
      {
        caller: AGENT_DEFERRED_TOOLS_CALLER,
        metadata: { idempotencyKey },
        ...(call.signal ? { signal: call.signal } : {}),
      },
    ),
  );
}

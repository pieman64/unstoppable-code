import { CanopyOperationError } from '@canopy/core-runtime';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import type {
  DeferredToolsRecipient,
  DeferredToolsReport,
  DeferredToolsSession,
} from '@canopy/protocol/canopy-core';
import {
  isChatTabPluginSelections,
  normalizePluginSelections,
} from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type {
  DeferredToolsExecutionResult,
  DeferredToolsExecutorRuntime,
} from '../deferred-tools/executor';
import type { DesktopDomainAdapter } from './desktop-runtime';

/** The catalog and reload lifecycle behind `core.agent.deferredTools.*`; Electron main's by default, tests inject one. */
export interface CoreDeferredToolsHost {
  search(
    input: Record<string, unknown>,
    runtime: DeferredToolsExecutorRuntime,
  ): Promise<DeferredToolsExecutionResult>;
  load(
    input: Record<string, unknown>,
    runtime: DeferredToolsExecutorRuntime,
    call: { toolCallId?: string },
  ): Promise<DeferredToolsExecutionResult>;
}

const desktopDeferredToolsHost: CoreDeferredToolsHost = {
  search: async (input, runtime) => {
    const { executeSearchDeferredTools } =
      await import('../deferred-tools/executor');
    return executeSearchDeferredTools(input, runtime);
  },
  load: async (input, runtime, call) => {
    const { executeLoadDeferredTools } =
      await import('../deferred-tools/executor');
    return executeLoadDeferredTools(input, runtime, {
      ...(call.toolCallId ? { toolUseId: call.toolCallId } : {}),
    });
  },
};

function pluginSelectionsOf(value: unknown): ChatTabPluginSelections {
  if (!isChatTabPluginSelections(value))
    throw new CanopyOperationError({
      kind: 'invalid_argument',
      message: 'The chat selections are not valid.',
      retry: { kind: 'never' },
    });
  return normalizePluginSelections(value);
}

function runtimeOf(
  recipient: DeferredToolsRecipient,
  session: DeferredToolsSession,
): DeferredToolsExecutorRuntime {
  return {
    scope: {
      projectId: recipient.workspaceId,
      worktreeId: recipient.worktreeId,
      chatId: recipient.chatId,
    },
    ...(session.providerType ? { providerType: session.providerType } : {}),
    ...(session.interfaceMode ? { interfaceMode: session.interfaceMode } : {}),
    ...(session.assistantMode ? { assistantMode: session.assistantMode } : {}),
    ...(session.pluginSelections
      ? { pluginSelections: pluginSelectionsOf(session.pluginSelections) }
      : {}),
    allowed: true,
  };
}

function report(result: DeferredToolsExecutionResult): DeferredToolsReport {
  return { accepted: result.isError !== true, report: result.text };
}

/**
 * `core.agent.deferredTools.search` and `.load` on the desktop dispatcher
 * (CAN-5995). Search runs the local catalog projection for the recipient
 * chat and remembers the refs it returned; load accepts only those refs,
 * enables only installed, locally managed items, and admits the chat's
 * reload through the CAN-4127 lifecycle, which does the enabling.
 */
export function createCoreDeferredToolsAdapter(
  host: CoreDeferredToolsHost = desktopDeferredToolsHost,
): DesktopDomainAdapter {
  const loads = new KeyedOutcomes<DeferredToolsReport>({
    reusedError: (): CanopyOperationError =>
      new CanopyOperationError({
        kind: 'conflict',
        message: 'This idempotency key was used with other parameters.',
        retry: { kind: 'never' },
      }),
  });
  return {
    queries: {
      'core.agent.deferredTools.search': async (params) =>
        report(
          await host.search(
            params.input,
            runtimeOf(params.recipient, params.session),
          ),
        ),
    },
    instructions: {
      'core.agent.deferredTools.load': (params, context) =>
        loads.run(context, params, async () =>
          report(
            await host.load(
              params.input,
              runtimeOf(params.recipient, params.session),
              params.toolCallId ? { toolCallId: params.toolCallId } : {},
            ),
          ),
        ),
    },
  };
}

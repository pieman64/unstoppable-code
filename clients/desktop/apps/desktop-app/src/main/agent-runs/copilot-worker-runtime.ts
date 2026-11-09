import type { DeferredToolsReloadScopeKey } from '@canopy/desktop-shared/types';
import type { CopilotRecipientHandle } from '@canopy/desktop-shared/node/copilot/recipient-handle';
import type { AgentProvider } from '../agents/types';
import {
  openManagedCopilotRuntime,
  type ManagedCopilotRuntimeOptions,
} from '../copilot/connection';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { assertAgentWorkerContext } from './agent-worker-context';
import type { WorkerProviderRuntime } from './worker-provider-runtimes';

/** Options for a Copilot session runtime; the owner comes from the worker run. */
export type CopilotSessionRuntimeOptions = Omit<
  ManagedCopilotRuntimeOptions,
  'owner' | 'purpose'
>;

/** The worker-owned Copilot runtime (CAN-4119). */
export interface CopilotWorkerRuntime extends WorkerProviderRuntime {
  readonly harness: 'copilot';
  /**
   * Opens the per-turn or per-task Copilot runtime of a chat or managed
   * delegation session. Refuses outside an agent worker run; the process owner
   * is that run.
   */
  openSessionRuntime(
    entry: string,
    options: CopilotSessionRuntimeOptions,
  ): Promise<CopilotRecipientHandle>;
  /**
   * The acknowledge-before-reload seam (CAN-4127): called synchronously, only
   * after CopilotToolReceipts.observe confirmed the native root completion of
   * `toolUseId`, at most once per tool use id. True when a reload was waiting
   * for exactly this result and is now released; the caller then stops the turn.
   */
  acknowledgeToolResult(
    scope: DeferredToolsReloadScopeKey,
    toolUseId: string,
  ): boolean;
}

const runtime: CopilotWorkerRuntime = {
  harness: 'copilot',
  async providerFor(): Promise<AgentProvider> {
    assertAgentWorkerContext('CopilotWorkerRuntime.providerFor');
    const { CopilotProvider } = await import('../agents/copilot-session');
    return new CopilotProvider();
  },
  openSessionRuntime(
    entry: string,
    options: CopilotSessionRuntimeOptions,
  ): Promise<CopilotRecipientHandle> {
    const context = assertAgentWorkerContext(entry);
    return openManagedCopilotRuntime({
      ...options,
      purpose: 'session',
      owner: { kind: context.kind, id: context.runId },
    });
  },
  acknowledgeToolResult(
    scope: DeferredToolsReloadScopeKey,
    toolUseId: string,
  ): boolean {
    return deferredToolsReloadCoordinator.markToolResultDelivered(
      scope,
      toolUseId,
    );
  },
};

export function getCopilotWorkerRuntime(): CopilotWorkerRuntime {
  return runtime;
}

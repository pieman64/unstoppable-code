import type {
  AgentProviderType,
  ChatModel,
} from '@canopy/desktop-shared/types';
import { resolveAnthropicMockEnvOverride } from '@canopy/execution-engine/node/e2e-mock-env';
import type { AgentProvider } from '../agents/types';
import type { ClaudeCompatibleInvocation } from '../agents/claude-session';
import { assertAgentWorkerContext } from './agent-worker-context';
import type { WorkerProviderRuntime } from './worker-provider-runtimes';

export type ClaudeHarnessProviderType = 'claude' | 'ollama';

export interface ClaudeInvocationRequest {
  readonly providerType: ClaudeHarnessProviderType;
  readonly model: ChatModel | undefined;
  readonly reason: 'session-start' | 'model-change' | 'pipeline';
}

/** The worker-owned Claude harness runtime (CAN-4116): Claude, and Ollama over the Claude SDK transport. */
export interface ClaudeWorkerRuntime extends WorkerProviderRuntime {
  readonly harness: 'claude';
  /**
   * The one entry for Claude-compatible invocation: the E2E mock override for
   * Claude, `resolveClaudeCompatibleInvocation` for Ollama. CAN-5095 (pipeline
   * model steps) and CAN-5097 (terminal mode) reuse it.
   */
  prepareInvocation(
    request: ClaudeInvocationRequest,
  ): Promise<ClaudeCompatibleInvocation>;
}

class DesktopClaudeWorkerRuntime implements ClaudeWorkerRuntime {
  readonly harness = 'claude' as const;

  async providerFor(providerType: AgentProviderType): Promise<AgentProvider> {
    assertAgentWorkerContext('ClaudeWorkerRuntime.providerFor');
    if (providerType === 'ollama') {
      const { OllamaProvider } = await import('../agents/ollama-provider');
      return new OllamaProvider({
        prepareInvocation: (model, reason) =>
          this.prepareInvocation({ providerType: 'ollama', model, reason }),
      });
    }
    const { ClaudeCodeProvider } = await import('../agents/claude-session');
    return new ClaudeCodeProvider({
      prepareInvocation: (model, reason) =>
        this.prepareInvocation({ providerType: 'claude', model, reason }),
    });
  }

  async prepareInvocation({
    providerType,
    model,
    reason,
  }: ClaudeInvocationRequest): Promise<ClaudeCompatibleInvocation> {
    if (providerType === 'ollama') {
      const { resolveClaudeCompatibleInvocation } =
        await import('../ollama/claude-compatible');
      // CAN-5095 D23: a pipeline step's Ollama model, as its runner asked before.
      if (reason === 'pipeline')
        return resolveClaudeCompatibleInvocation(model, {
          providerType: 'ollama',
          ensureRunningReason: 'pipeline',
          assertInstalled: true,
        });
      return resolveClaudeCompatibleInvocation(model, {
        ensureRunningReason: 'chat',
        assertInstalled:
          reason === 'session-start' || reason === 'model-change',
      });
    }
    const envOverride = resolveAnthropicMockEnvOverride();
    return {
      providerType: 'claude',
      ...(model ? { sdkModel: model } : {}),
      ...(envOverride ? { envOverride } : {}),
    };
  }
}

const runtime = new DesktopClaudeWorkerRuntime();

export function getClaudeWorkerRuntime(): ClaudeWorkerRuntime {
  return runtime;
}

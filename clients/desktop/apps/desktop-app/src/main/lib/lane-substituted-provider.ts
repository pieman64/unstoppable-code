import {
  getModelSource,
  getProviderForModel,
  type AgentProviderType,
  type ChatModel,
} from '@canopy/desktop-shared/types';

/**
 * Detect a CROSS-LANE NATIVE substitution performed by lane resolution.
 *
 * Lane resolution treats a forced `providerType` as a lane PREFERENCE, not a
 * constraint: `requireLaneAwareDefaultSelection` can fall through to the next
 * lane when the preferred one is unavailable. So a Codex-locked chat whose Codex lane is down
 * comes back holding a NATIVE CLAUDE model. Pinning the requested
 * `providerType: 'codex'` over that model pairs a Claude model with the Codex
 * harness, and every dispatcher then trips its
 * "execution harness does not match host-owned routing" guard — the chat cannot
 * send at all.
 *
 * Every dispatcher that makes an explicit `providerType` authoritative over a
 * lane-resolved model needs this same reconciliation, so it lives here rather
 * than in one of them: `worktree-chat-turn.ts`, the Pipeline Editor chat
 * service, and the App Advisor chat service all call it.
 *
 * Detected NARROWLY — only a cross-lane native substitution counts. Gateway and
 * agent models are routable on either harness, so the forced provider stays
 * authoritative for them, which is the case the "providerType is authoritative"
 * rule exists for.
 *
 * @param explicitModel The model the CALLER named. When present no lane
 * resolution happened, so there is nothing to reconcile.
 * @param requestedProviderType The caller's/persisted provider lock.
 * @param selectedModel The model that will actually run.
 * @returns The provider the substituted model really belongs to, or `undefined`
 * when no substitution occurred.
 */
export function resolveLaneSubstitutedProviderType(input: {
  explicitModel: ChatModel | undefined;
  requestedProviderType: AgentProviderType | undefined;
  selectedModel: ChatModel | undefined;
}): AgentProviderType | undefined {
  if (input.explicitModel !== undefined) return undefined;
  if (input.requestedProviderType === undefined) return undefined;
  if (input.selectedModel === undefined) return undefined;
  const source = getModelSource(input.selectedModel);
  if (source !== 'claude-managed' && source !== 'codex-managed') {
    return undefined;
  }
  const actual = getProviderForModel(input.selectedModel);
  return actual === input.requestedProviderType ? undefined : actual;
}

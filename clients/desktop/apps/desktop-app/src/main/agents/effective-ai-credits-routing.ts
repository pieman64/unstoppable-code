// Which stored AI Credits routing still applies to a chat (CAN-4200).
//
// Session routing stops after its reset time or after a later native account
// change. Main ignores stale routing at every billing decision (the routing
// resolvers, the session signature, and send ingress) rather than rewriting
// the tab; the renderer clears the stored value. Kept apart from
// `ai-credits-routing.ts` so those callers stay light to load.

import type {
  AgentProviderType,
  AiCreditsRoutingState,
  ChatSendMessageRequest,
  ModelHarness,
  NativeAccountProvider,
} from '@canopy/desktop-shared/types';
import { isAiCreditsRoutingInEffect } from '@canopy/desktop-shared/ai-credits-routing-state';
import { getNativeAccountChangedAt } from './native-account-change';

/**
 * The billed provider whose account change can end a chat's session routing:
 * the chat's provider when it is Claude or Codex, else its pinned harness when
 * that is, else unknown (an Auto chat before its first turn).
 */
export function billedProviderFor(
  providerType?: AgentProviderType,
  executionHarness?: ModelHarness,
): NativeAccountProvider | undefined {
  if (providerType === 'claude' || providerType === 'codex') {
    return providerType;
  }
  if (executionHarness === 'claude' || executionHarness === 'codex') {
    return executionHarness;
  }
  return undefined;
}

/**
 * A chat's stored routing, or `undefined` when it no longer applies: session
 * routing after its reset time or after a later native account change.
 */
export function effectiveTabAiCreditsRouting(
  routing: AiCreditsRoutingState | undefined,
  provider: NativeAccountProvider | undefined,
  now = Date.now(),
): AiCreditsRoutingState | undefined {
  return isAiCreditsRoutingInEffect(routing, {
    now,
    ...(provider
      ? { accountChangedAt: getNativeAccountChangedAt(provider) }
      : {}),
  })
    ? routing
    : undefined;
}

/**
 * A send request without stale session routing, so Auto's lane choice and the
 * dispatched session agree with the routing resolvers.
 */
export function withEffectiveAiCreditsRouting(
  request: ChatSendMessageRequest,
): ChatSendMessageRequest {
  if (
    effectiveTabAiCreditsRouting(
      request.aiCreditsRouting,
      billedProviderFor(request.providerType, request.executionHarness),
    ) === request.aiCreditsRouting
  ) {
    return request;
  }
  const next = { ...request };
  delete next.aiCreditsRouting;
  return next;
}

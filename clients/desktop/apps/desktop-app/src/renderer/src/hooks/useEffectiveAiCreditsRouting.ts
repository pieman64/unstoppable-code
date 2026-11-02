import { useEffect, useRef, useState } from 'react';
import {
  isAiCreditsRoutingInEffect,
  normalizeEpochMs,
} from '@canopy/desktop-shared/ai-credits-routing-state';
import type {
  AiCreditsRoutingState,
  NativeAccountProvider,
} from '@canopy/desktop-shared/types';
import type { CreditsModelRoutability } from '@/lib/chatBillingFramework';
import { scheduleAt } from '@/lib/scheduleAt';
import { useChatStore } from '@/stores/chatStore';
import { isScopeRevisionedLive } from '@/stores/chat/slices/revisioned';
import { useNativeProviderAccounts } from './useNativeProviderAccounts';

/**
 * Whether a chat's stored AI Credits routing still applies (CAN-4200).
 *
 * "Just this time" session routing stops at its reset time and after a native
 * account change recorded later than its activation; persistent routing always
 * applies. Main ignores stale routing at every billing decision with the same
 * rule, so the composer can hide the card and return to subscription at once,
 * and this hook clears the stored value once per activation so it does not
 * linger on the tab.
 *
 * Mount once per chat, in `ChatInput`. `provider` is the billed provider the
 * composer resolves for billing, or `undefined` when it is neither Claude nor
 * Codex; only the reset time applies then. Also returns that provider's last
 * recorded account change, so the composer reads preferences once.
 *
 * Session routing on a model that can't run on AI Credits is stale too
 * (CAN-4900): the resolver bills it to the subscription, so the saved routing
 * would only claim credits the UI does not show, or turn them on silently
 * after a later model change. `creditsModelRoutability` is the composer's
 * answer for the chat's model; `'unknown'` (cold catalog) changes nothing,
 * and persistent routing is never cleared here.
 */
export function useEffectiveAiCreditsRouting(
  routing: AiCreditsRoutingState | undefined,
  provider: NativeAccountProvider | undefined,
  target: { projectId: string; worktreeId: string; chatId: string } | null,
  creditsModelRoutability: CreditsModelRoutability,
): { inEffect: boolean; accountChangedAt: number | undefined } {
  const accounts = useNativeProviderAccounts();
  const accountChangedAt = provider ? accounts[provider]?.changedAt : undefined;
  const [now, setNow] = useState(() => Date.now());

  const sessionResetsAt =
    routing?.active &&
    routing.scope === 'session' &&
    routing.resetsAt !== undefined
      ? normalizeEpochMs(routing.resetsAt)
      : undefined;
  useEffect(() => {
    if (sessionResetsAt === undefined) return;
    return scheduleAt(sessionResetsAt, () => setNow(Date.now()));
  }, [sessionResetsAt]);

  const routingInEffect = isAiCreditsRoutingInEffect(routing, {
    now,
    ...(accountChangedAt !== undefined ? { accountChangedAt } : {}),
    subscriptionRestoredAt: provider
      ? accounts[provider]?.subscriptionRestoredAt
      : undefined,
  });
  const staleSession =
    routing?.active === true &&
    routing.scope === 'session' &&
    (!routingInEffect || creditsModelRoutability === 'not-routable');
  const inEffect = routingInEffect && !staleSession;

  const live = useChatStore((state) =>
    target
      ? isScopeRevisionedLive(state, target.projectId, target.worktreeId)
      : false,
  );
  const clearAiCreditsRouting = useChatStore(
    (state) => state.clearAiCreditsRouting,
  );
  const clearedKeyRef = useRef<string | null>(null);
  const activatedAt = routing?.activatedAt;
  useEffect(() => {
    if (!staleSession || !target || !live) return;
    const key = `${target.projectId}/${target.worktreeId}/${target.chatId}/${activatedAt ?? 0}`;
    if (clearedKeyRef.current === key) return;
    clearedKeyRef.current = key;
    clearAiCreditsRouting(target);
  }, [activatedAt, clearAiCreditsRouting, live, staleSession, target]);

  return { inEffect, accountChangedAt };
}

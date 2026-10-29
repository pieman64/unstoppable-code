import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { getModelCatalogProviderLabel } from '@canopy/ui-shared';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { resolveAiCreditsFundingSource } from '@canopy/desktop-shared/lib/ai-credits-funding';
import type { CanopyCloudAiCreditsState } from '@canopy/desktop-shared';
import type {
  AiCreditsScopeRequest,
  NativeAccountProvider,
} from '@canopy/desktop-shared/types';
import {
  useChatTargetAiCreditsScope,
  useStableAiCreditsScope,
} from '@/lib/aiCreditsScope';
import { formatCredits } from '@/lib/ai-credits-format';
import { selectProviderUsageLimitResumeAt } from '@/lib/claudeUsageLimitResume';
import { scheduleAt } from '@/lib/scheduleAt';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import type { ChatBannerTarget } from '@/stores/aiCreditsBannerStore';
import { useObservabilityStore } from '@/stores/observabilityStore';

interface AiCreditsRoutingStatusBannerProps {
  /**
   * The chat this banner belongs to. Works for every surface — worktree,
   * standalone (cowork), App Advisor, pipeline editor, plan-explore — because
   * routing status is keyed by target and fed centrally from the main process
   * (CAN-838). Pass `null` to render nothing.
   */
  target: ChatBannerTarget | null;
  /**
   * Whether this banner should render. Computed once in `ChatInput` by the
   * shared billing resolver (`aiCreditsBannerVisible`) so the banner and the
   * model picker's toggle can never disagree, and so the banner stays visible
   * while the chat is set to AI Credits whether or not a turn is streaming.
   *
   * Deliberately narrower than "the chat bills to AI Credits": it is also false
   * when the account has no native login for the billing provider. See the
   * component doc below.
   */
  active: boolean;
  /** True while the current turn is actively running. */
  turnActive: boolean;
  /** The billed provider, used for the reset line. */
  provider?: NativeAccountProvider;
  /**
   * Offers "Switch to subscription" when set. `ChatInput` passes it whenever
   * the chat can run on the provider subscription, including started Auto
   * chats whose picker toggle is locked (CAN-4200).
   */
  onSwitchToSubscription?: () => void;
  /**
   * The provider's last recorded native account change. A change re-reads the
   * reset line, because the new account has its own limits.
   */
  accountChangedAt?: number;
}

/**
 * Live AI-credits state for the banner, so the user can watch their balance tick
 * down as the session spends. Reads the source-gated balance
 * (`/api/v1/ai-credits/balance` via `loadCanopyCloudAiCredits`) — the UD balance
 * when the account is UD-linked and eligible, otherwise the native Canopy wallet
 * — so it reflects whichever pool is actually funding this session.
 *
 * Returns the whole state rather than just the credit number, because an empty
 * personal wallet can still be funded by the org pool the server names in
 * `balance.orgPool`; the caller resolves the payer from it.
 *
 * It is fetched once when the banner first becomes visible and re-read shortly
 * after each turn ends: the proxy debits deliver-then-debit, so the balance
 * settles asynchronously just after the stream completes. Two short delayed
 * reads catch the settled value without a steady poll. Returns `null` until the
 * first successful read (and on a disconnected account); the caller hides the
 * chip while `null`.
 *
 * The read is scoped to the chat's owner (CAN-3463): the server reports only
 * that owner's organization pool, so "Covered by" can never name an org that
 * does not own this work. A target change drops the previous chat's state
 * before its own read lands.
 */
function useAiCreditsSessionBalance(
  visible: boolean,
  turnActive: boolean,
  scope: AiCreditsScopeRequest | undefined,
  scopeKey: string,
): CanopyCloudAiCreditsState | null {
  const [state, setState] = useState<{
    key: string;
    value: CanopyCloudAiCreditsState;
  } | null>(null);
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;

  const fetchBalance = useCallback(async (): Promise<void> => {
    const load = window.api?.loadCanopyCloudAiCredits;
    if (!load) {
      return;
    }
    const requestedScope = scope;
    const requestedScopeKey = scopeKey;
    try {
      const next = await load(requestedScope);
      // A read for a chat the banner no longer shows describes another owner.
      if (scopeKeyRef.current !== requestedScopeKey) return;
      // `loadCanopyCloudAiCredits` reports a transient lookup failure by
      // *returning* `{ error, balance: null }` rather than throwing, so the
      // `catch` below is not the path a blip actually takes. Committing that
      // state would make `resolveAiCreditsFundingSource` fall to `unknown` and
      // the chip vanish mid-session on one failed poll — the balance is re-read
      // twice after every turn, so a single blip is likely. Hold the last
      // resolved value instead. `noUdAccount` and a disconnected account are
      // authoritative answers, not blips, so they still commit.
      setState((previous) => {
        const previousValue =
          previous?.key === requestedScopeKey ? previous.value : null;
        return {
          key: requestedScopeKey,
          value:
            next.error !== null && previousValue !== null
              ? previousValue
              : next,
        };
      });
    } catch {
      // Keep last-known-good if the IPC call itself rejects.
    }
  }, [scope, scopeKey]);

  // Read once when the banner becomes visible.
  useEffect(() => {
    if (!visible) {
      return;
    }
    void fetchBalance();
  }, [visible, fetchBalance]);

  // Re-read after a turn ends. The debit is applied post-stream, so poll twice
  // with short delays to catch the settled balance without a steady poll.
  const wasTurnActive = useRef(turnActive);
  useEffect(() => {
    const ended = wasTurnActive.current && !turnActive;
    wasTurnActive.current = turnActive;
    if (!visible || !ended) {
      return;
    }
    const timers = [
      setTimeout(() => void fetchBalance(), 1_500),
      setTimeout(() => void fetchBalance(), 4_000),
    ];
    return (): void => timers.forEach(clearTimeout);
  }, [turnActive, visible, fetchBalance]);

  // Exclude another owner's settled value during render. Waiting for a passive
  // effect to clear it permits one committed paint with the previous payer.
  return state?.key === scopeKey ? state.value : null;
}

/**
 * When the provider's current account is limited, the time its farthest
 * exhausted window resets, for the card's reset line (CAN-4200).
 *
 * Fetches a fresh usage snapshot when the line becomes possible and again when
 * the native account changes; it never reads the cached store usage, which can
 * describe the previous account. A result for an older request, a failed
 * fetch, or a reset that is not in the future shows no line, and a timer drops
 * the line once the reset passes.
 */
function useProviderLimitResetAt(
  enabled: boolean,
  provider: NativeAccountProvider | undefined,
  accountChangedAt: number | undefined,
): number | null {
  const [state, setState] = useState<{
    key: string;
    resetAt: number;
  } | null>(null);
  const key = `${provider ?? ''}:${accountChangedAt ?? ''}`;

  useEffect(() => {
    if (!enabled || !provider) return;
    let cancelled = false;
    const requestedKey = `${provider}:${accountChangedAt ?? ''}`;
    // Read through `getState` so the card does not re-render on every usage
    // refresh elsewhere in the app.
    const refresh =
      useObservabilityStore.getState().refreshProviderUsageSnapshot;
    refresh(provider).then(
      (snapshot) => {
        if (cancelled) return;
        const resumeAt = selectProviderUsageLimitResumeAt(snapshot, provider);
        const resetAt = resumeAt ? Date.parse(resumeAt) : Number.NaN;
        setState(
          Number.isFinite(resetAt) && resetAt > Date.now()
            ? { key: requestedKey, resetAt }
            : null,
        );
      },
      () => {
        if (!cancelled) setState(null);
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [enabled, provider, accountChangedAt]);

  const resetAt = state?.resetAt;
  useEffect(() => {
    if (resetAt === undefined) return;
    return scheduleAt(resetAt, () => setState(null));
  }, [resetAt]);

  return enabled && state?.key === key ? state.resetAt : null;
}

/**
 * Shared "you're using AI Credits for this session" status chip. Rendered once
 * in the universal `ChatInput`, it reflects the authoritative routing state the
 * main process reports for the given chat, so any current or future chat surface
 * shows it without per-surface wiring.
 *
 * It is deliberately suppressed for accounts with no native provider login. A
 * user who has signed in to the cloud account but never logged in to Claude or
 * Codex has AI Credits as their only option, so telling them they are spending
 * credits announces a fact they cannot act on and reads as a warning about a
 * choice they never made. The banner earns its place only when a native
 * subscription exists and credits are being spent anyway — that is actionable.
 * Credits-only users still learn their billing state from the model picker's
 * locked toggle and its Sign-in CTA.
 *
 * The right side names the payer rather than always showing a number. A user
 * funded by their organization's shared pool has an empty personal wallet, and
 * the old chip reported that empty wallet as "0 credits" while the session
 * billed fine elsewhere — a number they could neither act on nor replenish. When
 * the org pool is covering, the chip says so and shows no number at all.
 */
export function AiCreditsRoutingStatusBanner({
  target,
  active,
  turnActive,
  provider,
  onSwitchToSubscription,
  accountChangedAt,
}: AiCreditsRoutingStatusBannerProps): JSX.Element | null {
  const visible = target !== null && active;
  const requestedScope = useChatTargetAiCreditsScope(target);
  const { scope, key: scopeKey } = useStableAiCreditsScope(requestedScope);
  const state = useAiCreditsSessionBalance(
    visible,
    turnActive,
    scope,
    scopeKey,
  );
  // The reset line only accompanies the button: it tells the user whether
  // switching back now would hit the limit again.
  const resetAt = useProviderLimitResetAt(
    visible && onSwitchToSubscription !== undefined,
    provider,
    accountChangedAt,
  );
  if (!visible) {
    return null;
  }
  const funding = resolveAiCreditsFundingSource(state);
  const resetLabel = formatUsageLimitTimeLabel(resetAt ?? undefined);
  const balanceChip =
    funding.kind === 'personal' ? (
      <span
        data-testid="chat-input-ai-credits-balance"
        className="shrink-0 pr-3 font-medium tabular-nums"
      >
        {formatCredits(funding.credits)}
      </span>
    ) : funding.kind === 'org-pool' ? (
      <span
        data-testid="chat-input-ai-credits-covered-by"
        // `min-w-0` + `truncate`, with an explicit ceiling: the trailing
        // slot is content-sized, so without `max-w-*` there would be
        // nothing for `overflow: hidden` to clip and a long org name would
        // push the copy instead of ellipsizing.
        className="min-w-0 max-w-64 truncate pr-3 font-medium"
        title={`Your personal credits are used up, so ${funding.orgName}'s shared credit pool is covering this session.`}
      >
        Covered by {funding.orgName}
      </span>
    ) : undefined;
  const switchButton = onSwitchToSubscription ? (
    <NoticeButton
      variant="primary"
      data-testid="chat-input-ai-credits-switch-to-subscription"
      onClick={onSwitchToSubscription}
    >
      Switch to subscription
    </NoticeButton>
  ) : null;
  return (
    <Notice
      intent="neutral"
      title="Using AI Credits"
      data-testid="chat-input-ai-credits-active"
      {...(provider && resetLabel
        ? {
            detail: (
              <span data-testid="chat-input-ai-credits-limit-resets">
                Your {getModelCatalogProviderLabel(provider)} limit resets at{' '}
                {resetLabel}.
              </span>
            ),
          }
        : {})}
      // The live value rides in the trailing slot so it sits on the message
      // row, right-aligned like a button would. It is plain text with no
      // control chrome, so it sits 20px from the edge (`pr-3` on top of the
      // slot's 8px): 8px deeper than the surface inset, 12px deeper than a
      // button, which is what reads as settled for bare text. The switch
      // button follows it with the slot's 8px gap.
      actions={
        balanceChip || switchButton ? (
          <>
            {balanceChip}
            {switchButton}
          </>
        ) : undefined
      }
    >
      {/* `unknown` is "nothing trustworthy to say" (a blipped balance
          read), so it gets payer-agnostic copy rather than a guess. */}
      {funding.kind === 'org-pool'
        ? `${funding.orgName}'s shared credit pool is covering this session.`
        : funding.kind === 'personal'
          ? 'This session is paid from your credits.'
          : 'This session is paid with AI Credits.'}
    </Notice>
  );
}

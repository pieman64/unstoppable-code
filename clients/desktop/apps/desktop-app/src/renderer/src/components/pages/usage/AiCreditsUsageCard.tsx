import { type JSX } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  computeAiCreditsAlertLevel,
  usageAlertColorClass,
} from '@canopy/desktop-shared/lib/usage-alert';
import { resolveAiCreditsFundingSource } from '@canopy/desktop-shared/lib/ai-credits-funding';
import { resolveCreditsBillingPath } from '@canopy/protocol/billing';
import { Button } from '@canopy/ui-shared';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useAccountProxyStatus } from '@/stores/accountProxyStore';
import { useAiCreditsUsage } from '@/hooks/useAiCreditsUsage';
import { useSubscriptionStatus } from '@/hooks/useSubscriptionStatus';
import { useIsGuestCredential } from '@/hooks/useIsGuestCredential';
import { openSettingsPathOrWeb } from '@/lib/navigation/settings-destinations';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { formatCredits } from '@/lib/ai-credits-format';
import { brandText } from '@/lib/brand';
import { BrandLogo } from '@/components/BrandLogo';
import { UsageCardHeader } from '@canopy/ui-shared/components';
import { usageCardContainerClass } from './usage-card-container';
import { UsageErrorNotice, resolveUsageErrorInfo } from './UsageErrorNotice';
import type { ProviderUsageCardDensity } from './ProviderUsageCards';

interface AiCreditsUsageCardProps {
  /**
   * Drop the card container chrome (border/background/rounded corners) so the
   * content fills its parent — used by the Usage panel's frameless sections.
   * The standalone page keeps the framed card (the default).
   */
  frameless?: boolean;
  /**
   * Trims padding and heading size for small panels. Mirrors the provider
   * cards' prop so the Usage panel can render this card at the same density —
   * they sit in one divided list, so a density mismatch is visible.
   */
  density?: ProviderUsageCardDensity;
}

/**
 * Usage page tile for native Canopy AI Credits. Self-contained: it reads its own
 * data via {@link useAiCreditsUsage} (source-agnostic native balance) plus
 * {@link useSubscriptionStatus} (native plan), and self-hides (returns an empty
 * fragment) unless a native balance resolved for the connected cloud account —
 * except that a failed lookup for a connected account renders an inline
 * {@link UsageErrorNotice} instead of vanishing.
 * Styled to match the provider cards in {@link ProviderUsageCards}.
 */
export function AiCreditsUsageCard({
  frameless = false,
  density = 'comfortable',
}: AiCreditsUsageCardProps = {}): JSX.Element {
  const compact = density === 'compact';
  const { state, routingMode, lastUpdatedAt, refreshing, refresh } =
    useAiCreditsUsage();
  const { status, freeAccess } = useSubscriptionStatus();
  // Free app access has no plan to name, so the chip is omitted outright
  // rather than relying on the hook clearing `status` (CAN-3926).
  const planStatus = freeAccess ? null : status;
  const usage = useObservabilityStore((s) => s.usage);
  const accountProxy = useAccountProxyStatus();
  const isGuest = useIsGuestCredential();
  const billingEnabled = useFeatureFlagsStore((s) =>
    s.isEnabled(CLIENT_FEATURE_FLAGS.canopyBillingEnabled.key),
  );
  const contextHydrated = useWorkspaceContextStore((s) => s.hydrated);
  const workspaceContext = useWorkspaceContextStore((s) => s.state.context);
  const contextOrganizations = useWorkspaceContextStore(
    (s) => s.state.organizations,
  );
  // Manage opens the selected organization's billing for its OWNER, otherwise
  // the person's own, the same rule as the account menu. Hidden with the
  // billing flag off (the account menu's AI Credits row is gated on it too),
  // for guests, who have no billing page, and until the selected context is
  // known.
  const openManageCredits =
    !billingEnabled || isGuest || !contextHydrated
      ? null
      : (): void => {
          openSettingsPathOrWeb(
            resolveCreditsBillingPath(workspaceContext, contextOrganizations),
          );
        };

  // A failed lookup for a connected account renders as an inline error notice
  // instead of silently dropping the tile — the account is native-billed, so
  // "we could not read your balance" is a state worth showing. A still-known
  // balance stays visible alongside the notice.
  const errorInfo =
    state?.connected && state.error
      ? resolveUsageErrorInfo(undefined, state.error)
      : null;

  // Otherwise hide the tile unless a native balance resolved: no state, an
  // error without a connected account, or no balance (disconnected / still
  // loading) all mean AI Credits are not in play, so they do not belong in the
  // active-usage view. A native-billed user with 0 credits still shows
  // (balance is present, credits === 0). Visibility is deliberately
  // independent of `routingMode`: native credits are now the primary billing
  // path, so a resolved balance is shown even when routing is "Never"
  // (`routingMode` still feeds the alert-level calc below).
  if (!state || (!errorInfo && (Boolean(state.error) || !state.balance))) {
    return <></>;
  }

  const balance = state.balance;
  const credits = balance?.credits ?? 0;
  const alertLevel = computeAiCreditsAlertLevel(
    state,
    routingMode,
    usage,
    accountProxy,
  );
  // A same-account failed refresh can retain the previous balance (including
  // its org-pool attribution) while the new error remains visible. The funding
  // resolver normally distrusts errored states, so give it the explicitly
  // preserved balance metadata without hiding the error from the card itself.
  const funding = resolveAiCreditsFundingSource(
    errorInfo && balance ? { ...state, error: null } : state,
  );
  // Native cloud-account email. A guest is excluded: that address is the
  // synthetic `guest+<uuid>@guest.canopy.invalid` identity, not a real billing
  // account, so it must never be shown as "Account:" (CAN-936).
  const accountEmail = isGuest ? null : state.email;

  return (
    <article
      data-testid="usage-card-ai-credits"
      // Shares ProviderUsageCard's container helper so both render identically
      // in the Usage panel's divided list.
      className={usageCardContainerClass({ compact, frameless })}
    >
      <UsageCardHeader
        icon={<BrandLogo width={18} height={18} aria-hidden />}
        title={brandText.appName}
        // BrandLogo is aria-hidden and the visible title is just the brand
        // name, so name the heading explicitly for screen-reader navigation.
        accessibleTitle={`${brandText.appName} AI Credits`}
        // Driven by the credential, not by `accountEmail`: a real signed-in
        // account whose balance payload omits an email is still authenticated.
        authState={isGuest ? 'guest' : 'authenticated'}
        // `status` is non-null exactly when entitlements have resolved, and a
        // genuinely free account resolves to the label `Free`. So passing it
        // through directly (no `?? 'Free'`) means the pill renders only once
        // the plan is actually known: no grey "Free" claim while the request is
        // in flight, and none when it fails (the hook's `.catch` clears
        // entitlements back to null).
        //
        // Deliberately not gated on the hook's `loading`: that field is
        // `billingEnabled && ...` and is set false by the same `.catch`, so it
        // would leave a failed request asserting "Free" — and because it flips
        // true on every account-changed refresh, it would blank the pill and
        // reflow the subtitle row. `refresh()` does not clear `entitlements`,
        // so reading `status` keeps the previous plan visible across a refresh.
        //
        // Note this is NOT gated on the billing feature flag. `status` derives
        // only from resolved entitlements, so a flag-off account still shows
        // its real plan here, whereas the account menu's plan header
        // gates on the hook's `visible` (`billingEnabled && resolved &&
        // signedIn`). Aligning the two is a deliberate follow-up, not part of
        // this consolidation — it would also drop the pill for guests.
        //
        // Under free app access `planStatus` is null, so the chip is omitted:
        // there is no plan to name.
        planLabel={planStatus?.label}
        // `kind`, not `tone`: `tone` is visual emphasis, and the legacy
        // org-seat fallback (older servers omitting `displayPlan`) resolves to
        // `{ kind: 'org', tone: 'neutral' }` — an active plan that must stay
        // green. Preserves the mapping the deleted chip helper used.
        planActive={planStatus?.kind === 'paid' || planStatus?.kind === 'org'}
        planChipTestId="usage-card-ai-credits-plan-chip"
        lastUpdatedAt={lastUpdatedAt}
        refreshing={refreshing}
        onRefresh={(): void => refresh()}
        refreshLabel="Refresh AI Credits usage"
        compact={compact}
        frameless={frameless}
      />

      {accountEmail && (
        // Mirrors ProviderAccountRow: the same spacing/size per density, the
        // "Account:" prefix only on the framed card, and the address itself
        // emphasized. This card sits in the Usage panel's divided list next to
        // the provider cards, so any drift here is visible side by side.
        <p
          className={`min-w-0 truncate fg-secondary ${
            frameless ? 'mt-1 text-xs' : 'mt-4 text-s'
          }`}
          data-testid="usage-card-ai-credits-account"
        >
          {!frameless && 'Account: '}
          <span
            className={`font-medium fg-primary ${POSTHOG_REPLAY_BLOCK_CLASS}`}
          >
            {accountEmail}
          </span>
        </p>
      )}

      {errorInfo && (
        <UsageErrorNotice
          label="AI Credits"
          testIdPrefix="usage-card-ai-credits"
          info={errorInfo}
          onRetry={(): void => refresh()}
          retrying={refreshing}
          frameless={frameless}
        />
      )}

      {balance && (
        <div className="mt-4 space-y-3">
          <div className="rounded-xl border px-3 py-3 text-s">
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium fg-primary">AI Credits</div>
              {openManageCredits && (
                <Button
                  variant="outline"
                  size={compact ? 'compact' : 'sm'}
                  onClick={openManageCredits}
                  data-testid="usage-card-ai-credits-manage"
                >
                  Manage
                </Button>
              )}
            </div>
            <div className="mt-2 space-y-1 text-xs fg-secondary">
              {funding.kind === 'org-pool' ? (
                // The Usage page is an itemized detail view, so it shows both
                // facts: who is paying (the headline) and the personal wallet the
                // zero actually belongs to (muted, secondary). The chat banner
                // shows only the payer, since a number there is unactionable.
                <>
                  <div>
                    <span
                      className={usageAlertColorClass(alertLevel)}
                      data-testid="usage-card-ai-credits-balance"
                    >
                      Covered by {funding.orgName}
                    </span>
                  </div>
                  <div
                    className="fg-tertiary"
                    data-testid="usage-card-ai-credits-personal-balance"
                  >
                    Personal balance: {formatCredits(credits)}
                  </div>
                </>
              ) : (
                <div>
                  Remaining:{' '}
                  <span
                    className={usageAlertColorClass(alertLevel)}
                    data-testid="usage-card-ai-credits-balance"
                  >
                    {formatCredits(credits)}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

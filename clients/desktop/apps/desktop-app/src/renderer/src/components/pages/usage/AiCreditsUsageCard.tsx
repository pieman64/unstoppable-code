import { type JSX } from 'react';
import {
  computeAiCreditsAlertLevel,
  usageAlertColorClass,
} from '@canopy/desktop-shared/lib/usage-alert';
import { resolveAiCreditsFundingSource } from '@canopy/desktop-shared/lib/ai-credits-funding';
import { resolveCreditsBillingPath } from '@canopy/protocol/billing';
import {
  Button,
  ProviderUsageAccountRow,
  UsageGroup,
  UsageRow,
  UsageRowList,
} from '@canopy/ui-shared';
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
import { UsageErrorNotice, resolveUsageErrorInfo } from './UsageErrorNotice';

/**
 * Usage group for native Canopy AI Credits. Self-contained: it reads its own
 * data via {@link useAiCreditsUsage} (source-agnostic native balance) plus
 * {@link useSubscriptionStatus} (native plan), and self-hides (returns an empty
 * fragment) unless a native balance resolved for the connected cloud account —
 * except that a failed lookup for a connected account renders an inline
 * {@link UsageErrorNotice} instead of vanishing.
 * Rendered as the same group as the provider groups in
 * {@link ProviderUsageCards}; the surface owns refresh.
 */
export function AiCreditsUsageCard(): JSX.Element {
  const { state, routingMode, refreshing, refresh } = useAiCreditsUsage();
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

  const balanceDetail = !balance ? null : funding.kind === 'org-pool' ? (
    // The Usage page is an itemized detail view, so it shows both facts: who
    // is paying (the headline) and the personal wallet the zero actually
    // belongs to (muted). The chat banner shows only the payer, since a
    // number there is unactionable.
    <>
      <span
        className={usageAlertColorClass(alertLevel)}
        data-testid="usage-card-ai-credits-balance"
      >
        Covered by {funding.orgName}
      </span>
      {' · '}
      <span data-testid="usage-card-ai-credits-personal-balance">
        Personal balance: {formatCredits(credits)}
      </span>
    </>
  ) : (
    <>
      <span
        className={usageAlertColorClass(alertLevel)}
        data-testid="usage-card-ai-credits-balance"
      >
        {formatCredits(credits)}
      </span>{' '}
      left
    </>
  );

  return (
    <UsageGroup
      // The heading names the brand and its plan, as a provider group names
      // the provider and its plan.
      title={brandText.appName}
      // `status` is non-null exactly when entitlements have resolved, and a
      // genuinely free account resolves to the label `Free`, so the plan only
      // shows once it is actually known. Under free app access `planStatus`
      // is null, so no plan is named. Not gated on the billing feature flag:
      // `status` derives only from resolved entitlements.
      plan={planStatus?.label}
      planTestId="usage-card-ai-credits-plan-chip"
      testId="usage-card-ai-credits"
    >
      <UsageRowList>
        {balanceDetail ? (
          <UsageRow
            title="AI Credits"
            detail={balanceDetail}
            trailing={
              openManageCredits ? (
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={openManageCredits}
                  data-testid="usage-card-ai-credits-manage"
                >
                  Manage
                </Button>
              ) : null
            }
          />
        ) : null}
        {accountEmail ? (
          // A guest's synthetic identity and a balance payload without an
          // email have no account to name, so the row is left out.
          <ProviderUsageAccountRow
            accountLabel={accountEmail}
            statusLabel="Signed in"
            testId="usage-card-ai-credits-account"
          >
            {null}
          </ProviderUsageAccountRow>
        ) : null}
      </UsageRowList>

      {errorInfo && (
        <UsageErrorNotice
          label="AI Credits"
          testIdPrefix="usage-card-ai-credits"
          info={errorInfo}
          onRetry={(): void => refresh()}
          retrying={refreshing}
          frameless
        />
      )}
    </UsageGroup>
  );
}

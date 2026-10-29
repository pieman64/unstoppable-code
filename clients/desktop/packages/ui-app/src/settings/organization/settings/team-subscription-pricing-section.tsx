'use client';
import { useCallback, useEffect, useState, type JSX } from 'react';
import { CreditCard } from '@canopy/ui-shared/icons/AppIcons';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  SettingsFormSkeleton,
} from '@canopy/ui-shared/components';
import type { SubscriptionPlanPricingRow } from '@canopy/protocol/telemetry';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { useSettingsClient } from '../../host';
import { useSettingsErrorCopy, useSettingsLoadErrorCopy } from '../../errors';
import {
  getSubscriptionPlanPricing,
  setSubscriptionPlanPriceOverride,
} from '../team-api';
import { USAGE_KNOWN_LOAD_ERRORS } from '../statistics/usage-error-copy';

/** Logger scope for the plan pricing table. */
const PRICING_ERROR_SCOPE = 'settings.organization.plan-pricing';
import { formatUsd } from '../statistics/format';
import { formatProviderLabel } from '../statistics/run-display';

interface TeamSubscriptionPricingSectionProps {
  detail: OrganizationDetail;
}

/**
 * Org-settings table of the subscription plan types observed across the team,
 * with catalog defaults and editable per-org monthly-price overrides. Plans are
 * grouped by normalized plan key (provider + plan type); individual account
 * emails are never shown. The pricing here feeds the billed-cost and savings
 * estimates on the Statistics → Overview tab.
 *
 * Visible to any member who can view usage stats; the fetched `canEdit` flag
 * (server-derived) controls whether the override inputs are editable.
 */
export function TeamSubscriptionPricingSection({
  detail,
}: TeamSubscriptionPricingSectionProps): JSX.Element | null {
  const client = useSettingsClient();
  const loadErrorCopy = useSettingsLoadErrorCopy(PRICING_ERROR_SCOPE);
  const orgId = detail.id;
  const [plans, setPlans] = useState<SubscriptionPlanPricingRow[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  // A failed load offers Retry; a failed save does not.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyResponse = useCallback(
    (response: { plans: SubscriptionPlanPricingRow[]; canEdit: boolean }) => {
      setPlans(response.plans);
      setCanEdit(response.canEdit);
    },
    [],
  );

  const loadPricing = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    setError(null);
    try {
      applyResponse(await getSubscriptionPlanPricing(client, orgId));
    } catch (err: unknown) {
      setLoadError(loadErrorCopy(err, USAGE_KNOWN_LOAD_ERRORS));
    } finally {
      setLoading(false);
    }
  }, [client, orgId, applyResponse, loadErrorCopy]);

  // Initial load / reload on org switch. This is a genuine external sync
  // (network call) whose success path calls setState; that is the point of
  // the load.
  useEffect(() => {
    void loadPricing();
  }, [loadPricing]);

  if (!detail.canViewUsageStats) {
    return null;
  }

  return (
    <section
      className="rounded-xl bg-card p-5 shadow-sm"
      data-testid="team-subscription-pricing-section"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-subtle fg-accent">
          <CreditCard size={18} />
        </span>
        <div className="flex-1">
          <h2 className="text-m font-semibold fg-primary">
            AI provider plan pricing
          </h2>
          <p className="mt-1 text-s fg-secondary">
            Set the monthly price for each AI provider plan your team uses.
            These prices drive the billed-cost and savings estimates on the
            Statistics tab. We never show individual account emails.
          </p>

          <ErrorBanner
            className="mt-3"
            error={loadError}
            onRetry={() => void loadPricing()}
          />
          <ErrorBanner className="mt-3" error={error} />

          {loading ? (
            <div className="mt-4">
              <DelayedLoadingPlaceholder>
                <SettingsFormSkeleton rows={2} />
              </DelayedLoadingPlaceholder>
            </div>
          ) : loadError ? null : plans.length === 0 ? (
            <p
              className="mt-4 rounded-lg border border-dashed px-4 py-6 text-center text-s fg-secondary"
              data-testid="subscription-pricing-empty"
            >
              No AI provider plans observed yet. Plans appear here once your
              team drives agent work through an AI provider plan.
            </p>
          ) : (
            <ul className="mt-4 flex flex-col divide-y overflow-hidden rounded-lg border">
              {plans.map((plan) => (
                <PlanRow
                  key={plan.planKey}
                  client={client}
                  orgId={orgId}
                  plan={plan}
                  canEdit={canEdit}
                  onSaved={applyResponse}
                  onError={setError}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

interface PlanRowProps {
  client: AccountOrganizationSettingsClient;
  orgId: string;
  plan: SubscriptionPlanPricingRow;
  canEdit: boolean;
  onSaved: (response: {
    plans: SubscriptionPlanPricingRow[];
    canEdit: boolean;
  }) => void;
  onError: (message: string | null) => void;
}

function PlanRow({
  client,
  orgId,
  plan,
  canEdit,
  onSaved,
  onError,
}: PlanRowProps): JSX.Element {
  const [draft, setDraft] = useState<string>(
    plan.overrideMonthlyUsd === null ? '' : String(plan.overrideMonthlyUsd),
  );
  const [saving, setSaving] = useState(false);
  const errorCopy = useSettingsErrorCopy(PRICING_ERROR_SCOPE);

  const commit = async (monthlyPriceUsd: number | null): Promise<void> => {
    try {
      setSaving(true);
      onError(null);
      const response = await setSubscriptionPlanPriceOverride(
        client,
        orgId,
        plan.planKey,
        monthlyPriceUsd,
      );
      onSaved(response);
    } catch (err: unknown) {
      onError(errorCopy.actionCopy(err, { action: 'save the plan price' }));
    } finally {
      setSaving(false);
    }
  };

  const handleSave = (): void => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      void commit(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      onError('Enter a valid non-negative monthly price.');
      return;
    }
    void commit(parsed);
  };

  const handleClear = (): void => {
    setDraft('');
    void commit(null);
  };

  const effectiveLabel =
    plan.effectiveMonthlyUsd === null
      ? 'Unpriced'
      : formatUsd(plan.effectiveMonthlyUsd);
  const defaultLabel =
    plan.defaultMonthlyUsd === null
      ? 'No default'
      : `${formatUsd(plan.defaultMonthlyUsd)}/mo default`;

  return (
    <li
      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
      data-testid={`subscription-plan-row-${plan.planKey}`}
    >
      <div className="min-w-0">
        <p className="text-s font-medium fg-primary">
          {plan.label}{' '}
          <span className="text-xs font-normal fg-secondary">
            {formatProviderLabel(plan.provider)}
          </span>
        </p>
        <p className="text-xs fg-secondary">
          {plan.accountCount} account{plan.accountCount === 1 ? '' : 's'} ·{' '}
          {defaultLabel} · effective {effectiveLabel}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs fg-secondary">
            $
          </span>
          <input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            value={draft}
            disabled={!canEdit || saving}
            aria-label={`Monthly price override for ${plan.label}`}
            data-testid={`subscription-plan-price-input-${plan.planKey}`}
            placeholder={
              plan.defaultMonthlyUsd === null
                ? '0.00'
                : plan.defaultMonthlyUsd.toFixed(2)
            }
            onChange={(event) => setDraft(event.target.value)}
            className="w-28 rounded-md border bg-card py-1.5 pl-5 pr-2 text-s fg-primary disabled:opacity-50"
          />
        </div>
        {canEdit ? (
          <>
            <button
              type="button"
              disabled={saving}
              data-testid={`subscription-plan-price-save-${plan.planKey}`}
              onClick={handleSave}
              className="rounded-md bg-accent px-3 py-1.5 text-s font-medium fg-emphasis transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              Save
            </button>
            {plan.overrideMonthlyUsd !== null ? (
              <button
                type="button"
                disabled={saving}
                data-testid={`subscription-plan-price-clear-${plan.planKey}`}
                onClick={handleClear}
                className="rounded-md border px-3 py-1.5 text-s font-medium fg-secondary transition-colors hover:fg-primary disabled:opacity-50"
              >
                Clear
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  );
}

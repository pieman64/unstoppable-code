'use client';

import { useCallback, useState, type JSX } from 'react';
import { AI_CREDITS_LABEL } from '@canopy/ui-shared';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import {
  canEditOrg,
  canEditOrgEnforcedSettings,
  canEditUsageStatsConfig,
} from '@canopy/protocol/settings/organization-permissions';
import {
  useSettingsPathname,
  useSettingsRouter,
  useSettingsSearchParams,
} from '../../host';
import type { TeamLapsedInfo } from '../team-page';
import { SubTabNav } from '../SubTabNav';
import { TeamBrandingSettingsSection } from '../team-branding-settings-section';
import { TeamDigestSettingsSection } from '../team-digest-settings-section';
import { TeamGitHubConnectionSection } from '../team-github-connection-section';
import {
  TeamDataSharingSection,
  TeamStatisticsVisibilitySection,
} from '../team-usage-settings-section';
import { TeamModelPolicySection } from '../team-model-policy-section';
import { TeamModelGatewaySection } from '../team-model-gateway-section';
import { TeamMemorySettingsSection } from '../team-memory-settings-section';
import { TeamSubscriptionPricingSection } from './team-subscription-pricing-section';
import { useOrganizationSettingsSubtabSlots } from './organization-settings-subtab-slots';
import { canManageOrganizationExternalAgents } from './external-agents-policy';
import { TeamBillingSection } from '../../billing/team-billing-section';
import { TeamDangerZone } from '../team-danger-zone';

type SettingsTab =
  | 'general'
  | 'policies'
  | 'integrations'
  | 'usage'
  | 'billing';

/**
 * Bar order follows the convention GitHub, Linear, and Notion org settings all
 * share: identity first, then the org-wide rules, then per-tool config, then
 * the commercial surfaces last and adjacent to each other. Usage sits beside
 * Billing because provider pricing is cost input, not feature config, and
 * splitting the two was the main thing wrong with the original ordering.
 * Billing's tail position costs it no discoverability: the bar is five items
 * wide with nothing scrolled off, and the tab carries its own attention dot.
 */
const SETTINGS_TABS: ReadonlyArray<{ key: SettingsTab; label: string }> = [
  { key: 'general', label: 'General' },
  { key: 'policies', label: 'Policies' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'usage', label: 'Usage' },
  { key: 'billing', label: 'Billing' },
];

/** Omitted from the URL when the active tab matches, so General has a bare URL. */
const DEFAULT_TAB: SettingsTab = 'general';

/** Validate the `tab` query param, falling back to the default settings tab. */
function parseSettingsTab(value: string | null): SettingsTab {
  switch (value) {
    case 'general':
    case 'policies':
    case 'integrations':
    case 'usage':
    case 'billing':
      return value;
    default:
      return DEFAULT_TAB;
  }
}

interface TeamSettingsSectionProps {
  detail: OrganizationDetail;
  /** Each card's mutations return a fresh detail for the page to hold. */
  onDetailChange: (detail: OrganizationDetail) => void;
  onBillingChanged?: () => void;
  /** Whether organization memory is rolled out for this org. */
  memoryEnabled: boolean;
  /**
   * Whether the `canopy-billing-enabled` flag is on for this viewer. The Billing
   * subtab only appears when this is true and the viewer can edit the org.
   */
  billingEnabled: boolean;
  /**
   * Whether the org's billing needs an action the viewer can take. Renders an
   * attention dot on the Billing subtab, matching the one the parent puts on
   * the top-level Settings tab.
   */
  billingNeedsAttention: boolean;
  /**
   * Server-resolved free app access (CAN-3926). The Billing subtab keeps its
   * `billing` key and `?tab=billing` URL, so existing deep links still land,
   * but is named "AI Credits" and shows credits, payment method, and receipts
   * without the subscription plan.
   */
  freeAccess?: boolean;
  /**
   * Non-null when the org has LOST the `teams` capability (CAN-2311). Carried
   * as the info object (not a boolean) so this stays a straight move of the
   * `lapsed === null` conditions from `team-page.tsx`.
   */
  lapsed: TeamLapsedInfo | null;
  /** Called after the org is deleted so the page can navigate away. */
  onDeleted: () => void;
  /**
   * Whether outside agents (the hosted MCP servers) are on for this viewer.
   * With it, and a host that supplies `renderExternalAgentsPolicy`, an OWNER
   * of a non-Personal org gets the External agents card in Policies, even
   * while the org is lapsed.
   */
  externalAgentsEnabled?: boolean;
}

/**
 * Settings tab content, split into deep-linkable subtabs (`?tab=`) so an admin
 * lands on a short themed page instead of scrolling past six unrelated cards to
 * reach the one they came for.
 *
 * Every card already self-gates by role (returns `null`), so the work here is
 * only to keep the subtab bar honest: a tab whose every card would render
 * nothing is not advertised, and a bar with fewer than two tabs is dropped
 * entirely (a plain MEMBER who can view stats then sees just the pricing card,
 * as before the split).
 */
export function TeamSettingsSection({
  detail,
  onDetailChange,
  onBillingChanged,
  memoryEnabled,
  billingEnabled,
  billingNeedsAttention,
  freeAccess = false,
  lapsed,
  onDeleted,
  externalAgentsEnabled = false,
}: TeamSettingsSectionProps): JSX.Element {
  const pathname = useSettingsPathname();
  const searchParams = useSettingsSearchParams();
  const router = useSettingsRouter();
  const { replaceSubtabHref, renderExternalAgentsPolicy } =
    useOrganizationSettingsSubtabSlots();

  const canEdit = canEditOrg(detail.viewerRole);

  // While lapsed, render only the sections whose actions the server still
  // permits. Branding (`updateOrganization` / `setOrganizationLogo`), GitHub
  // disconnect, and the danger zone (`deleteOrganization` /
  // `leaveOrganization`) are all EXEMPT, so they stay. The config sections
  // route through `updateOrganizationConfig`, which IS gated — showing them
  // would offer controls whose every save 403s.
  const healthy = lapsed === null;

  // Per-tab visibility mirrors the predicates each card self-gates on, so the
  // bar never offers a tab that renders an empty page.
  // Branding needs `canEditOrg`; the danger zone needs OWNER, which is a
  // subset, so `canEdit` alone decides the tab.
  const showGeneral = canEdit;
  // Deliberately NOT gated on `healthy`: billing is the one surface that undoes
  // a lapse, so a lapsed OWNER must still reach it. This mirrors the gate the
  // deleted `/organization/[orgId]/billing` route carried before the move.
  const showBilling = billingEnabled && canEdit;
  // The owner's control over members' outside agents. Deliberately NOT gated
  // on `healthy`: the policy and per-agent removal are security controls the
  // server keeps editable while lapsed, so a lapsed OWNER must still reach
  // them. Its predicate is OWNER-only, non-Personal, and flag-on, and only a
  // host that serves the hosted MCP servers supplies the card.
  const showExternalAgents =
    renderExternalAgentsPolicy !== undefined &&
    canManageOrganizationExternalAgents(detail, externalAgentsEnabled);
  // Data sharing and model policy both gate on `canEditOrgEnforcedSettings`.
  // Memory additionally needs `memoryEnabled && canEditMemorySettings`, which
  // is narrower and so never widens the tab beyond these two. The External
  // agents card keeps the tab for a lapsed owner; the other Policies cards
  // stay behind `healthy` inside the tab.
  const showEnforcedPolicies =
    healthy && canEditOrgEnforcedSettings(detail.viewerRole);
  const showPolicies = showEnforcedPolicies || showExternalAgents;
  const showUsage =
    (healthy && canEditUsageStatsConfig(detail.viewerRole)) ||
    detail.canViewUsageStats;
  // Disconnect is EXEMPT, but `startGitHubConnect` is GATED, and the section
  // renders a live "Connect" button whenever the org is not connected. Showing
  // it to a lapsed org that never connected offers a CTA that 403s -- the same
  // reason the config sections are suppressed. While lapsed, keep it only when
  // there is an existing connection to revoke.
  const showIntegrations =
    canEdit && (healthy || detail.githubConnection.connected);

  const visible: Record<SettingsTab, boolean> = {
    general: showGeneral,
    policies: showPolicies,
    integrations: showIntegrations,
    usage: showUsage,
    billing: showBilling,
  };
  const visibleTabs = SETTINGS_TABS.filter((tab) => visible[tab.key]).map(
    (tab) => {
      if (tab.key !== 'billing') return tab;
      const named = freeAccess ? { ...tab, label: AI_CREDITS_LABEL } : tab;
      return billingNeedsAttention ? { ...named, attention: true } : named;
    },
  );

  // The tab switches locally and is mirrored into the URL (below), so a
  // click paints the new panel at once instead of after a server round trip.
  // A URL change from outside (Back, a link) resets it to the URL's answer.
  const query = searchParams.toString();
  // The local tab only bridges the moment before the host syncs the URL: while
  // the query is still the one the switch started from. Once the query moves
  // (synced to the new tab, or a navigation elsewhere), the URL is the answer
  // again, so a later return to the old query shows the old query's tab.
  const [local, setLocal] = useState<{
    readonly from: string;
    readonly tab: SettingsTab;
  } | null>(null);
  if (local !== null && local.from !== query) setLocal(null);
  const localTab = local !== null && local.from === query ? local.tab : null;

  // A stale or hidden `?tab=` falls back to the first visible tab rather than
  // 404ing or rewriting the URL on load.
  const requestedTab = localTab ?? parseSettingsTab(searchParams.get('tab'));
  const activeTab: SettingsTab = visible[requestedTab]
    ? requestedTab
    : (visibleTabs[0]?.key ?? DEFAULT_TAB);

  /**
   * Switch the tab here and merge it into the current query string. The
   * default tab deletes its key so General collapses back to a bare
   * `/organization/<id>/settings`.
   *
   * The host's `replaceSubtabHref` slot when it supplies one, otherwise
   * `router.replace(href, { scroll: false })`. Web supplies
   * `window.history.replaceState`: its router re-ran the server page
   * (`loadTeamPageData()`) on every switch, and since the tab was derived
   * from the URL alone, neither the pressed state nor the panel changed until
   * that round trip resolved. Next keeps `useSearchParams` in step with the
   * native history call, so the tab stays in the URL (shareable and
   * bookmarkable) without the reload. A host without the slot replaces its
   * own route, which carries the subtab and the rest of the query.
   *
   * REPLACE, not push — so subtab switches are deliberately NOT in the browser
   * history. Back from Settings → Billing returns to whatever preceded the
   * settings page, not to the previously viewed subtab. That is a real change
   * for Billing, which used to be a top-level `Link` (and therefore pushed),
   * and it is the intended trade: these are in-page view switches, and one
   * history entry per tab click would make Back feel broken on the way out of
   * a page a user just clicked through. `selectTab` is pinned to this
   * semantics by test so the choice cannot be flipped silently.
   */
  const selectTab = useCallback(
    (tab: SettingsTab): void => {
      const next = new URLSearchParams(searchParams.toString());
      if (tab === DEFAULT_TAB) {
        next.delete('tab');
      } else {
        next.set('tab', tab);
      }
      // One-shot confirmation flag from the GitHub install callback. Drop it on
      // the first manual switch so it cannot ride along and re-fire against a
      // later tab.
      next.delete('github');
      // Same shape of one-shot intent flag, forwarded by `/subscribe` and read
      // by `TeamBillingSection`. Dropped here so an upgrade intent aimed at
      // Billing cannot ride along to Policies and re-apply itself there.
      next.delete('plan');
      const qs = next.toString();
      const href = qs ? `${pathname}?${qs}` : pathname;
      setLocal({ from: searchParams.toString(), tab });
      if (replaceSubtabHref !== undefined) {
        replaceSubtabHref(href);
      } else {
        router.replace(href, { scroll: false });
      }
    },
    [pathname, replaceSubtabHref, router, searchParams],
  );

  /**
   * Renders one tab's cards. Only ever called with a tab that passed the
   * `visible` map above, so this must NOT re-check the visibility predicates:
   * the map is the single source of truth, and duplicating the rule here lets
   * the two copies drift into a silently blank tab. Guards that are narrower
   * than their tab's predicate (the `healthy` check on the stats-visibility
   * card, which Usage can outlive via `canViewUsageStats`) do still belong.
   *
   * The `JSX.Element` return type (not `| null`) is what enforces that: a tab
   * that tries to gate itself here fails to compile rather than degrading to a
   * silently blank panel.
   */
  const renderTab = (tab: SettingsTab): JSX.Element => {
    switch (tab) {
      case 'general':
        return (
          <>
            <TeamBrandingSettingsSection
              detail={detail}
              onDetailChange={onDetailChange}
            />

            {/*
             * Digest cadences are org-wide config, so they belong beside
             * branding rather than in Policies (which is reserved for the
             * settings an org ENFORCES on its members). The card self-gates on
             * `canEditOrg` — the same predicate that makes this tab visible —
             * and on the digests flag, so a flag-off org sees General exactly
             * as it looks today.
             */}
            <TeamDigestSettingsSection
              orgId={detail.id}
              viewerRole={detail.viewerRole}
            />

            {/* Danger zone stays pinned to the bottom of General. */}
            <TeamDangerZone detail={detail} onDeleted={onDeleted} />
          </>
        );
      case 'billing':
        // Reads `?plan=` via `useSearchParams` to honour the upgrade intent
        // forwarded by `/subscribe`; the Suspense boundary it needs for that is
        // already around this whole section in `team-page.tsx`.
        return (
          <TeamBillingSection
            detail={detail}
            onBillingChanged={onBillingChanged}
            freeAccess={freeAccess}
          />
        );
      case 'policies':
        return (
          <>
            {showEnforcedPolicies && (
              <>
                <TeamDataSharingSection
                  detail={detail}
                  onDetailChange={onDetailChange}
                />

                {/*
                 * Sits directly after data sharing: the two org-enforced
                 * MEMBER policies belong together, ahead of feature config.
                 */}
                <TeamModelPolicySection
                  detail={detail}
                  freeAccess={freeAccess}
                />

                {/*
                 * Last of the three member policies: model access says WHICH
                 * models, the gateway says WHERE they run. Reading
                 * availability before the data path matches how admins
                 * describe it.
                 */}
                <TeamModelGatewaySection
                  detail={detail}
                  freeAccess={freeAccess}
                />
              </>
            )}

            {/*
             * After the member policies and before feature config: what
             * members' outside agents may do here is also a rule the org
             * enforces on its members.
             */}
            {showExternalAgents && renderExternalAgentsPolicy?.(detail)}

            {showEnforcedPolicies && (
              <TeamMemorySettingsSection
                orgId={detail.id}
                orgName={detail.name}
                viewerRole={detail.viewerRole}
                memoryEnabled={memoryEnabled}
              />
            )}
          </>
        );
      case 'usage':
        return (
          <>
            {healthy && (
              <TeamStatisticsVisibilitySection
                detail={detail}
                onDetailChange={onDetailChange}
              />
            )}

            <TeamSubscriptionPricingSection detail={detail} />
          </>
        );
      case 'integrations':
        return (
          <TeamGitHubConnectionSection
            detail={detail}
            onDetailChange={onDetailChange}
          />
        );
    }
  };

  // Below two visible tabs there is nothing to switch between, so the bar would
  // be noise: render the cards directly, as this tab did before the split.
  if (visibleTabs.length < 2) {
    return (
      <div className="flex flex-col gap-6" data-testid="team-settings-section">
        {visibleTabs.map((tab) => (
          <div key={tab.key} className="flex flex-col gap-6">
            {renderTab(tab.key)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="team-settings-section">
      <SubTabNav
        tabs={visibleTabs}
        activeTab={activeTab}
        onSelect={selectTab}
        testIdPrefix="team-settings"
        ariaLabel="Organization settings"
        variant="underline"
      />

      {renderTab(activeTab)}
    </div>
  );
}

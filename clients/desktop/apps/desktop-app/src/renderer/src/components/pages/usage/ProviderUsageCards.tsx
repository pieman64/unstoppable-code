import { OpenCodeAccountCard } from '@canopy/ui-shared';
import { getCursorSettingsSection } from '@/lib/cursor-settings';
/* eslint-disable react-refresh/only-export-components -- exports the shared
   provider-selection helpers (reused by the Usage panel) alongside the card
   components; splitting them would fragment a single cohesive display module. */
import { type JSX, useCallback, useState } from 'react';
import type {
  AgentUsageOverview,
  AgentProviderType,
  ProviderUsageSummary,
} from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { AgentProviderIcon } from '@/lib/providerUi';
import {
  getModelCatalogProviderLabel,
  ProviderUsageAccountRow,
} from '@canopy/ui-shared';
import { UsageCardHeader } from '@canopy/ui-shared/components';
import { usageCardContainerClass } from './usage-card-container';
import { OtherAccountSnapshots } from './OtherAccountSnapshots';
import { LimitSubCardView } from '@canopy/ui-shared/components';
import { ACCOUNT_BUTTON_PRIMARY } from '@/lib/account-button-styles';
import { AuthLoginModal } from '@/components/settings/AuthLoginModal';
import {
  invalidateClaudeAuthStatusCache,
  useClaudeAuthStatus,
} from '@/hooks/useClaudeAuthStatus';
import {
  invalidateCodexAuthStatusCache,
  useCodexAuthStatus,
} from '@/hooks/useCodexAuthStatus';
import { useUsageLimitedSessionCount } from '@/hooks/useUsageLimitedSessionCount';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import { hasBlockingRateLimit } from '@/lib/usage-limit/resume-availability';
import { buildSubCards } from './usage-sub-cards';
import { UsageErrorNotice, resolveUsageErrorInfo } from './UsageErrorNotice';
import { AccountProxyUsageSection } from './AccountProxyUsageSection';
import {
  refreshAccountProxyStatus,
  useAccountProxyStore,
  useProviderAccountSource,
} from '@/stores/accountProxyStore';

type UsageLoginProvider = Extract<AgentProviderType, 'claude' | 'codex'>;
type LoginProviderUsageSummary = ProviderUsageSummary & {
  provider: UsageLoginProvider;
};

export type UsageAccountProvider =
  | UsageLoginProvider
  | 'cursor'
  | 'copilot'
  | 'opencode';
export type AccountProviderUsageSummary =
  | LoginProviderUsageSummary
  | (ProviderUsageSummary & { provider: 'cursor' })
  | (ProviderUsageSummary & { provider: 'copilot' });

/** Visual density of a provider usage card. `compact` trims padding and header
 * size for small panel containers; the standalone page uses `comfortable`. */
export type ProviderUsageCardDensity = 'comfortable' | 'compact';

interface ProviderUsageCardsProps {
  nowMs: number;
  usage: AgentUsageOverview;
  refreshingProviders: Set<AgentProviderType>;
  refreshProviderUsage: (provider: AgentProviderType) => Promise<void>;
  refreshProviderUsageDetails: (
    provider: AgentProviderType,
  ) => Promise<AgentUsageOverview>;
}

interface ProviderAccountRowProps {
  provider: LoginProviderUsageSummary;
  refreshProviderUsageDetails: (
    provider: AgentProviderType,
  ) => Promise<AgentUsageOverview>;
  /** Panel-optimized density: smaller text, tighter spacing, no "Account:"
   * prefix. The standalone page keeps the full row. */
  frameless?: boolean;
}

function ProviderAccountRow({
  provider,
  refreshProviderUsageDetails,
  frameless = false,
}: ProviderAccountRowProps): JSX.Element {
  const [loginOpen, setLoginOpen] = useState(false);
  const claudeStatus = useClaudeAuthStatus(0);
  const codexStatus = useCodexAuthStatus(0);
  const authStatus =
    provider.provider === 'claude' ? claudeStatus : codexStatus;

  // Use the provider snapshot while the live probe is loading, then let the
  // fresher probe win so an out-of-band logout cannot leave stale account UI.
  const snapshotAuthenticated = provider.authState === 'authenticated';
  const authenticated =
    authStatus === null ? snapshotAuthenticated : authStatus.authenticated;
  const snapshotAccountLabel = provider.accountLabel ?? provider.accountEmail;
  const liveAccountLabel = authStatus?.accountLabel ?? authStatus?.accountEmail;
  const accountLabel = authenticated
    ? (liveAccountLabel ?? snapshotAccountLabel ?? null)
    : null;
  const statusLabel = authenticated
    ? 'Signed in'
    : authStatus === null && provider.authState !== 'unauthenticated'
      ? 'Checking account…'
      : 'Sign in to see usage';

  const handleCloseLoginModal = useCallback((): void => {
    setLoginOpen(false);
    if (provider.provider === 'claude') {
      invalidateClaudeAuthStatusCache();
    } else {
      invalidateCodexAuthStatusCache();
    }
    void refreshProviderUsageDetails(provider.provider);
  }, [provider.provider, refreshProviderUsageDetails]);

  return (
    <>
      <ProviderUsageAccountRow
        accountLabel={accountLabel}
        statusLabel={statusLabel}
        frameless={frameless}
      >
        <button
          type="button"
          onClick={(): void => setLoginOpen(true)}
          disabled={authStatus === null && provider.authState === 'unknown'}
          data-testid={`usage-provider-${provider.provider}-connect`}
          className={`shrink-0 ${ACCOUNT_BUTTON_PRIMARY}`}
        >
          {authenticated ? 'Change account' : 'Sign in'}
        </button>
      </ProviderUsageAccountRow>
      {loginOpen && (
        <AuthLoginModal
          provider={provider.provider}
          onClose={handleCloseLoginModal}
        />
      )}
    </>
  );
}

interface ManagedAccountRowProps {
  provider: ProviderUsageSummary & { provider: 'cursor' | 'copilot' };
  frameless: boolean;
}

/** Managed harness accounts use their existing connection settings. */
function ManagedAccountRow({
  provider,
  frameless,
}: ManagedAccountRowProps): JSX.Element {
  const openSettings = useNavigationStore((state) => state.openSettings);
  const accountLabel =
    provider.authState === 'authenticated'
      ? (provider.accountLabel ?? provider.accountEmail ?? null)
      : null;
  const statusLabel =
    provider.authState === 'authenticated'
      ? 'Signed in'
      : provider.authState === 'unauthenticated'
        ? 'Sign in to see usage'
        : 'Checking account…';

  const label = getModelCatalogProviderLabel(provider.provider);
  return (
    <ProviderUsageAccountRow
      accountLabel={accountLabel}
      statusLabel={statusLabel}
      frameless={frameless}
    >
      <button
        type="button"
        onClick={(): void =>
          openSettings(
            provider.provider === 'copilot'
              ? 'experiments'
              : getCursorSettingsSection(),
          )
        }
        data-testid={`usage-provider-${provider.provider}-manage`}
        className={`shrink-0 ${ACCOUNT_BUTTON_PRIMARY}`}
      >
        Manage {label}
      </button>
    </ProviderUsageAccountRow>
  );
}

interface UsageLimitedResumeButtonProps {
  provider: LoginProviderUsageSummary;
  nowMs: number;
  frameless: boolean;
}

/**
 * Info-themed "Resume" affordance for sessions (chats and pipelines) that hit
 * this provider's usage limit. Rendered only while resuming could actually
 * succeed: at least one interrupted session is recorded and no rate-limit
 * window is confirmed still at 100% (a window whose reset time has passed is
 * treated as stale, not blocking). Opens the same resume modal the
 * account-change flow uses, and stays for follow-up rounds after a partial
 * resume until nothing resumable is left.
 */
function UsageLimitedResumeButton({
  provider,
  nowMs,
  frameless,
}: UsageLimitedResumeButtonProps): JSX.Element | null {
  const sessionCount = useUsageLimitedSessionCount(provider.provider, nowMs);
  const openResumePrompt = useUsageLimitResumePromptStore((s) => s.open);

  if (sessionCount === 0 || hasBlockingRateLimit(provider.rateLimits, nowMs)) {
    return null;
  }

  return (
    <div className={frameless ? 'mt-2' : 'mt-4'}>
      <button
        type="button"
        data-testid={`usage-provider-${provider.provider}-resume`}
        onClick={(): void =>
          openResumePrompt(provider.provider, 'usage-review')
        }
        className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-fg-info/30 bg-info-subtle px-2.5 py-1.5 text-xs font-medium fg-info transition hover:bg-info-subtle/80"
      >
        Resume {sessionCount} interrupted session
        {sessionCount === 1 ? '' : 's'}…
      </button>
    </div>
  );
}

function isAccountProviderUsageSummary(
  provider: ProviderUsageSummary,
): provider is AccountProviderUsageSummary {
  return (
    provider.provider === 'claude' ||
    provider.provider === 'codex' ||
    provider.provider === 'cursor' ||
    provider.provider === 'copilot'
  );
}

/** Account-usage summaries in wire order, respecting the Cursor rollout. */
export function selectAccountProviderUsageSummaries(
  usage: AgentUsageOverview,
  cursorEnabled = true,
  copilotEnabled = true,
): AccountProviderUsageSummary[] {
  return usage.providers
    .filter(isAccountProviderUsageSummary)
    .filter((provider) => cursorEnabled || provider.provider !== 'cursor')
    .filter((provider) => copilotEnabled || provider.provider !== 'copilot');
}

interface ProviderUsageCardProps {
  provider: AccountProviderUsageSummary;
  nowMs: number;
  /** Retained snapshots for OTHER accounts of this provider. */
  snapshots: AgentUsageOverview['accountSnapshots'];
  refreshingProviders: Set<AgentProviderType>;
  refreshProviderUsage: (provider: AgentProviderType) => Promise<void>;
  refreshProviderUsageDetails: (
    provider: AgentProviderType,
  ) => Promise<AgentUsageOverview>;
  density?: ProviderUsageCardDensity;
  /**
   * Drop the card container chrome (border/background/rounded corners) so the
   * content fills its parent. The Usage panel renders frameless sections
   * separated by dividers; the standalone page keeps the framed card.
   */
  frameless?: boolean;
}

/**
 * One provider's usage card — header (icon/label/auth/subscription + refresh),
 * account row, live remaining-limit sub-cards, retained other-account
 * snapshots, and any error. Shared by the standalone Usage page (via
 * {@link ProviderUsageCards}) and the Usage panel, so both surfaces render
 * identical content. `density` trims padding/heading size for small panels;
 * `frameless` strips the card box so the content fills the panel.
 */
export function ProviderUsageCard({
  provider,
  nowMs,
  snapshots,
  refreshingProviders,
  refreshProviderUsage,
  refreshProviderUsageDetails,
  density = 'comfortable',
  frameless = false,
}: ProviderUsageCardProps): JSX.Element {
  const compact = density === 'compact';
  const proxyHarness =
    provider.provider === 'claude' || provider.provider === 'codex'
      ? provider.provider
      : undefined;
  const proxied = useProviderAccountSource(proxyHarness) === 'account-proxy';
  const proxyRefreshedAt = useAccountProxyStore(
    (state) => state.status?.refreshedAt ?? null,
  );
  const proxyRefreshing = useAccountProxyStore((state) => state.refreshing);
  const providerLabel = getModelCatalogProviderLabel(provider.provider);

  return (
    <article
      data-testid={`usage-provider-card-${provider.provider}`}
      className={usageCardContainerClass({ compact, frameless })}
    >
      <UsageCardHeader
        icon={
          <AgentProviderIcon
            provider={provider.provider}
            width={18}
            height={18}
          />
        }
        title={providerLabel}
        authState={provider.authState}
        {...(proxied
          ? {
              authLabel: 'via account proxy',
              planActive: false,
              lastUpdatedAt: proxyRefreshedAt,
              refreshing: proxyRefreshing,
              onRefresh: (): void => {
                void refreshAccountProxyStatus();
              },
            }
          : {
              planLabel: provider.subscriptionLabel,
              planActive: provider.authState === 'authenticated',
              lastUpdatedAt: provider.lastUpdatedAt,
              refreshing: refreshingProviders.has(provider.provider),
              onRefresh: (): void => {
                void refreshProviderUsage(provider.provider);
              },
            })}
        planChipTestId={`usage-provider-${provider.provider}-plan-chip`}
        refreshLabel={`Refresh ${providerLabel} usage`}
        compact={compact}
        frameless={frameless}
      />

      {proxied &&
      (provider.provider === 'claude' || provider.provider === 'codex') ? (
        <>
          <AccountProxyUsageSection
            harness={provider.provider}
            nowMs={nowMs}
            frameless={frameless}
          />
          <UsageLimitedResumeButton
            provider={provider}
            nowMs={nowMs}
            frameless={frameless}
          />
        </>
      ) : (
        <ProviderUsageDetails
          provider={provider}
          nowMs={nowMs}
          snapshots={snapshots}
          refreshingProviders={refreshingProviders}
          refreshProviderUsage={refreshProviderUsage}
          refreshProviderUsageDetails={refreshProviderUsageDetails}
          frameless={frameless}
        />
      )}
    </article>
  );
}

/** The user's own sign-in on this device: its account, limits, and errors. */
function ProviderUsageDetails({
  provider,
  nowMs,
  snapshots,
  refreshingProviders,
  refreshProviderUsage,
  refreshProviderUsageDetails,
  frameless,
}: Omit<ProviderUsageCardProps, 'density' | 'frameless'> & {
  frameless: boolean;
}): JSX.Element {
  const subCards = buildSubCards(provider.provider, provider.rateLimits);
  const errorInfo = resolveUsageErrorInfo(provider.errorInfo, provider.error);
  return (
    <>
      {provider.provider === 'cursor' || provider.provider === 'copilot' ? (
        <ManagedAccountRow provider={provider} frameless={frameless} />
      ) : (
        <>
          <ProviderAccountRow
            provider={provider}
            refreshProviderUsageDetails={refreshProviderUsageDetails}
            frameless={frameless}
          />
          <UsageLimitedResumeButton
            provider={provider}
            nowMs={nowMs}
            frameless={frameless}
          />
        </>
      )}

      {subCards.length > 0 ? (
        <div className={`space-y-3 ${frameless ? 'mt-2' : 'mt-4'}`}>
          {subCards.map((card) => (
            <LimitSubCardView
              key={`${provider.provider}-${card.key}`}
              card={card}
              nowMs={nowMs}
              frameless={frameless}
            />
          ))}
        </div>
      ) : (
        // The error notice below already explains why no live data is
        // available, so the placeholder only renders for the error-free case.
        !errorInfo && (
          <p className={`text-s fg-secondary ${frameless ? 'mt-2' : 'mt-4'}`}>
            No live remaining-limit data is available for this provider in the
            current session.
          </p>
        )
      )}

      <OtherAccountSnapshots
        provider={provider.provider}
        activeEmail={provider.accountEmail}
        activeSubscriptionLabel={provider.subscriptionLabel}
        snapshots={snapshots ?? []}
        nowMs={nowMs}
      />

      {errorInfo && (
        <UsageErrorNotice
          label={getModelCatalogProviderLabel(provider.provider)}
          testIdPrefix={`usage-provider-${provider.provider}`}
          info={errorInfo}
          onRetry={(): void => {
            void refreshProviderUsage(provider.provider);
          }}
          retrying={refreshingProviders.has(provider.provider)}
          showingRetainedUsage={subCards.length > 0}
          frameless={frameless}
        />
      )}
    </>
  );
}

/** Also exposes shutdown checkpoints for local models and non-agent pipelines. */
interface ShutdownResumeButtonProps {
  nowMs: number;
}

export function ShutdownResumeButton({
  nowMs,
}: ShutdownResumeButtonProps): JSX.Element | null {
  const count = useUsageLimitedSessionCount(null, nowMs);
  const open = useUsageLimitResumePromptStore((state) => state.open);
  if (!count) return null;
  return (
    <button
      type="button"
      data-testid="usage-shutdown-resume"
      className="focus-ring rounded-md ring-1 ring-fg-info/30 bg-info-subtle px-2.5 py-1.5 text-xs font-medium fg-info"
      onClick={() => open(null, 'app-restart')}
    >
      Resume {count} session{count === 1 ? '' : 's'} paused when the application
      stopped…
    </button>
  );
}

export function ProviderUsageCards({
  nowMs,
  usage,
  refreshingProviders,
  refreshProviderUsage,
  refreshProviderUsageDetails,
}: ProviderUsageCardsProps): JSX.Element {
  const cursorEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key),
  );
  const copilotEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key),
  );
  const providers = selectAccountProviderUsageSummaries(
    usage,
    cursorEnabled,
    copilotEnabled,
  );

  return (
    <>
      <ShutdownResumeButton nowMs={nowMs} />
      {providers.map((provider) => (
        <ProviderUsageCard
          key={provider.provider}
          provider={provider}
          nowMs={nowMs}
          snapshots={usage.accountSnapshots ?? []}
          refreshingProviders={refreshingProviders}
          refreshProviderUsage={refreshProviderUsage}
          refreshProviderUsageDetails={refreshProviderUsageDetails}
        />
      ))}
      <OpenCodeUsageSection
        usage={usage}
        refreshProviderUsage={refreshProviderUsage}
      />
    </>
  );
}

/** Host gate and existing usage transport around the shared account card. */
export function OpenCodeUsageSection({
  usage,
  refreshProviderUsage,
  frameless = false,
}: {
  usage: AgentUsageOverview;
  refreshProviderUsage: (provider: AgentProviderType) => Promise<void>;
  frameless?: boolean;
}): JSX.Element | null {
  const enabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key),
  );
  if (!enabled || !usage.openCodeAccounts) return null;
  return (
    <div className={usageCardContainerClass({ compact: true, frameless })}>
      <OpenCodeAccountCard
        snapshot={usage.openCodeAccounts}
        onRefresh={() => refreshProviderUsage('opencode')}
      />
    </div>
  );
}

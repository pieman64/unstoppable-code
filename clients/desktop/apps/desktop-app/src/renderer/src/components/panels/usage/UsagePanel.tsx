/**
 * UsagePanel — the `usage` panel kind's surface: the standalone Usage page's
 * provider usage / rate-limit content (+ AI Credits) re-flowed to FILL the
 * panel. There is no panel-level header and no per-provider card box; each
 * provider's content renders frameless, and sections are separated by a
 * divider (so the combined `all` variant shows a rule between Claude and
 * Codex). One component serves all five variants (`instance.variant`):
 *
 * - `all` — every account provider plus AI Credits, divider-separated.
 * - `active-chat` — follows the worktree's active (or most-recently-active)
 *   chat provider, switching between Claude, Codex, and Cursor live.
 * - `codex` / `claude` / `cursor` — pinned to one provider.
 *
 * A self-owned `ResizeObserver` (the panel engine passes no size to content)
 * drives only density/padding across four regimes — `full` uses roomier
 * padding and comfortable card density; the smaller regimes tighten both.
 * Everything scrolls, so no regime clips content.
 */
/* eslint-disable react-refresh/only-export-components -- exports the pure
   `resolveUsagePanelSizeMode` resolver alongside the component for direct
   unit testing (same posture as the panel registry module). */
import { memo, useEffect, useRef, useState, type JSX } from 'react';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useWorktreeChatRenderState } from '@/stores/chatStore';
import { resolveTabProviderType } from '@/stores/chat/tab-utils';
import { LoadingPlaceholder } from '@/components/shared/StatusBlocks';
import {
  ProviderUsageCard,
  OpenCodeUsageSection,
  ShutdownResumeButton,
  selectAccountProviderUsageSummaries,
  type AccountProviderUsageSummary,
  type ProviderUsageCardDensity,
  type UsageAccountProvider,
} from '@/components/pages/usage/ProviderUsageCards';
import { AiCreditsUsageCard } from '@/components/pages/usage/AiCreditsUsageCard';
import { type UsagePanelVariant } from '@/lib/panels/usage-variants';

interface ContainerSize {
  readonly width: number;
  readonly height: number;
}

/** Discrete container regimes the panel layout branches on. */
export type UsagePanelSizeMode =
  | 'full'
  | 'wide-short'
  | 'narrow-tall'
  | 'compact';

/** Min width that fits two comfortable cards side by side. */
const WIDE_MIN_PX = 560;
/** Min height above which the page-like (subtitle, comfortable) layout fits. */
const TALL_MIN_PX = 460;

/**
 * Maps a measured container box to a {@link UsagePanelSizeMode}. Exported for
 * direct unit testing of the thresholds. A 0×0 box (pre-measurement, or a
 * non-layout test env with no `ResizeObserver`) is treated as `full` so
 * content renders in its roomiest form rather than the most cramped one.
 */
export function resolveUsagePanelSizeMode(
  size: ContainerSize,
): UsagePanelSizeMode {
  if (size.width === 0 && size.height === 0) {
    return 'full';
  }
  const wide = size.width >= WIDE_MIN_PX;
  const tall = size.height >= TALL_MIN_PX;
  if (wide && tall) return 'full';
  if (wide && !tall) return 'wide-short';
  if (!wide && tall) return 'narrow-tall';
  return 'compact';
}

/**
 * Tracks a container's live client box via a self-owned `ResizeObserver`
 * (guarded for environments that lack it), matching the repo's component-local
 * observer pattern rather than threading size through the panel engine.
 */
function useContainerSize(
  ref: React.RefObject<HTMLElement | null>,
): ContainerSize {
  const [size, setSize] = useState<ContainerSize>({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = (): void => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width, height },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return (): void => observer.disconnect();
  }, [ref]);

  return size;
}

export interface UsagePanelProps {
  readonly variant: UsagePanelVariant;
  readonly projectId: string;
  readonly worktreeId: string;
}

function isUsageAccountProvider(
  provider: AgentProviderType | undefined,
): provider is UsageAccountProvider {
  return (
    provider === 'claude' ||
    provider === 'codex' ||
    provider === 'cursor' ||
    provider === 'copilot' ||
    provider === 'opencode'
  );
}

/** The single provider the `active-chat` variant follows, else `null`. */
function resolveActiveProvider(
  variant: UsagePanelVariant,
  activeChatProvider: AgentProviderType | undefined,
): UsageAccountProvider | null {
  return variant === 'active-chat' && isUsageAccountProvider(activeChatProvider)
    ? activeChatProvider
    : null;
}

/** Which provider(s) a variant shows: every account provider, one, or none. */
function resolveTargetProvider(
  variant: UsagePanelVariant,
  resolvedActiveProvider: UsageAccountProvider | null,
): UsageAccountProvider | 'all' | null {
  switch (variant) {
    case 'all':
      return 'all';
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'cursor':
      return 'cursor';
    case 'copilot':
      return 'copilot';
    case 'active-chat':
      return resolvedActiveProvider;
  }
}

function filterVariantCards(
  targetProvider: UsageAccountProvider | 'all' | null,
  accountProviders: AccountProviderUsageSummary[],
): AccountProviderUsageSummary[] {
  if (targetProvider === null) {
    return [];
  }
  if (targetProvider === 'all') {
    return accountProviders;
  }
  return accountProviders.filter(
    (provider) => provider.provider === targetProvider,
  );
}

export const UsagePanel = memo(function UsagePanel({
  variant,
  projectId,
  worktreeId,
}: UsagePanelProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sizeMode = resolveUsagePanelSizeMode(useContainerSize(rootRef));

  const initialize = useObservabilityStore((s) => s.initialize);
  const usage = useObservabilityStore((s) => s.usage);
  const refreshProviderUsage = useObservabilityStore(
    (s) => s.refreshProviderUsage,
  );
  const refreshProviderUsageDetails = useObservabilityStore(
    (s) => s.refreshProviderUsageDetails,
  );
  const refreshingProviders = useObservabilityStore(
    (s) => s.refreshingProviders,
  );

  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return (): void => clearInterval(interval);
  }, []);

  // The active (or most-recently-active) chat provider for this worktree.
  // File tabs can be active, so the chat store retains the prior chat
  // provider independently of this component's mount lifecycle.
  const activeChatProvider = useWorktreeChatRenderState(
    `${projectId}/${worktreeId}`,
    (worktreeChat): AgentProviderType | undefined => {
      if (!worktreeChat) {
        return undefined;
      }
      return (
        resolveTabProviderType(
          worktreeChat.tabs.find((tab) => tab.id === worktreeChat.activeTabId),
        ) ?? worktreeChat.lastActiveChatProvider
      );
    },
  );

  const cursorEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key),
  );
  const copilotEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key),
  );
  const opencodeEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key),
  );
  const activeProvider = resolveActiveProvider(variant, activeChatProvider);
  const showOpenCode =
    opencodeEnabled &&
    usage.openCodeAccounts !== undefined &&
    (variant === 'all' || activeProvider === 'opencode');
  const targetProvider = resolveTargetProvider(variant, activeProvider);
  const cards = filterVariantCards(
    targetProvider,
    selectAccountProviderUsageSummaries(usage, cursorEnabled, copilotEnabled),
  );

  const tall = sizeMode === 'full' || sizeMode === 'narrow-tall';
  const density: ProviderUsageCardDensity = tall ? 'comfortable' : 'compact';
  const padX = sizeMode === 'full' ? 'px-6' : 'px-3';
  const noActiveChat = variant === 'active-chat' && activeProvider === null;
  const showAiCredits = variant === 'all';

  return (
    <div
      ref={rootRef}
      data-testid="usage-panel"
      data-variant={variant}
      data-size-mode={sizeMode}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <ShutdownResumeButton nowMs={nowMs} />
      {cards.length === 0 && !showAiCredits && !showOpenCode ? (
        <div className={`min-h-0 flex-1 overflow-auto ${padX}`}>
          <LoadingPlaceholder
            label={
              noActiveChat
                ? 'This panel follows the active chat. Open or focus a chat with account usage to see it here.'
                : 'No provider usage is available yet.'
            }
          />
        </div>
      ) : (
        // Frameless sections fill the panel; a divider separates each provider
        // (and AI Credits) — `divide-y` skips a self-hidden AI Credits card
        // because it renders no DOM node.
        <div
          data-testid="usage-panel-cards"
          className={`flex min-h-0 flex-1 flex-col divide-y overflow-auto ${padX}`}
        >
          {cards.length === 0 && !showOpenCode ? (
            <LoadingPlaceholder label="No provider usage is available yet." />
          ) : (
            cards.map((provider) => (
              <ProviderUsageCard
                key={provider.provider}
                provider={provider}
                nowMs={nowMs}
                snapshots={usage.accountSnapshots ?? []}
                refreshingProviders={refreshingProviders}
                refreshProviderUsage={refreshProviderUsage}
                refreshProviderUsageDetails={refreshProviderUsageDetails}
                density={density}
                frameless
              />
            ))
          )}
          {showOpenCode && (
            <OpenCodeUsageSection
              usage={usage}
              refreshProviderUsage={refreshProviderUsage}
              frameless
            />
          )}
          {showAiCredits && <AiCreditsUsageCard frameless density={density} />}
        </div>
      )}
    </div>
  );
});

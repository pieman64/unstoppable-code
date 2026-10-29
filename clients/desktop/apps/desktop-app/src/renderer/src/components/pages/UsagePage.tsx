import { type JSX, useEffect, useState } from 'react';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { PageTitlebar } from '../shared/PageTitlebar';
import { PageContent } from '../shared/PageContent';
import { PageHeading } from '../shared/PageHeading';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { refreshAiCreditsUsage } from '@/hooks/useAiCreditsUsage';
import {
  ProviderUsageCards,
  selectAccountProviderUsageSummaries,
} from './usage/ProviderUsageCards';
import { AiCreditsUsageCard } from './usage/AiCreditsUsageCard';

/**
 * Refresh every usage card shown on the page, as if the user had clicked each
 * card's refresh button. The cards keep their current values while each
 * refresh runs; only their refresh buttons spin.
 */
async function refreshAllUsage(isActive: () => boolean): Promise<void> {
  refreshAiCreditsUsage();
  const { initialize } = useObservabilityStore.getState();
  await initialize();
  if (!isActive()) {
    return;
  }
  const { usage, refreshProviderUsage } = useObservabilityStore.getState();
  const cursorEnabled = useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key);
  const copilotEnabled = useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key);
  for (const provider of selectAccountProviderUsageSummaries(
    usage,
    cursorEnabled,
    copilotEnabled,
  )) {
    void refreshProviderUsage(provider.provider).catch(() => undefined);
  }
}

export function UsagePage(): JSX.Element {
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
    let active = true;
    void refreshAllUsage(() => active).catch(() => undefined);
    return (): void => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return (): void => clearInterval(interval);
  }, []);

  return (
    <section
      className="page-scroll-gutter h-full overflow-auto"
      data-testid="page-usage"
    >
      <PageTitlebar />
      <PageContent stack>
        <PageHeading
          title="Usage"
          subtitle="Subscription usage, remaining limits, and provider account details."
        />

        <div className="space-y-4">
          <ProviderUsageCards
            nowMs={nowMs}
            usage={usage}
            refreshingProviders={refreshingProviders}
            refreshProviderUsage={refreshProviderUsage}
            refreshProviderUsageDetails={refreshProviderUsageDetails}
          />
          <AiCreditsUsageCard />
        </div>
      </PageContent>
    </section>
  );
}

import { type JSX, useEffect, useState } from 'react';
import { PageTitlebar } from '../shared/PageTitlebar';
import { PageContent } from '../shared/PageContent';
import { PageHeader } from '@canopy/ui-shared/components/PageHeader';
import {
  CHAT_UNIT_LABEL_PLURAL,
  WORKTREE_UNIT_LABEL_PLURAL,
} from '@canopy/protocol';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { MetricsTab } from './usage/MetricsTab';
import { TodayStatisticsPanel } from './usage/TodayStatisticsPanel';
import {
  CHATS_TAB_SPEC,
  COST_TAB_SPEC,
  PIPELINES_TAB_SPEC,
  PLANS_TAB_SPEC,
  TOKENS_TAB_SPEC,
  TOOLS_TAB_SPEC,
  WORKTREES_TAB_SPEC,
} from './usage/tab-specs';

type StatisticsTab =
  | 'Tokens'
  | 'Cost'
  | 'Worktrees'
  | 'Chats'
  | 'Plans'
  | 'Pipelines'
  | 'Tools';

const STATISTICS_TABS: StatisticsTab[] = [
  'Tokens',
  'Cost',
  'Worktrees',
  'Chats',
  'Plans',
  'Pipelines',
  'Tools',
];

const TAB_LABELS: Record<StatisticsTab, string> = {
  Tokens: 'Tokens',
  Cost: 'Cost',
  Worktrees: WORKTREE_UNIT_LABEL_PLURAL,
  Chats: CHAT_UNIT_LABEL_PLURAL,
  Plans: 'Plans',
  Pipelines: 'Workflows',
  Tools: 'Tools',
};

function tabButtonClass(active: boolean): string {
  return active
    ? 'rounded-full bg-secondary px-3 py-1 text-s font-medium fg-primary'
    : 'rounded-full px-3 py-1 text-s fg-secondary hover:fg-primary';
}

export function StatisticsPage(): JSX.Element {
  const initialize = useObservabilityStore((s) => s.initialize);
  const retentionDays = useObservabilityStore((s) => s.retentionDays);

  const [preferencesRetentionDays, setPreferencesRetentionDays] =
    useState<number>(retentionDays);
  const [activeTab, setActiveTab] = useState<StatisticsTab>('Tokens');

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((prefs) => {
        if (cancelled) return;
        setPreferencesRetentionDays(prefs.auditRetentionDays);
      })
      .catch(() => {});
    return (): void => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (retentionDays > 0) setPreferencesRetentionDays(retentionDays);
  }, [retentionDays]);

  return (
    <section
      className="page-scroll-gutter h-full overflow-auto"
      data-testid="page-statistics"
    >
      <PageTitlebar />
      <PageContent stack>
        <PageHeader
          title="Statistics"
          description="Today's work at a glance, plus retained activity trends."
        />

        <TodayStatisticsPanel />

        <div
          className="flex flex-wrap gap-1 border-b pb-2"
          role="tablist"
          aria-label="Statistics tabs"
        >
          {STATISTICS_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              data-testid={`statistics-tab-${tab.toLowerCase()}`}
              className={tabButtonClass(activeTab === tab)}
              onClick={(): void => setActiveTab(tab)}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>

        {activeTab === 'Tokens' && (
          <MetricsTab
            spec={TOKENS_TAB_SPEC}
            retentionDays={preferencesRetentionDays}
          />
        )}
        {activeTab === 'Cost' && (
          <MetricsTab
            spec={COST_TAB_SPEC}
            retentionDays={preferencesRetentionDays}
          />
        )}
        {activeTab === 'Worktrees' && (
          <MetricsTab
            spec={WORKTREES_TAB_SPEC}
            retentionDays={preferencesRetentionDays}
          />
        )}
        {activeTab === 'Chats' && (
          <MetricsTab
            spec={CHATS_TAB_SPEC}
            retentionDays={preferencesRetentionDays}
          />
        )}
        {activeTab === 'Plans' && (
          <MetricsTab
            spec={PLANS_TAB_SPEC}
            retentionDays={preferencesRetentionDays}
          />
        )}
        {activeTab === 'Pipelines' && (
          <MetricsTab
            spec={PIPELINES_TAB_SPEC}
            retentionDays={preferencesRetentionDays}
          />
        )}
        {activeTab === 'Tools' && (
          <MetricsTab
            spec={TOOLS_TAB_SPEC}
            retentionDays={preferencesRetentionDays}
          />
        )}
      </PageContent>
    </section>
  );
}

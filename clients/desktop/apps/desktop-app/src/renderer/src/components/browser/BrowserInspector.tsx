import {
  DEFAULT_BROWSER_INSPECTOR_TAB,
  useBrowserStore,
  type BrowserInspectorTabId,
} from '@/stores/browserStore';
import { HeaderActionButton, TabBar } from '@canopy/ui-shared/components';
import { CloseMediumIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useEffect, useRef, type JSX } from 'react';
import { BrowserConsolePanel } from './BrowserConsolePanel';
import { BrowserFilesPanel } from './BrowserFilesPanel';
import { BrowserNetworkPanel } from './BrowserNetworkPanel';
import { BrowserRecordingPanel } from './BrowserRecordingPanel';
import { BrowserSnapshotsPanel } from './BrowserSnapshotsPanel';

interface BrowserInspectorProps {
  browserId: string;
}

const TABS: ReadonlyArray<{ id: BrowserInspectorTabId; label: string }> = [
  { id: 'console', label: 'Console' },
  { id: 'network', label: 'Network' },
  { id: 'recording', label: 'Recording' },
  { id: 'snapshots', label: 'Snapshots' },
  { id: 'files', label: 'Files' },
];

export function BrowserInspector({
  browserId,
}: BrowserInspectorProps): JSX.Element {
  const activeTab =
    useBrowserStore((s) => s.inspectorTab[browserId]) ??
    DEFAULT_BROWSER_INSPECTOR_TAB;
  const setInspectorTab = useBrowserStore((s) => s.setInspectorTab);
  const toggleInspector = useBrowserStore((s) => s.toggleInspector);

  const acknowledgeConsoleErrors = useBrowserStore(
    (s) => s.acknowledgeConsoleErrors,
  );
  const acknowledgeNetworkFailures = useBrowserStore(
    (s) => s.acknowledgeNetworkFailures,
  );
  const tabRowRef = useRef<HTMLDivElement | null>(null);

  // The tab row scrolls when the column is too narrow for every label; keep
  // the selected tab in view, including one opened from the browser bar.
  useEffect(() => {
    const tab = tabRowRef.current?.querySelector('[aria-selected="true"]');
    if (tab && typeof tab.scrollIntoView === 'function') {
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'console') {
      acknowledgeConsoleErrors(browserId);
    } else if (activeTab === 'network') {
      acknowledgeNetworkFailures(browserId);
    }
  }, [
    acknowledgeConsoleErrors,
    acknowledgeNetworkFailures,
    activeTab,
    browserId,
  ]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l bg-card/40">
      {
        // Early access: the tabs and, at the row's end, a way to close the
        // details.
        <div className="flex min-w-0 items-center pr-1">
          <div ref={tabRowRef} className="min-w-0 flex-1">
            <TabBar
              items={TABS.map((tab) => ({
                id: tab.id,
                label: tab.label,
                dataTestId: `browser-inspector-tab-${tab.id}`,
              }))}
              value={activeTab}
              onChange={(next): void => setInspectorTab(browserId, next)}
              label="Browser details"
              density="compact"
              scrollable
            />
          </div>
          <HeaderActionButton
            iconOnly
            tone="neutral"
            aria-label="Close browser details"
            data-testid="browser-inspector-close"
            onClick={(): void => toggleInspector(browserId)}
          >
            <CloseMediumIcon size={16} aria-hidden="true" />
          </HeaderActionButton>
        </div>
      }
      {activeTab === 'console' && <BrowserConsolePanel browserId={browserId} />}
      {activeTab === 'network' && <BrowserNetworkPanel browserId={browserId} />}
      {activeTab === 'recording' && (
        <BrowserRecordingPanel browserId={browserId} />
      )}
      {activeTab === 'snapshots' && (
        <BrowserSnapshotsPanel browserId={browserId} />
      )}
      {activeTab === 'files' && <BrowserFilesPanel browserId={browserId} />}
    </div>
  );
}

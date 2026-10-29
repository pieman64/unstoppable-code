import {
  DEFAULT_BROWSER_INSPECTOR_TAB,
  useBrowserStore,
  type BrowserInspectorTabId,
} from '@/stores/browserStore';
import { HeaderActionButton } from '@canopy/ui-shared/components';
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
  const selectedTabRef = useRef<HTMLButtonElement | null>(null);

  // The tab row scrolls when the column is too narrow for every label; keep
  // the selected tab in view, including one opened from the browser bar.
  useEffect(() => {
    const tab = selectedTabRef.current;
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

  const renderTabList = (className: string): JSX.Element => (
    <div role="tablist" aria-label="Browser details" className={className}>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          data-testid={`browser-inspector-tab-${tab.id}`}
          ref={activeTab === tab.id ? selectedTabRef : undefined}
          aria-selected={activeTab === tab.id}
          onClick={(): void => setInspectorTab(browserId, tab.id)}
          className={`canopy-tab-trigger shrink-0 whitespace-nowrap px-2.5 py-1 text-2xs font-medium transition-colors ${
            activeTab === tab.id
              ? 'fg-primary'
              : 'fg-secondary hover:fg-primary'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l bg-card/40">
      {
        // Early access: the tabs and, at the row's end, a way to close the
        // details.
        <div className="flex min-w-0 items-center">
          {renderTabList(
            'canopy-tab-list flex min-w-0 flex-1 items-center overflow-x-auto px-1',
          )}
          <HeaderActionButton
            iconOnly
            tone="neutral"
            aria-label="Close browser details"
            data-testid="browser-inspector-close"
            className="mr-1"
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

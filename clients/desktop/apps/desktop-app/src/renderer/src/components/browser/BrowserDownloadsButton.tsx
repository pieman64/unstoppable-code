import type { JSX } from 'react';
import { ProgressRing } from '@canopy/ui-shared';
import { Count, HeaderActionButton } from '@canopy/ui-shared/components';
import { DownloadIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  selectActiveTransferCount,
  useBrowserStore,
} from '@/stores/browserStore';
import { activeTransfersPercentage } from './browserTransferFormat';

interface BrowserDownloadsButtonProps {
  browserId: string;
}

/**
 * Opens the inspector's Files tab. While downloads are in flight it shows
 * their combined progress as a ring, with their count as a badge.
 */
export function BrowserDownloadsButton({
  browserId,
}: BrowserDownloadsButtonProps): JSX.Element {
  const activeCount = useBrowserStore((s) =>
    selectActiveTransferCount(s, browserId),
  );
  const percentage = useBrowserStore((s) =>
    activeTransfersPercentage(s.transfers[browserId] ?? []),
  );
  const filesOpen = useBrowserStore(
    (s) =>
      s.inspectorOpen[browserId] === true &&
      s.inspectorTab[browserId] === 'files',
  );
  const openFilesPanel = useBrowserStore((s) => s.openFilesPanel);
  const setInspectorOpen = useBrowserStore((s) => s.setInspectorOpen);
  const label = filesOpen
    ? 'Hide downloads'
    : activeCount > 0
      ? `Show downloads, ${activeCount} in progress`
      : 'Show downloads';

  return (
    <HeaderActionButton
      stateStyle="toolbar"
      iconOnly
      tone="neutral"
      aria-label={label}
      aria-pressed={filesOpen}
      data-testid="browser-files-button"
      onClick={(): void => {
        if (filesOpen) {
          setInspectorOpen(browserId, false);
        } else {
          openFilesPanel(browserId);
        }
      }}
    >
      {activeCount > 0 ? (
        <>
          <ProgressRing value={percentage} tone="neutral" />
          <Count
            value={activeCount}
            placement="icon"
            aria-hidden
            className="pointer-events-none absolute -right-0.5 -top-0.5"
          />
        </>
      ) : (
        <DownloadIcon size={16} aria-hidden="true" />
      )}
    </HeaderActionButton>
  );
}

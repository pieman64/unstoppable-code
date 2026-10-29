import { type JSX } from 'react';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { ChatIcon, TrashIcon } from '@canopy/ui-shared/icons';
import {
  useBrowserStore,
  type BrowserScreenshotEntry,
} from '@/stores/browserStore';
import { stageBrowserScreenshot } from '@/lib/browserChatStaging';
import { Tooltip } from '@canopy/ui-shared';

interface BrowserSnapshotsPanelProps {
  browserId: string;
}

const EMPTY: BrowserScreenshotEntry[] = [];

export function BrowserSnapshotsPanel({
  browserId,
}: BrowserSnapshotsPanelProps): JSX.Element {
  const snapshots = useBrowserStore((s) => s.screenshots[browserId] ?? EMPTY);
  const markAttached = useBrowserStore((s) => s.markScreenshotAttached);
  const removeScreenshot = useBrowserStore((s) => s.removeScreenshot);

  const handleAttach = async (entry: BrowserScreenshotEntry): Promise<void> => {
    if (!entry.attachmentPath) {
      return;
    }
    if (await stageBrowserScreenshot(entry.attachmentPath)) {
      markAttached(browserId, entry.id);
    }
  };

  if (snapshots.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-xs fg-secondary">
        No snapshots yet
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <ul className="flex flex-col gap-2">
        {[...snapshots].reverse().map((entry) => (
          <li
            key={entry.id}
            className="flex items-center gap-2 rounded border p-2"
          >
            {entry.dataUrl && (
              <img
                src={entry.dataUrl}
                alt={entry.filename}
                className="h-12 w-16 shrink-0 rounded object-cover"
              />
            )}
            <span
              className="min-w-0 flex-1 truncate font-mono text-2xs"
              title={entry.filename}
            >
              {entry.filename}
            </span>
            {entry.attachmentPath &&
              (entry.attached ? (
                <span className="shrink-0 text-2xs fg-secondary">Attached</span>
              ) : (
                <button
                  type="button"
                  onClick={(): void => {
                    void handleAttach(entry);
                  }}
                  className="inline-flex shrink-0 items-center gap-1 rounded border bg-base/50 px-2 py-1 text-2xs hover:bg-base"
                >
                  <ChatIcon width={12} height={12} />
                  <span>{CHAT_UNIT_LABEL}</span>
                </button>
              ))}
            <Tooltip label="Delete snapshot">
              <button
                type="button"
                onClick={(): void => removeScreenshot(browserId, entry.id)}
                aria-label="Delete snapshot"
                className="inline-flex shrink-0 items-center rounded p-1 fg-secondary hover:bg-muted/40 hover:fg-primary"
              >
                <TrashIcon width={13} height={13} />
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
    </div>
  );
}

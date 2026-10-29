import { useEffect, type JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared';
import { useBrowserStore } from '@/stores/browserStore';

interface BrowserDownloadNoticesProps {
  browserId: string;
}

/** Matches the app's default toast lifetime. */
const DOWNLOAD_TOAST_LIFETIME_MS = 15_000;

/**
 * Download notices for one browser pane: blocked automatic downloads, and
 * the completion toast. They sit under the browser bar, in the pane's flow,
 * because the native page view covers anything layered over the page.
 */
export function BrowserDownloadNotices({
  browserId,
}: BrowserDownloadNoticesProps): JSX.Element {
  const toast = useBrowserStore((s) => s.downloadToasts[browserId]);
  const blocked = useBrowserStore(
    (s) => s.blockedDownloads[browserId] !== undefined,
  );
  const dismissDownloadToast = useBrowserStore((s) => s.dismissDownloadToast);
  const dismissDownloadsBlocked = useBrowserStore(
    (s) => s.dismissDownloadsBlocked,
  );
  const allowMoreDownloads = useBrowserStore((s) => s.allowMoreDownloads);
  const runTransferCommand = useBrowserStore((s) => s.runTransferCommand);
  const toastId = toast?.id;

  useEffect(() => {
    if (toastId === undefined) {
      return undefined;
    }
    const timer = setTimeout(() => {
      dismissDownloadToast(browserId, toastId);
    }, DOWNLOAD_TOAST_LIFETIME_MS);
    return (): void => clearTimeout(timer);
  }, [browserId, dismissDownloadToast, toastId]);

  if (toast === undefined && !blocked) {
    return <></>;
  }

  return (
    <div className="flex flex-col gap-2 border-b px-2 py-2">
      {blocked && (
        <Notice
          intent="attention"
          title="Downloads blocked"
          actions={
            <NoticeButton
              data-testid="browser-files-allow-more"
              onClick={(): void => {
                void allowMoreDownloads(browserId).catch(() => undefined);
              }}
            >
              Allow more downloads
            </NoticeButton>
          }
          onDismiss={(): void => dismissDownloadsBlocked(browserId)}
          dismissLabel="Dismiss blocked downloads notice"
        >
          This page tried to start too many downloads at once.
        </Notice>
      )}
      {toast !== undefined && (
        <Notice
          data-testid="browser-download-toast"
          intent="positive"
          actions={
            <NoticeButton
              onClick={(): void => {
                void runTransferCommand({
                  kind: 'show',
                  browserId,
                  transferId: toast.id,
                }).catch(() => undefined);
              }}
            >
              Show
            </NoticeButton>
          }
          onDismiss={(): void => dismissDownloadToast(browserId, toast.id)}
          dismissLabel="Dismiss download notice"
        >
          <span className="block truncate" title={toast.fileName}>
            Downloaded {toast.fileName}
          </span>
        </Notice>
      )}
    </div>
  );
}

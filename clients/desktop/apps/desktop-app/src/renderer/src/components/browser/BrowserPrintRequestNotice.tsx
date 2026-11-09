import { type JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared';
import type { BrowserAnswerPrintRequestRequest } from '@canopy/desktop-shared/types';
import { useBrowserStore } from '@/stores/browserStore';
import { Surface } from '@canopy/ui-shared/components';

interface BrowserPrintRequestNoticeProps {
  browserId: string;
}

function originHost(origin: string): string | undefined {
  try {
    return new URL(origin).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A print the page asked for during an agent's action, waiting for the agent
 * or the user. Like the chooser notice, it sits under the browser bar in the
 * pane's flow, because the native page view covers anything layered over it.
 */
export function BrowserPrintRequestNotice({
  browserId,
}: BrowserPrintRequestNoticeProps): JSX.Element {
  const request = useBrowserStore((s) => s.printRequests[browserId]);
  if (!request) return <></>;
  const answer = (choice: BrowserAnswerPrintRequestRequest['answer']): void => {
    void window.api.browser
      .answerPrintRequest({
        browserId,
        printRequestId: request.id,
        answer: choice,
      })
      .catch(() => undefined);
  };
  return (
    <Surface variant="section" boundary="bottom">
      <div className="flex flex-col gap-2 px-2 py-2">
        <Notice
          data-testid="browser-pending-surface-print"
          intent="attention"
          actions={
            <>
              <NoticeButton
                data-testid="browser-print-request-dismiss"
                onClick={(): void => answer('dismiss')}
              >
                Dismiss
              </NoticeButton>
              <NoticeButton
                data-testid="browser-print-request-print"
                onClick={(): void => answer('print')}
              >
                Print…
              </NoticeButton>
              <NoticeButton
                data-testid="browser-print-request-save-pdf"
                variant="primary"
                onClick={(): void => answer('save_pdf')}
              >
                Save as PDF
              </NoticeButton>
            </>
          }
        >
          <span className="block truncate" title={request.frameOrigin}>
            {/* A sandboxed frame's opaque origin has no host; name the page's. */}
            {`${
              originHost(request.frameOrigin) ??
              originHost(request.topOrigin) ??
              request.topOrigin
            } wants to print this page`}
          </span>
        </Notice>
      </div>
    </Surface>
  );
}

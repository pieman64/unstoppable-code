import { type JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared';
import { useBrowserStore } from '@/stores/browserStore';

interface BrowserFileChooserNoticeProps {
  browserId: string;
}

function originHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/**
 * A file chooser the page opened during an agent's action, waiting for the
 * agent or the user. It sits under the browser bar, in the pane's flow,
 * because the native page view covers anything layered over the page.
 */
export function BrowserFileChooserNotice({
  browserId,
}: BrowserFileChooserNoticeProps): JSX.Element {
  const chooser = useBrowserStore((s) => s.fileChoosers[browserId]);
  if (!chooser) return <></>;
  const answer = (choice: 'choose' | 'dismiss'): void => {
    void window.api.browser
      .answerFileChooser({ browserId, chooserId: chooser.id, answer: choice })
      .catch(() => undefined);
  };
  const host = originHost(chooser.frameOrigin);
  return (
    <div className="flex flex-col gap-2 border-b px-2 py-2">
      <Notice
        data-testid="browser-pending-surface-file-chooser"
        intent="attention"
        actions={
          <>
            <NoticeButton
              data-testid="browser-file-chooser-dismiss"
              onClick={(): void => answer('dismiss')}
            >
              Dismiss
            </NoticeButton>
            <NoticeButton
              data-testid="browser-file-chooser-choose"
              variant="primary"
              onClick={(): void => answer('choose')}
            >
              {chooser.multiple ? 'Choose files…' : 'Choose file…'}
            </NoticeButton>
          </>
        }
      >
        <span className="block truncate" title={chooser.frameOrigin}>
          {chooser.multiple
            ? `${host} is asking for files`
            : `${host} is asking for a file`}
        </span>
      </Notice>
    </div>
  );
}

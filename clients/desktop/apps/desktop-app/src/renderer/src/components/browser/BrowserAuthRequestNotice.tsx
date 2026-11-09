import { type JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared';
import { useBrowserStore } from '@/stores/browserStore';
import { Surface } from '@canopy/ui-shared/components';

interface BrowserAuthRequestNoticeProps {
  browserId: string;
  /** Opens the credentials dialog for the pending sign-in. */
  onSignIn: () => void;
}

function authRequestHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/**
 * An HTTP sign-in the page waits on. Only the user answers it: **Sign in…**
 * opens the app's credentials dialog, and **Cancel** gives up, so the page
 * shows its sign-in error. It sits under the browser bar like the chooser and
 * print notices.
 */
export function BrowserAuthRequestNotice({
  browserId,
  onSignIn,
}: BrowserAuthRequestNoticeProps): JSX.Element {
  const request = useBrowserStore((s) => s.authRequests[browserId]);
  if (!request) return <></>;
  const cancel = (): void => {
    void window.api.browser
      .answerAuthRequest({
        browserId,
        authRequestId: request.id,
        answer: 'cancel',
      })
      .catch(() => undefined);
  };
  return (
    <Surface variant="section" boundary="bottom">
      <div className="flex flex-col gap-2 px-2 py-2">
        <Notice
          data-testid="browser-pending-surface-auth"
          intent="attention"
          actions={
            <>
              <NoticeButton
                data-testid="browser-auth-request-cancel"
                onClick={cancel}
              >
                Cancel
              </NoticeButton>
              <NoticeButton
                data-testid="browser-auth-request-sign-in"
                variant="primary"
                onClick={onSignIn}
              >
                Sign in…
              </NoticeButton>
            </>
          }
        >
          <span className="block truncate" title={request.origin}>
            {`${authRequestHost(request.origin)} needs you to sign in`}
          </span>
        </Notice>
      </div>
    </Surface>
  );
}

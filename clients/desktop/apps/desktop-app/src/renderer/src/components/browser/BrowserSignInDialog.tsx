import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from 'react';
import { TextInput } from '@canopy/ui-shared';
import type { BrowserAuthRequest } from '@canopy/execution-engine/types/browser';
import { Button } from '@/components/shared/Button';
import { DialogModal } from '@canopy/ui-shared/components';

function authRequestHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

interface BrowserSignInDialogProps {
  browserId: string;
  request: BrowserAuthRequest;
  /** Closes the dialog; the sign-in stays pending on the notice. */
  onClose: () => void;
}

/**
 * The app-owned credentials dialog for an HTTP sign-in. The user's username
 * and password go straight to the page's request and are never kept or shown
 * to agents. Like the JavaScript dialog, it carries the native-overlay marker
 * so the page's native view cannot paint over it.
 */
export function BrowserSignInDialog({
  browserId,
  request,
  onClose,
}: BrowserSignInDialogProps): JSX.Element {
  const titleId = useId();
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const host = authRequestHost(request.origin);

  useEffect(() => {
    const frameId = requestAnimationFrame(() => usernameRef.current?.focus());
    return (): void => cancelAnimationFrame(frameId);
  }, []);

  const answer = (choice: 'sign_in' | 'cancel'): void => {
    if (submitting) return;
    setSubmitting(true);
    const credentials = choice === 'sign_in' ? { username, password } : {};
    setPassword('');
    void window.api.browser
      .answerAuthRequest({
        browserId,
        authRequestId: request.id,
        answer: choice,
        ...credentials,
      })
      .catch(() => undefined)
      .finally(onClose);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    answer('sign_in');
  };

  const formId = `${titleId}-form`;
  // The shared dialog over the browser pane only: Tab stays inside while
  // focus is in the pane, Escape closes it, the scrim does not.
  return (
    <DialogModal
      containment="parent"
      title={
        <span title={request.origin}>
          {request.isProxy
            ? `Sign in to the proxy ${host}`
            : `Sign in to ${host}`}
        </span>
      }
      titleId={titleId}
      subtitle={
        request.realm ? (
          <span className="block truncate" title={request.realm}>
            {`“${request.realm}”`}
          </span>
        ) : undefined
      }
      onClose={onClose}
      closeOnBackdrop={false}
      closeOnEscape
      showCloseButton={false}
      maxWidth="md"
      trapFocus
      initialFocusRef={usernameRef}
      dataTestId="browser-sign-in-dialog"
      overlayDataTestId="browser-sign-in-dialog-backdrop"
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            disabled={submitting}
            data-testid="browser-sign-in-cancel"
            onClick={(): void => answer('cancel')}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={submitting}
            data-testid="browser-sign-in-submit"
          >
            Sign in
          </Button>
        </>
      }
    >
      <form
        ref={formRef}
        id={formId}
        className="flex flex-col gap-3"
        onSubmit={handleSubmit}
      >
        <TextInput
          ref={usernameRef}
          aria-label="Username"
          placeholder="Username"
          autoComplete="username"
          value={username}
          disabled={submitting}
          data-testid="browser-sign-in-username"
          onChange={(event): void => setUsername(event.target.value)}
        />
        <TextInput
          type="password"
          aria-label="Password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          disabled={submitting}
          data-testid="browser-sign-in-password"
          onChange={(event): void => setPassword(event.target.value)}
        />
      </form>
    </DialogModal>
  );
}

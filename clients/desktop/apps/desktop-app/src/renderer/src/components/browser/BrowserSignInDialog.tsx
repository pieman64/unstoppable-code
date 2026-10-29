import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from 'react';
import { TextInput } from '@canopy/ui-shared';
import { focusableWithin } from '@canopy/ui-shared/lib';
import type { BrowserAuthRequest } from '@canopy/desktop-shared/types/browser';
import { Button } from '@/components/shared/Button';

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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Tab') {
        keepFocusInside(event);
        return;
      }
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    // Tab wraps inside the dialog, and pulls focus in from the pane behind
    // it; focus elsewhere in the app is left alone, as the dialog covers only
    // this pane.
    const keepFocusInside = (event: KeyboardEvent): void => {
      const form = formRef.current;
      const pane = form?.parentElement?.parentElement;
      const active = document.activeElement;
      if (!form || !pane || !(active instanceof Node) || !pane.contains(active))
        return;
      const focusables = focusableWithin(form);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      const inside = form.contains(active);
      if (inside && active !== (event.shiftKey ? first : last)) return;
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return (): void => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onClose]);

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

  return (
    <div
      className="electron-no-drag absolute inset-0 z-modal flex items-center justify-center bg-overlay-scrim p-4"
      data-canopy-browser-native-overlay="true"
      data-testid="browser-sign-in-dialog-backdrop"
    >
      <form
        ref={formRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex w-full max-w-md flex-col overflow-hidden rounded-xl bg-card shadow-xl"
        data-testid="browser-sign-in-dialog"
        onSubmit={handleSubmit}
      >
        <div className="border-b px-5 py-4">
          <h2
            id={titleId}
            className="truncate text-s font-semibold fg-primary"
            title={request.origin}
          >
            {request.isProxy
              ? `Sign in to the proxy ${host}`
              : `Sign in to ${host}`}
          </h2>
          {request.realm && (
            <p
              className="mt-1 truncate text-xs fg-tertiary"
              title={request.realm}
            >
              {`“${request.realm}”`}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
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
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-3">
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
            variant="primary"
            disabled={submitting}
            data-testid="browser-sign-in-submit"
          >
            Sign in
          </Button>
        </div>
      </form>
    </div>
  );
}

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from 'react';
import type { BrowserJavaScriptDialog } from '@canopy/desktop-shared/types/browser';
import { Button } from '@/components/shared/Button';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ErrorBanner, TextInput, Heading } from '@canopy/ui-shared/components';

interface BrowserJavaScriptDialogModalProps {
  browserId: string;
  dialog: BrowserJavaScriptDialog;
}

function dialogOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? parsed.href : parsed.origin;
  } catch {
    return url;
  }
}

function primaryLabel(dialog: BrowserJavaScriptDialog): string {
  if (dialog.type === 'beforeunload') {
    return 'Leave';
  }
  return 'OK';
}

/**
 * App-owned JavaScript-dialog UI for the embedded browser.
 *
 * The main process deliberately leaves Chromium's synchronous dialog callback
 * unresolved while this asynchronous React surface is open. The overlay
 * marker also activates BrowserPane's screenshot-then-hide path so Electron's
 * native WebContentsView cannot paint over the modal.
 */
export function BrowserJavaScriptDialogModal({
  browserId,
  dialog,
}: BrowserJavaScriptDialogModalProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null);
  const [promptText, setPromptText] = useState(dialog.defaultPrompt ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPromptText(dialog.defaultPrompt ?? '');
    setSubmitting(false);
    setError(null);
    const frameId = requestAnimationFrame(() => {
      if (dialog.type === 'prompt') {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        primaryButtonRef.current?.focus();
      }
    });
    return (): void => cancelAnimationFrame(frameId);
  }, [dialog]);

  const respond = useCallback(
    async (accept: boolean): Promise<void> => {
      if (submitting) {
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        await window.api.browser.handleDialog({
          browserId,
          dialogId: dialog.id,
          accept,
          ...(dialog.type === 'prompt' && accept ? { promptText } : {}),
        });
      } catch (responseError) {
        setError(
          responseError instanceof Error
            ? responseError.message
            : 'Unable to respond to the page dialog.',
        );
        setSubmitting(false);
      }
    },
    [browserId, dialog.id, dialog.type, promptText, submitting],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || submitting) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void respond(dialog.type === 'alert');
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return (): void => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [dialog.type, respond, submitting]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void respond(true);
  };

  const cancelLabel = dialog.type === 'beforeunload' ? 'Stay' : 'Cancel';
  const showCancel = dialog.type !== 'alert';
  const message =
    dialog.message ||
    (dialog.type === 'beforeunload'
      ? 'Changes you made may not be saved.'
      : '');

  return (
    <div
      className="electron-no-drag absolute inset-0 z-modal flex items-center justify-center bg-overlay-scrim p-4"
      data-canopy-browser-native-overlay="true"
      data-testid="browser-javascript-dialog-backdrop"
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={`browser-dialog-title-${dialog.id}`}
        aria-describedby={`browser-dialog-message-${dialog.id}`}
        className="flex w-full max-w-md flex-col overflow-hidden rounded-xl bg-card shadow-xl"
        data-testid="browser-javascript-dialog"
        onSubmit={handleSubmit}
      >
        <div className="border-b px-5 py-4">
          <Heading
            level={2}
            variant="title"
            truncate
            id={`browser-dialog-title-${dialog.id}`}
            title={dialog.url}
          >
            {dialogOrigin(dialog.url)}
          </Heading>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          {/* The page writes this message, so it is blocked like the page. */}
          <p
            id={`browser-dialog-message-${dialog.id}`}
            className={`${POSTHOG_REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words text-s fg-primary`}
          >
            {message}
          </p>
          {dialog.type === 'prompt' && (
            <TextInput
              ref={inputRef}
              type="text"
              value={promptText}
              disabled={submitting}
              aria-label="Response"
              onChange={(event): void => setPromptText(event.target.value)}
            />
          )}
          <ErrorBanner error={error} className="" />
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-3">
          {showCancel && (
            <Button
              type="button"
              variant="secondary"
              disabled={submitting}
              onClick={(): void => void respond(false)}
            >
              {cancelLabel}
            </Button>
          )}
          <Button
            ref={primaryButtonRef}
            type="submit"
            variant="primary"
            disabled={submitting}
          >
            {primaryLabel(dialog)}
          </Button>
        </div>
      </form>
    </div>
  );
}

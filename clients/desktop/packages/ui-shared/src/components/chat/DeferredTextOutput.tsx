import { memo, type JSX } from 'react';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { Button } from '../Button';
import { LoadingSpinner } from '../LoadingSpinner';
import { useCleanChatLook } from '../chat-look';

interface DeferredTextOutputProps {
  preview: string;
  text?: string;
  loading: boolean;
  error?: string;
  opened: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  onOpen: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onRetry: () => void;
  onClose: () => void;
  /** Field-specific copy; tool output keeps the defaults. */
  openLabel?: string;
  loadingLabel?: string;
  /**
   * `error` draws the text in the error tint, like an inline error result.
   * The clean look keeps it colorless.
   */
  tone?: 'default' | 'error';
}

/** Host-owned reads keep this shared viewer independent of disk/network APIs. */
export const DeferredTextOutput = memo(function DeferredTextOutput({
  preview,
  text,
  loading,
  error,
  opened,
  hasPrevious,
  hasNext,
  onOpen,
  onPrevious,
  onNext,
  onRetry,
  onClose,
  openLabel = 'View full output',
  loadingLabel = 'Loading output…',
  tone = 'default',
}: DeferredTextOutputProps): JSX.Element {
  const clean = useCleanChatLook();
  const errorTint = tone === 'error' && !clean;
  return (
    <div className="text-xs fg-secondary" data-testid="chat-deferred-output">
      {/* A host that already shows the bounded output passes an empty
          preview; only the controls render until the full output opens. */}
      {(opened || preview) && (
        <pre
          className={`max-h-75 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 ${
            errorTint ? 'fg-destructive/80 ' : ''
          }${REPLAY_BLOCK_CLASS}`}
          data-testid="chat-tool-output-text"
        >
          {opened ? text : preview}
        </pre>
      )}
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 ring-1 ring-inset ring-line-base"
        data-testid="chat-deferred-output-controls"
      >
        {!opened ? (
          <Button
            variant="ghost"
            size="compact"
            data-testid="chat-tool-output-open"
            onClick={onOpen}
          >
            {openLabel}
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="compact"
              data-testid="chat-tool-output-previous"
              disabled={loading || !hasPrevious}
              onClick={onPrevious}
            >
              Previous
            </Button>
            <Button
              variant="ghost"
              size="compact"
              data-testid="chat-tool-output-next"
              disabled={loading || !hasNext}
              onClick={onNext}
            >
              Next
            </Button>
            <Button
              variant="ghost"
              size="compact"
              data-testid="chat-tool-output-close"
              onClick={onClose}
            >
              Show preview
            </Button>
          </>
        )}
        {loading && (
          <span className="inline-flex items-center gap-2" role="status">
            <LoadingSpinner
              decorative
              dataTestId="chat-output-loading-spinner"
            />
            {loadingLabel}
          </span>
        )}
        {error && (
          <>
            <span role="alert">{error}</span>
            <Button
              variant="ghost"
              size="compact"
              data-testid="chat-tool-output-retry"
              onClick={onRetry}
            >
              Retry
            </Button>
          </>
        )}
      </div>
    </div>
  );
});

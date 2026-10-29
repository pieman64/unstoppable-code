import { memo, type JSX } from 'react';
import { LoadingSpinner } from '../LoadingSpinner';

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
}: DeferredTextOutputProps): JSX.Element {
  return (
    <div className="text-xs fg-secondary" data-testid="chat-deferred-output">
      {/* A host that already shows the bounded output passes an empty
          preview; only the controls render until the full output opens. */}
      {(opened || preview) && (
        <pre
          className="max-h-75 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2"
          data-testid="chat-tool-output-text"
        >
          {opened ? text : preview}
        </pre>
      )}
      <div
        className="flex items-center gap-3 px-2.5 py-2 ring-1 ring-inset ring-line-base"
        data-testid="chat-deferred-output-controls"
      >
        {!opened ? (
          <button
            type="button"
            data-testid="chat-tool-output-open"
            onClick={onOpen}
          >
            View full output
          </button>
        ) : (
          <>
            <button
              type="button"
              data-testid="chat-tool-output-previous"
              disabled={loading || !hasPrevious}
              onClick={onPrevious}
            >
              Previous
            </button>
            <button
              type="button"
              data-testid="chat-tool-output-next"
              disabled={loading || !hasNext}
              onClick={onNext}
            >
              Next
            </button>
            <button
              type="button"
              data-testid="chat-tool-output-close"
              onClick={onClose}
            >
              Show preview
            </button>
          </>
        )}
        {loading && (
          <span className="inline-flex items-center gap-2" role="status">
            <LoadingSpinner
              decorative
              dataTestId="chat-output-loading-spinner"
            />
            Loading output…
          </span>
        )}
        {error && (
          <>
            <span role="alert">{error}</span>
            <button
              type="button"
              data-testid="chat-tool-output-retry"
              onClick={onRetry}
            >
              Retry
            </button>
          </>
        )}
      </div>
    </div>
  );
});

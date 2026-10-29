import type { JSX } from 'react';

export interface PendingAttachmentChip {
  localId: string;
  filename: string;
  state: 'staged' | 'uploading' | 'ready' | 'error';
  error?: string;
}

export function PendingAttachmentRow({
  attachments,
  onRemove,
  onRetry,
}: {
  attachments: readonly PendingAttachmentChip[];
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}): JSX.Element | null {
  if (attachments.length === 0) return null;
  return (
    <div
      className="flex gap-2 overflow-x-auto px-3 pb-2"
      data-testid="portal-pending-attachments"
    >
      {attachments.map((attachment) => (
        <div
          key={attachment.localId}
          className="flex max-w-64 shrink-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs"
          data-state={attachment.state}
          title={attachment.error ?? attachment.filename}
        >
          {attachment.state === 'uploading' ? (
            <span
              className="h-3 w-3 animate-spin rounded-full border-2 border-fg-secondary border-t-transparent"
              aria-label="Uploading"
            />
          ) : null}
          <span className="truncate">{attachment.filename}</span>
          {attachment.state === 'error' ? (
            <button
              type="button"
              className="focus-ring fg-destructive hover:underline"
              onClick={(): void => onRetry(attachment.localId)}
              aria-label={`Retry ${attachment.filename}`}
            >
              Retry
            </button>
          ) : null}
          <button
            type="button"
            className="focus-ring fg-secondary hover:fg-primary"
            onClick={(): void => onRemove(attachment.localId)}
            aria-label={`Remove ${attachment.filename}`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

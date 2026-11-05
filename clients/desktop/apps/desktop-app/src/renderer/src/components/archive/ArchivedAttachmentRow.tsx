import type { JSX, MouseEvent } from 'react';
import { Button } from '@canopy/ui-shared/components';
import { FileTypeIcon } from '@/components/shared/file-icons';
import { formatDateOrEmpty } from '@/lib/format';

interface ArchivedAttachmentRowProps {
  readonly filename: string;
  readonly createdAt: string;
  readonly onReveal: () => void;
  readonly onMouseEnter?: (event: MouseEvent<HTMLDivElement>) => void;
  readonly onMouseLeave?: () => void;
}

/** One retained attachment: its file icon, name, date, and Reveal. */
export function ArchivedAttachmentRow({
  filename,
  createdAt,
  onReveal,
  onMouseEnter,
  onMouseLeave,
}: ArchivedAttachmentRowProps): JSX.Element {
  return (
    <div
      data-testid={`archived-attachment-row-${filename}`}
      className="group flex items-center gap-2 rounded-md border bg-fg-primary/[0.02] px-3 py-2 transition-colors hover:border-fg-primary/10"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <FileTypeIcon
        filename={filename}
        size={16}
        boxSize={14}
        className="shrink-0"
      />
      <span className="min-w-0 flex-1 truncate text-xs font-medium fg-primary">
        {filename}
      </span>
      <span className="shrink-0 text-2xs fg-secondary">
        {formatDateOrEmpty(createdAt)}
      </span>
      {/* Hover-revealed, and shown while focused inside. */}
      <span className="shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <Button
          size="compact"
          data-testid={`archived-attachment-reveal-${filename}`}
          onClick={onReveal}
        >
          Reveal
        </Button>
      </span>
    </div>
  );
}

import type { JSX, MouseEventHandler, ReactNode } from 'react';
import { Surface } from './Surface';
import { Inline } from './Stack';

export interface AttachmentItemRowContentProps {
  readonly filename: string;
  readonly icon: ReactNode;
  readonly metadata?: ReactNode;
  readonly actions?: ReactNode;
  readonly contentTestId?: string;
}

/** Pure attachment row content; each host supplies its transport actions. */
function AttachmentItemRowContent({
  filename,
  icon,
  metadata,
  actions,
  contentTestId,
}: AttachmentItemRowContentProps): JSX.Element {
  return (
    <div className="contents pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:flex-wrap pointer-coarse:items-center pointer-coarse:justify-end pointer-coarse:gap-2 pointer-coarse:px-2 pointer-coarse:py-2">
      <div
        className="px-2 py-1.5 pointer-coarse:w-full pointer-coarse:px-0 pointer-coarse:py-0"
        data-testid={contentTestId}
      >
        <Inline gap="inline" align="center">
          {icon}
          <div className="flex min-w-0 flex-1 items-center">
            <span className="truncate text-xs font-medium fg-primary">
              {filename}
            </span>
          </div>
          {metadata !== undefined ? (
            <span className="shrink-0 text-2xs fg-secondary transition-opacity pointer-fine:group-hover:opacity-0 pointer-fine:group-focus-within:opacity-0">
              {metadata}
            </span>
          ) : null}
        </Inline>
      </div>
      {actions}
    </div>
  );
}

export interface AttachmentItemRowProps extends AttachmentItemRowContentProps {
  readonly as?: 'div' | 'li';
  readonly testId: string;
  readonly attachmentId?: string;
  readonly state?: 'ready';
  readonly onMouseEnter?: MouseEventHandler<HTMLElement>;
  readonly onMouseLeave?: MouseEventHandler<HTMLElement>;
}

/** One populated attachment frame on both hosts; actions remain host-owned. */
export function AttachmentItemRow({
  as = 'div',
  testId,
  attachmentId,
  state,
  onMouseEnter,
  onMouseLeave,
  ...content
}: AttachmentItemRowProps): JSX.Element {
  return (
    <Surface
      as={as}
      variant="group"
      size="small"
      className="group relative"
      data-testid={testId}
      data-attachment-id={attachmentId}
      data-state={state}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <AttachmentItemRowContent {...content} />
    </Surface>
  );
}

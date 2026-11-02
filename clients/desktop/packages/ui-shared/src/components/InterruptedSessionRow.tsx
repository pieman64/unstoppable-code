import type { JSX, ReactNode } from 'react';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

const LAYOUT_CLASS = {
  /** A selectable row in the resume dialog. */
  selection: 'gap-2 py-1',
  /** A queued entry with a trailing status. */
  queue: 'justify-between gap-4 py-3',
} as const;

const INDENT_CLASS = {
  none: '',
  /** Under a workspace header. */
  group: 'ml-6',
  /** Under a worktree header. */
  worktree: 'ml-12',
} as const;

export interface InterruptedSessionRowProps {
  /** User-authored chat or pipeline title. */
  title: string;
  /**
   * Renders the title as a `<label>` for this control id, so the title names
   * the leading checkbox without wrapping the row or its trailing controls.
   */
  titleFor?: string;
  /** Lets a trailing control reference the title through `aria-describedby`. */
  titleId?: string;
  /** Mask the user-authored title in session replays. */
  replayMaskTitle?: boolean;
  /** Line between the title and metadata, such as the workspace name. */
  context?: ReactNode;
  /** Mask the context line in session replays. */
  replayMaskContext?: boolean;
  /** Provider, interruption reason, and readiness. */
  metadata?: ReactNode;
  /** Lets a control reference the metadata through `aria-describedby`. */
  metadataId?: string;
  metadataTestId?: string;
  /** Session kind and detail, such as paused pipeline steps. */
  secondaryMetadata?: ReactNode;
  /** Mask secondary text that contains user-authored model labels. */
  replayMaskSecondaryMetadata?: boolean;
  /** Status or error content rendered after the metadata. */
  children?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Mutes the text of a row whose control is disabled. */
  disabled?: boolean;
  layout?: keyof typeof LAYOUT_CLASS;
  indent?: keyof typeof INDENT_CLASS;
  as?: 'div' | 'li';
  'data-testid'?: string;
}

/**
 * One interrupted session in a resume list: the selection dialog and the
 * resume queue. Pure display; hosts supply the controls and their state.
 */
export function InterruptedSessionRow({
  title,
  titleFor,
  titleId,
  replayMaskTitle = false,
  context,
  replayMaskContext = false,
  metadata,
  metadataId,
  metadataTestId,
  secondaryMetadata,
  replayMaskSecondaryMetadata = false,
  children,
  leading,
  trailing,
  disabled = false,
  layout = 'selection',
  indent = 'none',
  as: Element = 'div',
  'data-testid': testId,
}: InterruptedSessionRowProps): JSX.Element {
  const titleClass = `block truncate text-s ${disabled ? 'fg-secondary' : 'fg-primary'} ${replayMaskTitle ? REPLAY_MASK_CLASS : ''}`;
  // A native tooltip would expose a masked title outside its text node.
  const titleTooltip = replayMaskTitle ? undefined : title;
  return (
    <Element
      data-testid={testId}
      className={`flex items-start ${LAYOUT_CLASS[layout]} ${INDENT_CLASS[indent]}`}
    >
      {leading}
      <div className="min-w-0 flex-1">
        {titleFor ? (
          <label
            id={titleId}
            htmlFor={titleFor}
            title={titleTooltip}
            className={titleClass}
          >
            {title}
          </label>
        ) : (
          <p id={titleId} title={titleTooltip} className={titleClass}>
            {title}
          </p>
        )}
        {context ? (
          <p
            className={`truncate text-xs fg-secondary ${replayMaskContext ? REPLAY_MASK_CLASS : ''}`}
          >
            {context}
          </p>
        ) : null}
        {metadata ? (
          <p
            id={metadataId}
            data-testid={metadataTestId}
            className="text-xs fg-secondary"
          >
            {metadata}
          </p>
        ) : null}
        {secondaryMetadata ? (
          <p
            className={`break-words text-xs fg-secondary ${replayMaskSecondaryMetadata ? REPLAY_MASK_CLASS : ''}`}
          >
            {secondaryMetadata}
          </p>
        ) : null}
        {children}
      </div>
      {trailing}
    </Element>
  );
}

'use client';

import { useRef, type JSX, type ReactNode } from 'react';
import { PencilIcon } from '../../icons/AppIcons';
import {
  COMPOSER_PROMPT_ROW_GLYPH_CLASS,
  COMPOSER_PROMPT_TEXT_ROW_CLASS,
  COMPOSER_PROMPT_TEXT_ROW_WITH_GLYPH_CLASS,
} from './ComposerPrompt';

export interface ComposerPromptTextRowProps {
  /** Keep the editor mounted when its prompt is collapsed. */
  readonly plain?: boolean;
  /**
   * Leads the row with a pen in the answers' numbers column, when typing is
   * one more answer.
   */
  readonly withPen: boolean;
  /** The composer's editor, microphone, and send. */
  readonly children: ReactNode;
}

/**
 * A composer prompt's text row: the composer's own input, optionally led by
 * a pen that reads as one more answer. Clicking the pen puts the cursor in
 * the input.
 */
export function ComposerPromptTextRow({
  withPen,
  plain = false,
  children,
}: ComposerPromptTextRowProps): JSX.Element {
  const rowRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={rowRef}
      className={
        plain
          ? undefined
          : withPen
            ? COMPOSER_PROMPT_TEXT_ROW_WITH_GLYPH_CLASS
            : COMPOSER_PROMPT_TEXT_ROW_CLASS
      }
    >
      {withPen && (
        <span
          aria-hidden
          data-testid="composer-prompt-pen"
          className={COMPOSER_PROMPT_ROW_GLYPH_CLASS}
          onMouseDown={(event): void => {
            const input = rowRef.current?.querySelector(
              '[contenteditable="true"]',
            );
            if (!(input instanceof HTMLElement)) return;
            event.preventDefault();
            input.focus();
          }}
        >
          <PencilIcon size={16} />
        </span>
      )}
      {children}
    </div>
  );
}

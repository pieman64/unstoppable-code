'use client';

import {
  useId,
  useRef,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { CloseLargeIcon } from '../../icons/AppIcons';
import { ComposerIconButton } from './ComposerIconButton';
import {
  COMPOSER_PROMPT_BOX_CLASS,
  COMPOSER_PROMPT_EDITOR_CONTAINER_CLASS,
  COMPOSER_PROMPT_HEADER_CLASS,
  COMPOSER_PROMPT_ROW_CLASS,
  COMPOSER_PROMPT_ROW_GLYPH_CLASS,
  COMPOSER_PROMPT_ROWS_CLASS,
  COMPOSER_PROMPT_TEXT_ROW_WITH_GLYPH_CLASS,
} from './ComposerPrompt';
import { ComposerPromptTextRow } from './ComposerPromptTextRow';

/** One answer row of the plan prompt. */
export interface PlanApprovalOption {
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly testId: string;
}

const ROW_GLYPH_CLASS = COMPOSER_PROMPT_ROW_GLYPH_CLASS;
const ROW_CLASS = COMPOSER_PROMPT_ROW_CLASS;

/** The composer box while the prompt shows; see {@link COMPOSER_PROMPT_BOX_CLASS}. */
export const PLAN_APPROVAL_BOX_CLASS = COMPOSER_PROMPT_BOX_CLASS;

/** The text row, led by its pen; see {@link COMPOSER_PROMPT_TEXT_ROW_WITH_GLYPH_CLASS}. */
export const PLAN_APPROVAL_TEXT_ROW_CLASS =
  COMPOSER_PROMPT_TEXT_ROW_WITH_GLYPH_CLASS;

/** The text row's editor container; see {@link COMPOSER_PROMPT_EDITOR_CONTAINER_CLASS}. */
export const PLAN_APPROVAL_EDITOR_CONTAINER_CLASS =
  COMPOSER_PROMPT_EDITOR_CONTAINER_CLASS;

/**
 * The composer while the agent waits for its plan to be approved: it asks
 * `Implement this plan?` and offers numbered answers above the text row,
 * where typing tells the agent what to change instead. The host renders the
 * text row (its editor, microphone and send) as `children`, inside
 * {@link PLAN_APPROVAL_TEXT_ROW_CLASS}.
 *
 * An answer acts as soon as it is clicked. With focus on an answer, 1-9 pick
 * one, the arrow keys move between them, and Escape (anywhere in the prompt)
 * closes it; the plan keeps waiting.
 */
export function PlanApprovalPrompt({
  options,
  expanded = true,
  onOpenPlan,
  onClose,
  children,
}: {
  readonly options: readonly PlanApprovalOption[];
  /** Collapse only the controls, retaining the mounted draft editor. */
  readonly expanded?: boolean;
  /** Opens the plan to read; absent until the plan is tracked. */
  readonly onOpenPlan?: () => void;
  /** Closes the prompt and keeps the plan waiting. */
  readonly onClose: () => void;
  /** The text row. */
  readonly children: ReactNode;
}): JSX.Element {
  const titleId = useId();
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusRow = (index: number): void => {
    rowRefs.current[index]?.focus();
  };

  const handleRowKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      focusRow((index + step + options.length) % options.length);
      return;
    }
    const picked = Number.parseInt(event.key, 10);
    if (Number.isInteger(picked) && picked >= 1 && picked <= options.length) {
      event.preventDefault();
      const option = options[picked - 1];
      if (option && option.disabled !== true) option.onSelect();
    }
  };

  return (
    <div
      data-testid={expanded ? 'chat-plan-approval' : undefined}
      className={expanded ? 'flex flex-col gap-1' : undefined}
      onKeyDown={(event): void => {
        if (!expanded || event.key !== 'Escape' || event.defaultPrevented)
          return;
        event.preventDefault();
        onClose();
      }}
    >
      {expanded && (
        <>
          <div className={`${COMPOSER_PROMPT_HEADER_CLASS} items-center`}>
            <p
              id={titleId}
              className="min-w-0 flex-1 truncate text-s font-medium fg-primary"
            >
              Implement this plan?
            </p>
            {/* Both header actions are the composer's own controls, in the
            primary ink: Open plan as a labeled capsule, x as the
            microphone's 32px circle in send's column. */}
            {onOpenPlan && (
              <ComposerIconButton
                capsule
                autoWidth
                tone="strong"
                onClick={onOpenPlan}
                data-testid="chat-plan-explore"
              >
                Open plan
              </ComposerIconButton>
            )}
            <ComposerIconButton
              capsule
              tone="strong"
              aria-label="Close"
              onClick={onClose}
              data-testid="chat-plan-approval-close"
            >
              <CloseLargeIcon size={16} />
            </ComposerIconButton>
          </div>
          <div
            role="group"
            aria-labelledby={titleId}
            className={COMPOSER_PROMPT_ROWS_CLASS}
          >
            {options.map((option, index) => (
              <button
                key={option.testId}
                ref={(element): void => {
                  rowRefs.current[index] = element;
                }}
                type="button"
                disabled={option.disabled}
                data-testid={option.testId}
                onClick={option.onSelect}
                onKeyDown={(event): void => handleRowKeyDown(event, index)}
                className={ROW_CLASS}
              >
                <span aria-hidden className={ROW_GLYPH_CLASS}>
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {/* The note is one more answer: a pen in the numbers' column. */}
      <ComposerPromptTextRow withPen={expanded} plain={!expanded}>
        {children}
      </ComposerPromptTextRow>
    </div>
  );
}

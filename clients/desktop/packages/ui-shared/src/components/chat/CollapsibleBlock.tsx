import { useState, type JSX, type ReactNode } from 'react';
import { MinusIcon, PlusIcon } from '../../icons';
import { useCleanChatLook } from '../chat-look';
import { STEP_ROW_BODY_CLASS, StepRow } from './StepRow';
import { LightbulbIcon } from '../../icons/AppIcons';

export interface CollapsibleBlockProps {
  forceExpanded?: boolean;
  label: string;
  content: string;
  /** Override the leading icon; defaults to the thinking lightbulb. */
  icon?: ReactNode;
  /**
   * Collapsed-state preview text. Defaults to the first 80 characters of the
   * content (desktop behavior) so both surfaces show the same hint.
   */
  preview?: string;
  /**
   * Clean chat look only: the block is still being written, so its label
   * shimmers. When it is done the row reads {@link doneLabel} if given.
   */
  running?: boolean;
  /** Clean chat look only: the label once the block is done ("Thought"). */
  doneLabel?: string;
}

const HEADLINE_PATTERN = /^\s*\*\*([^*\n]+)\*\*\s*$/gm;

/**
 * The latest headline in a reasoning summary, the bold line Codex and other
 * agents start each thought with ("**Checking worktree statuses**").
 */
export function thinkingHeadline(content: string): string | undefined {
  let headline: string | undefined;
  for (const match of content.matchAll(HEADLINE_PATTERN)) {
    const text = match[1]?.trim();
    if (text) headline = text;
  }
  return headline;
}

/**
 * Shared collapsed transcript block (Thinking, tool results, generic parts).
 * One source of truth for the desktop chat renderer and the web portal so
 * icons, preview text, and expansion chrome cannot drift apart.
 */
export function CollapsibleBlock({
  label,
  content,
  icon,
  preview,
  forceExpanded = false,
  running = false,
  doneLabel,
}: CollapsibleBlockProps): JSX.Element {
  const [open, setIsOpen] = useState(false);
  const isOpen = forceExpanded || open;
  // Clean chat look: a step row like the rest, so its words line up with
  // theirs; the latest headline of the thoughts so far ("Checking worktree
  // statuses") shimmers while it runs; the opened text reads as quiet prose.
  const clean = useCleanChatLook();
  if (clean) {
    return (
      <div>
        <StepRow
          step
          icon={icon ?? <LightbulbIcon />}
          label={
            running
              ? (thinkingHeadline(content) ?? label)
              : (doneLabel ?? label)
          }
          running={running}
          expandable
          isOpen={isOpen}
          onToggle={(): void => setIsOpen((prev) => !prev)}
        />
        {isOpen && (
          <div
            className={`${STEP_ROW_BODY_CLASS} max-h-75 overflow-auto whitespace-pre-wrap break-words fg-tertiary`}
          >
            {content}
          </div>
        )}
      </div>
    );
  }

  const resolvedPreview =
    preview ?? (content.length > 80 ? content.slice(0, 80) + '…' : content);

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="group flex w-full items-center gap-2 py-1 text-xs fg-secondary transition-colors"
      >
        <span className="flex-shrink-0">
          <span className="block group-hover:hidden">
            {icon ?? <LightbulbIcon />}
          </span>
          <span className="hidden group-hover:block">
            {isOpen ? <MinusIcon /> : <PlusIcon />}
          </span>
        </span>
        <span className="truncate">
          {label}
          {!isOpen && resolvedPreview && (
            <span className="ml-2 text-2xs fg-secondary">
              {resolvedPreview}
            </span>
          )}
        </span>
      </button>
      {isOpen && (
        <pre className="ml-5.5 mt-1 max-h-75 overflow-auto whitespace-pre-wrap break-all rounded border bg-fg-primary/[0.02] px-2.5 py-2 text-xs fg-secondary">
          {content}
        </pre>
      )}
    </div>
  );
}

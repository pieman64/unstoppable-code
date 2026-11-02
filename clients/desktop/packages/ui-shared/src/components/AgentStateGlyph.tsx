import type { JSX } from 'react';
import { ThinkingSpinner } from './ThinkingSpinner';
import { Tooltip } from './Tooltip';

/**
 * What an agent is doing, as a row or tab shows it (turn-state D15): a turn
 * is running, or only background work is.
 */
export type AgentState = 'working' | 'background';

export function backgroundTasksLabel(count: number): string {
  return count === 1
    ? '1 background task running'
    : `${count} background tasks running`;
}

export interface AgentStateGlyphProps {
  state: AgentState;
  /** Live background tasks, which name the background state. */
  backgroundTasks?: number;
  /** `row`: a sidebar row's 24px status slot; `inline`: its own size. */
  slot?: 'row' | 'inline';
  /** The spinner's own size, to match the glyphs it alternates with. */
  sizePx?: number;
  /**
   * The chat has output the user hasn't viewed. A tab has no separate unread
   * dot, so its spinner carries the unread ink, as the working one does.
   */
  unread?: boolean;
  /**
   * Off where a label beside the glyph already says it (a drawer tab's
   * "Background 6"): no tooltip, and the glyph is decorative.
   */
  tooltip?: boolean;
  testId?: string;
}

const SLOT_CLASS_NAMES = {
  row: 'inline-flex h-5 w-6 shrink-0 items-center justify-center',
  inline: 'inline-flex shrink-0 items-center justify-center',
} as const;

/**
 * The accent spinner while a turn runs, the neutral one while only background
 * work does. The two differ only in ink at rest, an intentional DESIGN.md
 * deviation for rows and tabs, so the tooltip and accessible name carry the
 * difference.
 */
export function AgentStateGlyph({
  state,
  backgroundTasks = 0,
  slot = 'inline',
  sizePx,
  unread = false,
  tooltip = true,
  testId,
}: AgentStateGlyphProps): JSX.Element {
  const label =
    state === 'working' ? 'Working' : backgroundTasksLabel(backgroundTasks);
  const spinner = (
    <span className="inline-flex h-3 w-3 items-center justify-center">
      <ThinkingSpinner
        tone={unread ? 'unread' : state === 'working' ? 'accent' : 'tertiary'}
        sizePx={sizePx}
      />
    </span>
  );
  if (!tooltip) {
    return (
      <span
        className={SLOT_CLASS_NAMES[slot]}
        aria-hidden="true"
        data-testid={testId}
      >
        {spinner}
      </span>
    );
  }
  // Rich tooltips, never native `title` (CAN-2799): the native one lags on macOS.
  return (
    <Tooltip label={label}>
      {/* An image role names the glyph by its state and hides the
          spinner's own "Thinking" name from assistive technology. */}
      <span
        className={SLOT_CLASS_NAMES[slot]}
        role="img"
        aria-label={label}
        data-testid={testId}
      >
        {spinner}
      </span>
    </Tooltip>
  );
}

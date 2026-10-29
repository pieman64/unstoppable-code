import type { JSX } from 'react';
import { InfoIcon } from '../../icons/AppIcons';

/**
 * A message from the app itself in a transcript (an error, an interruption,
 * a restored session), drawn as a quiet note with an info glyph so it never
 * reads as the agent talking. Used by the clean chat look: it belongs to the
 * turn, so it sits on the steps' left edge with its glyph in their icon
 * column, in the step rows' text, wrapping under itself instead of
 * truncating. Only notices between messages (a compaction) are centered.
 */
export function ChatAppNote({ text }: { text: string }): JSX.Element {
  return (
    <div
      data-testid="chat-app-note"
      className="flex items-start gap-2 py-1 text-s fg-secondary"
    >
      <span
        className="flex h-5 flex-shrink-0 items-center [&_svg]:size-3.5"
        aria-hidden="true"
      >
        <InfoIcon />
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words">{text}</span>
    </div>
  );
}

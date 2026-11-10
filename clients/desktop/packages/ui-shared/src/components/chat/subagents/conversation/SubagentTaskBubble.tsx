import { REPLAY_BLOCK_CLASS } from '../../../../lib/replay-privacy';
import type { JSX } from 'react';
import {
  isVisiblePartShown,
  visibleMessageParts,
  type VisibleMessagePart,
} from '@canopy/agent-transcript';
import { Markdown } from '../../../Markdown';
import { UserBubble } from '../../../UserBubble';
import { WatcherFiredTitle } from '../../WatcherFiredTitle';
import { SubagentIcon } from '../../../../icons/SubagentIcon';
import {
  SUBAGENT_HIDDEN_INSTRUCTIONS_LABEL,
  subagentFollowUpFromLabel,
  subagentSteeringRequestFromLabel,
  subagentTaskFromLabel,
} from '../subagent-copy';

export interface SubagentTaskBubbleProps {
  readonly sender: string;
  readonly kind: 'task' | 'follow_up';
  /** The message as the delegate received it, including hidden context. */
  readonly text: string;
  /** Messages the transcript already shows, such as a user's follow-up. */
  readonly shownTexts?: readonly string[];
}

function PartBubble({
  part,
  label,
}: {
  readonly part: VisibleMessagePart;
  readonly label: string;
}): JSX.Element {
  const text = part.kind === 'hidden' ? '' : part.text;
  return (
    <div className="flex justify-end">
      <div className="max-w-full">
        <UserBubble
          copyText={text}
          variant="info"
          header={
            part.kind === 'watcher' ? (
              <WatcherFiredTitle watcherFired={part.watcherFired} />
            ) : (
              <span className="flex items-center gap-1.5 text-2xs fg-secondary">
                <SubagentIcon size={12} />
                {part.kind === 'steering_request' && part.requestedBy
                  ? subagentSteeringRequestFromLabel(part.requestedBy)
                  : label}
              </span>
            )
          }
        >
          {part.kind === 'hidden' ? (
            <div className="text-s fg-tertiary">
              {SUBAGENT_HIDDEN_INSTRUCTIONS_LABEL}
            </div>
          ) : (
            <div className={`${REPLAY_BLOCK_CLASS} text-s`}>
              <Markdown>{text}</Markdown>
            </div>
          )}
        </UserBubble>
      </div>
    </div>
  );
}

/**
 * The parent's initial task or later follow-up, presented as agent messages.
 * Host messages carry their content as hidden instructions, and one that
 * arrives while a follow-up is queued is folded into that run's prompt, so
 * each part gets its own bubble: a watcher notification shows like the main
 * chat's watcher message, a delegate's steering request shows its request,
 * and other hidden instructions are not shown. Text the transcript already
 * shows as an authored message is left out.
 */
export function SubagentTaskBubble({
  sender,
  kind,
  text,
  shownTexts = [],
}: SubagentTaskBubbleProps): JSX.Element | null {
  const parts = visibleMessageParts(text).filter(
    (part) => !isVisiblePartShown(part, shownTexts),
  );
  if (parts.length === 0) return null;
  const label =
    kind === 'task'
      ? subagentTaskFromLabel(sender)
      : subagentFollowUpFromLabel(sender);
  return (
    <>
      {parts.map((part, index) => (
        <PartBubble key={index} part={part} label={label} />
      ))}
    </>
  );
}

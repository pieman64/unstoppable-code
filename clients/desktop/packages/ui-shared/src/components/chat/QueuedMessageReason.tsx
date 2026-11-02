import { memo, type JSX, type ReactNode } from 'react';
import type { QueuedMessageWaitingReason } from '@canopy/protocol/portal';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';
import { LoadingSpinner } from '../LoadingSpinner';
import { Tooltip } from '../Tooltip';
import {
  QueuedMessageSetupClock,
  type QueuedMessageSetupWait,
} from './QueuedMessageSetupClock';

/**
 * Copy for each host-reported reason a queued message is waiting. Product
 * copy, not conversation content: it describes what will happen, never the
 * turn or steering internals behind it.
 */
export const QUEUED_MESSAGE_WAITING_REASON_COPY: Readonly<
  Record<QueuedMessageWaitingReason, string>
> = {
  steer_unavailable: 'Sends as soon as the agent can take it.',
  background_work:
    'Sends when background work finishes, so your new settings can apply. Run now sends it without them.',
};

/** What happens to a message held for setup once setup finishes. */
export const QUEUED_MESSAGE_SETUP_PROMISE =
  "Your message will send automatically when it's ready.";

/** The compact row's visible setup status, before its clock. */
export const QUEUED_MESSAGE_SETUP_SHORT_STATUS = "Setting up this chat's copy";

const SETUP_SENTENCE_PREFIX = "Setting up this chat's copy of ";
const SETUP_FALLBACK_PROJECT = 'the project';

/** The project name to show, or `null` when the host has none. */
function setupProjectName(projectName: string | undefined): string | null {
  const trimmed = projectName?.trim();
  return trimmed ? trimmed : null;
}

/** `Setting up this chat's copy of <project>.`, naming "the project" when blank. */
export function queuedMessageSetupSentence(
  projectName: string | undefined,
): string {
  return `${SETUP_SENTENCE_PREFIX}${setupProjectName(projectName) ?? SETUP_FALLBACK_PROJECT}.`;
}

/** The polite announcement when a message starts waiting for setup. */
export function queuedMessageSetupAnnouncement(
  projectName: string | undefined,
): string {
  return `Queued. ${queuedMessageSetupSentence(projectName)} ${QUEUED_MESSAGE_SETUP_PROMISE}`;
}

/** The polite announcement when held messages actually start sending. */
export function queuedMessageSendingAnnouncement(count: number): string {
  return count > 1 ? 'Sending your messages.' : 'Sending your message.';
}

export type QueuedMessageReasonProps =
  | {
      /** Free-text reason supplied by the caller, rendered as given. */
      readonly reason: string;
      readonly waitingReason?: never;
      readonly setup?: never;
    }
  | {
      /** Host-reported reason; the unit maps it to its copy. */
      readonly waitingReason: QueuedMessageWaitingReason;
      /** Compact queue rows keep the full explanation in their tooltip. */
      readonly layout?: 'stack' | 'inline';
      readonly reason?: never;
      readonly setup?: never;
    }
  | {
      /** The message waits for this chat's copy of the project to be set up. */
      readonly setup: QueuedMessageSetupWait;
      /**
       * `stack` (the bubble) shows the whole sentence and promise, then the
       * spinner and clock on their own row; `inline` (the compact row)
       * shortens it to one truncating line and keeps the full text for
       * assistive technology and its tooltip.
       */
      readonly layout?: 'stack' | 'inline';
      /** Fixed clock reading for fixtures and captures; never ticks. */
      readonly nowMs?: number;
      readonly reason?: never;
      readonly waitingReason?: never;
    };

/** The label and reason share one readable size and ink. */
export const QUEUED_MESSAGE_LABEL_CLASS = 'mb-1 text-xs fg-secondary';
const REASON_CLASS = QUEUED_MESSAGE_LABEL_CLASS;

/** The setup sentence with its project name masked from session replay. */
function SetupSentence({
  projectName,
}: {
  readonly projectName: string | undefined;
}): JSX.Element {
  const name = setupProjectName(projectName);
  if (name === null) return <>{queuedMessageSetupSentence(undefined)}</>;
  return (
    <>
      {SETUP_SENTENCE_PREFIX}
      <span className={REPLAY_MASK_CLASS}>{name}</span>.
    </>
  );
}

function SetupReason({
  setup,
  layout,
  nowMs,
}: {
  readonly setup: QueuedMessageSetupWait;
  readonly layout: 'stack' | 'inline';
  readonly nowMs: number | undefined;
}): JSX.Element {
  const clock = (
    <QueuedMessageSetupClock
      startedAtMs={setup.startedAtMs}
      estimateMs={setup.estimateMs}
      nowMs={nowMs}
    />
  );
  // The spinner is decorative: the words carry the state. Under reduced
  // motion it holds still and still reads as "working".
  const spinner = <LoadingSpinner decorative className="shrink-0" />;
  if (layout === 'inline') {
    const fullText = (
      <>
        <SetupSentence projectName={setup.projectName} />{' '}
        {QUEUED_MESSAGE_SETUP_PROMISE}
      </>
    );
    return (
      <Tooltip label={fullText} allowShrink className="min-w-0 max-w-full">
        <span
          // Focusable so a keyboard user can open the tooltip with the
          // full sentence the visible line shortens.
          tabIndex={0}
          data-testid="queued-message-setup-reason"
          data-layout="inline"
          className="flex min-w-0 items-center gap-1.5 fg-secondary"
        >
          {spinner}
          <span aria-hidden="true" className="min-w-0 truncate">
            {QUEUED_MESSAGE_SETUP_SHORT_STATUS}
          </span>
          <span aria-hidden="true" className="shrink-0">
            ·
          </span>
          {clock}
          <span
            className="sr-only"
            data-testid="queued-message-setup-full-text"
          >
            {fullText}
          </span>
        </span>
      </Tooltip>
    );
  }
  return (
    <div
      className={REASON_CLASS}
      data-testid="queued-message-setup-reason"
      data-layout="stack"
    >
      <div>
        <SetupSentence projectName={setup.projectName} />{' '}
        {QUEUED_MESSAGE_SETUP_PROMISE}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5">
        {spinner}
        {clock}
      </div>
    </div>
  );
}

/**
 * The queued message body while it waits for setup, set off like a quoted
 * block so the status reads as the explanation and the message as the content.
 */
export function QueuedMessageSetupQuote({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      data-testid="queued-message-setup-quote"
      className="border-l-2 border-line-base pl-3"
    >
      {children}
    </div>
  );
}

export const QueuedMessageReason = memo(function QueuedMessageReason(
  props: QueuedMessageReasonProps,
): JSX.Element {
  if (props.setup !== undefined) {
    return (
      <SetupReason
        setup={props.setup}
        layout={props.layout ?? 'stack'}
        nowMs={props.nowMs}
      />
    );
  }
  if (props.waitingReason !== undefined) {
    if (props.layout === 'inline') {
      const text = QUEUED_MESSAGE_WAITING_REASON_COPY[props.waitingReason];
      return (
        <Tooltip label={text}>
          <span
            className="min-w-0 truncate text-xs fg-tertiary"
            data-testid="queued-message-waiting-reason"
            data-waiting-reason={props.waitingReason}
          >
            {text}
          </span>
        </Tooltip>
      );
    }
    return (
      <div
        className={REASON_CLASS}
        data-testid="queued-message-waiting-reason"
        data-waiting-reason={props.waitingReason}
      >
        {QUEUED_MESSAGE_WAITING_REASON_COPY[props.waitingReason]}
      </div>
    );
  }
  return <div className={REASON_CLASS}>{props.reason}</div>;
});

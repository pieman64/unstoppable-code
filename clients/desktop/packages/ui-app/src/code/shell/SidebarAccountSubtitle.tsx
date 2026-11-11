import type { JSX, MouseEvent } from 'react';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { Dot } from '@canopy/ui-shared/components/Badge';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';

/**
 * Second line for the account row (CAN-3659): the Remote Control connection
 * state while it is on. Otherwise the row shows only the name; the email is
 * in the account menu header. Pure display: the host maps its own connection
 * source onto {@link SidebarRemoteControlStatus}, and a host without Remote
 * Control simply never passes a status.
 *
 * The span is not named with `aria-label`: the row's trigger takes its
 * accessible name from `aria-labelledby`, and the host passes the matching
 * text as the row's `subtitleLabel`.
 */
export type SidebarRemoteControlStatus =
  | 'active'
  | 'reconnecting'
  | 'disconnected';

const SUBTITLE_CLASS_NAME =
  'relative mt-0 flex h-4 min-w-0 items-center gap-1.5 text-2xs font-normal leading-4';

const SUBTITLE_TEXT_CLASS_NAME = 'block min-w-0 truncate whitespace-nowrap';

/**
 * DESIGN.md gives a row that shows its label no tooltip repeating it, so the
 * full text is offered on hover only while the line is actually truncated.
 */
function titleWhileTruncated(
  text: string,
): (event: MouseEvent<HTMLSpanElement>) => void {
  return (event) => {
    const element = event.currentTarget;
    if (element.scrollWidth > element.clientWidth) element.title = text;
    else element.removeAttribute('title');
  };
}

/**
 * The status reads as a sentence ("Remote control active"), so only its first
 * word keeps the feature name's capital.
 */
const REMOTE_CONTROL_STATUS_SUBJECT = `${REMOTE_CONTROL_LABEL.charAt(0)}${REMOTE_CONTROL_LABEL.slice(1).toLowerCase()}`;

/** The line's text, also the row's accessible name. */
export function sidebarRemoteControlSubtitleLabel(
  status: SidebarRemoteControlStatus,
): string {
  switch (status) {
    case 'active':
      return `${REMOTE_CONTROL_STATUS_SUBJECT} active`;
    case 'reconnecting':
      return `${REMOTE_CONTROL_STATUS_SUBJECT} reconnecting`;
    case 'disconnected':
      return `${REMOTE_CONTROL_STATUS_SUBJECT} disconnected`;
  }
}

export interface SidebarRemoteControlSubtitleProps {
  readonly status: SidebarRemoteControlStatus;
}

/**
 * Dot plus text. Active and reconnecting share the info dot; reconnecting
 * adds the ping ring `ActivityPingDot` uses, which freezes under
 * `prefers-reduced-motion`. Disconnected takes the failed ink. The visible
 * text is the accessible label, so the row's name always contains it.
 */
export function SidebarRemoteControlSubtitle({
  status,
}: SidebarRemoteControlSubtitleProps): JSX.Element {
  const disconnected = status === 'disconnected';
  const label = sidebarRemoteControlSubtitleLabel(status);
  return (
    <span
      data-testid="sidebar-account-remote-control-subtitle"
      data-status={status}
      className={`${SUBTITLE_CLASS_NAME} ${disconnected ? OPERATIONAL_STATUS_COLORS.failed.foreground : 'fg-tertiary'}`}
    >
      <span
        aria-hidden="true"
        data-testid="sidebar-account-remote-control-dot"
        className="relative inline-flex h-2 w-2 shrink-0 items-center justify-center"
      >
        {status === 'reconnecting' && (
          <span
            data-testid="sidebar-account-remote-control-ping"
            className={`absolute inline-flex h-full w-full animate-ping rounded-full motion-reduce:animate-none ${OPERATIONAL_STATUS_COLORS.success.backgroundPing}`}
          />
        )}
        {/* A remote session is a live connection. */}
        <Dot tone={disconnected ? 'danger' : 'success'} className="relative" />
      </span>
      <span
        className={SUBTITLE_TEXT_CLASS_NAME}
        onMouseEnter={titleWhileTruncated(label)}
      >
        {label}
      </span>
    </span>
  );
}

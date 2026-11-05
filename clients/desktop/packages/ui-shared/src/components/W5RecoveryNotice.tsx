'use client';
import type { JSX } from 'react';
import type { W5RecoveryStatus } from '@canopy/protocol/portal';
import { w5RecoveryGuidance } from '../lib/w5-recovery-copy';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { Notice, NoticeButton } from './Notice';

export interface W5RecoveryNoticeProps {
  readonly status: W5RecoveryStatus;
  /** Host capability, independent from the target desktop's status. Default-deny. */
  readonly canRecover?: boolean;
  readonly onRecover?: () => void;
  readonly busy?: boolean;
}

export function W5RecoveryNotice({
  status,
  canRecover = false,
  onRecover,
  busy = false,
}: W5RecoveryNoticeProps): JSX.Element | null {
  if (status.state === 'hidden') return null;
  const restart = status.state === 'restart-required';
  const complete = status.state === 'complete';
  return (
    <Notice
      intent={complete ? 'positive' : 'attention'}
      title={
        restart
          ? 'Workspace recovery needs a restart'
          : complete
            ? 'Workspace recovery finished'
            : status.state === 'refused'
              ? 'Workspace recovery needs attention'
              : 'Some workspace changes are blocked'
      }
      className="pointer-events-auto"
      data-testid="w5-recovery-notice"
      actions={
        canRecover && status.canRecover && onRecover ? (
          <NoticeButton
            busy={busy}
            busyLabel="Preparing recovery…"
            onClick={onRecover}
            data-testid="w5-recovery-start"
          >
            Restart for recovery
          </NoticeButton>
        ) : undefined
      }
    >
      <p>
        {restart
          ? 'Quit and reopen the app to inspect the records and choose what to do. Writes are paused until restart.'
          : complete
            ? 'The selected recovery decisions finished.'
            : w5RecoveryGuidance(status.reason)}
      </p>
      {!canRecover && !restart && !complete && (
        <p>
          Recover on this computer: open the app on the computer that holds
          these records. Recovery cannot run from Remote Control.
        </p>
      )}
      {status.entries.length > 0 && (
        <ul className={REPLAY_BLOCK_CLASS}>
          {status.entries.slice(0, 5).map((entry) => (
            <li key={entry.id}>
              {entry.operation}: {entry.detail.slice(0, 160)}
            </li>
          ))}
        </ul>
      )}
      {status.entries.length > 5 && (
        <p>More changes are included in the recovery diagnosis.</p>
      )}
    </Notice>
  );
}

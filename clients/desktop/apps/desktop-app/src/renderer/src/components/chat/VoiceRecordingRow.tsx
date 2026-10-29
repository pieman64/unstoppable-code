import { useEffect, useState, type JSX } from 'react';
import { AudioWaveform, Tooltip } from '@canopy/ui-shared';
import {
  CloseLargeIcon,
  StopFilledIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { ComposerSendButton } from './ComposerSendButton';

/** A take's length as `m:ss`. */
export function formatRecordingDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function RecordingDuration({ since }: { since: number | null }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return undefined;
    setNow(Date.now());
    const id = window.setInterval((): void => setNow(Date.now()), 250);
    return (): void => window.clearInterval(id);
  }, [since]);
  return (
    <span
      data-testid="voice-recording-duration"
      // 8px past the row's gap: the time reads with the stop button, not
      // squeezed against it.
      className="mr-2 flex h-8 shrink-0 items-center text-xs tabular-nums fg-secondary"
    >
      {formatRecordingDuration(since === null ? 0 : now - since)}
    </span>
  );
}

/** The composer's secondary round control: the + button's recipe. */
const SECONDARY_ROUND_BUTTON_CLASS =
  'focus-ring inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-subtle fg-primary ring-[length:var(--border-hairline)] ring-inset ring-line-tertiary transition enabled:hover:bg-muted enabled:active:scale-97';

export interface VoiceRecordingRowProps {
  /** Loudest microphone level since the previous call (see useVoiceTranscription). */
  readLevel: () => number;
  /** When the take started (epoch ms), or `null` before it has. */
  listeningSince: number | null;
  /** Throws the take away. */
  onCancel: () => void;
  /** Ends the take and keeps its words in the draft to edit. */
  onStop: () => void;
  /** Ends the take and sends the draft with its words. */
  onSend: () => void;
}

/**
 * The composer's toolbar while dictating: discard on the left, the live
 * waveform, then the take's length, stop (keep the words) and send. The words
 * stay out of the text area above until the take ends, then land once at the
 * cursor, so typing while recording is never overwritten.
 */
export function VoiceRecordingRow({
  readLevel,
  listeningSince,
  onCancel,
  onStop,
  onSend,
}: VoiceRecordingRowProps): JSX.Element {
  return (
    <div
      data-testid="voice-recording-row"
      className="flex min-w-0 items-center gap-2 p-2"
    >
      <Tooltip label="Discard recording" shortcut="Esc" delay="long">
        <button
          type="button"
          onClick={onCancel}
          aria-label="Discard recording"
          data-testid="voice-recording-cancel"
          className={SECONDARY_ROUND_BUTTON_CLASS}
        >
          <CloseLargeIcon size={16} />
        </button>
      </Tooltip>
      <AudioWaveform
        readLevel={readLevel}
        dataTestId="voice-recording-waveform"
      />
      <RecordingDuration since={listeningSince} />
      <Tooltip label="Stop recording" delay="long">
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop recording"
          data-testid="voice-recording-stop"
          className={SECONDARY_ROUND_BUTTON_CLASS}
        >
          <StopFilledIcon size={16} />
        </button>
      </Tooltip>
      <ComposerSendButton
        kind="send"
        onSend={onSend}
        disabled={false}
        pending={false}
        dataTestId="voice-recording-send"
      />
    </div>
  );
}

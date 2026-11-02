import { useCallback, useMemo, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { Button, useOverlayEscape } from '@canopy/ui-shared/components';

interface ScheduleMessageModalProps {
  /** When editing an existing schedule, the current ISO runAt to seed fields. */
  initialRunAt?: string;
  onCancel: () => void;
  /** Receives the chosen one-time send time as an ISO 8601 string. */
  onSave: (runAtIso: string) => void;
  /**
   * Document to portal into. Defaults to the ambient `document`. The composer
   * passes the document that owns it so the modal opens in the correct window
   * when the chat has been popped out to an aux panel window.
   */
  ownerDocument?: Document;
}

function pad(value: number, length = 2): string {
  return value.toString().padStart(length, '0');
}

function toDateInputValue(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}`;
}

function toTimeInputValue(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Minimal centered modal for staging a one-time scheduled send. Defaults to
 * today at the current time + 5 minutes. The composer owns persistence; this
 * modal only validates and hands back an ISO future-local time.
 */
export function ScheduleMessageModal({
  initialRunAt,
  onCancel,
  onSave,
  ownerDocument,
}: ScheduleMessageModalProps): JSX.Element {
  const defaults = useMemo(() => {
    const seed = initialRunAt ? new Date(initialRunAt) : null;
    const base =
      seed && !Number.isNaN(seed.getTime())
        ? seed
        : new Date(Date.now() + 5 * 60 * 1000);
    return { date: toDateInputValue(base), time: toTimeInputValue(base) };
  }, [initialRunAt]);

  const [date, setDate] = useState(defaults.date);
  const [time, setTime] = useState(defaults.time);
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback((): void => {
    if (!date || !time) {
      setError('Choose a future time.');
      return;
    }
    const candidate = new Date(`${date}T${time}:00`);
    if (
      Number.isNaN(candidate.getTime()) ||
      candidate.getTime() <= Date.now()
    ) {
      setError('Choose a future time.');
      return;
    }
    onSave(candidate.toISOString());
  }, [date, time, onSave]);

  // The modal is mounted only while open. Registering as an overlay lets it
  // take Escape ahead of the composer's cancel-turn shortcut.
  useOverlayEscape(true, onCancel, ownerDocument);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Schedule message"
      data-testid="schedule-message-modal"
      className="fixed inset-0 z-modal flex items-center justify-center bg-overlay-scrim p-4"
      onClick={onCancel}
    >
      <section
        className="electron-no-drag flex w-full max-w-sm flex-col overflow-hidden rounded-lg bg-card shadow-xl"
        onClick={(event): void => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-s font-semibold fg-primary">Schedule message</h2>
          <Button
            variant="ghost"
            size="compact"
            iconOnly
            onClick={onCancel}
            aria-label="Close"
          >
            ×
          </Button>
        </header>
        <div className="flex flex-col gap-3 px-4 py-3 text-s">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium fg-secondary">Date</span>
            <input
              type="date"
              value={date}
              onChange={(event): void => {
                setDate(event.target.value);
                setError(null);
              }}
              data-testid="schedule-message-date"
              className="focus-ring w-full rounded-md border bg-base px-2 py-1.5 text-s fg-primary"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium fg-secondary">Time</span>
            <input
              type="time"
              value={time}
              onChange={(event): void => {
                setTime(event.target.value);
                setError(null);
              }}
              data-testid="schedule-message-time"
              className="focus-ring w-full rounded-md border bg-base px-2 py-1.5 text-s fg-primary"
            />
          </label>
          {error && (
            <div role="alert" className="text-xs fg-destructive">
              {error}
            </div>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button
            size="compact"
            onClick={onCancel}
            data-testid="schedule-message-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={handleSave}
            data-testid="schedule-message-save"
          >
            Set schedule
          </Button>
        </footer>
      </section>
    </div>,
    (ownerDocument ?? document).body,
  );
}

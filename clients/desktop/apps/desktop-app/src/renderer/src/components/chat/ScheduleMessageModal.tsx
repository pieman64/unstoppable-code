import { useCallback, useMemo, useState, type JSX } from 'react';
import {
  Button,
  DateField,
  DialogModal,
  FormField,
  Select,
  toIsoDateValue,
  type SelectOption,
} from '@canopy/ui-shared/components';

interface ScheduleMessageModalProps {
  /** When editing an existing schedule, the current ISO runAt to seed fields. */
  initialRunAt?: string;
  onCancel: () => void;
  /** Receives the chosen one-time send time as an ISO 8601 string. */
  onSave: (runAtIso: string) => void;
  /**
   * Document the dialog opens in. Defaults to the ambient `document`. The composer
   * passes the document that owns it so the modal opens in the correct window
   * when the chat has been popped out to an aux panel window.
   */
  ownerDocument?: Document;
}

/** The time picker offers a send time every quarter hour. */
const TIME_STEP_MINUTES = 15;
const MINUTES_PER_DAY = 24 * 60;

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function toTimeValue(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

const TIME_LABEL_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

function timeLabel(minutes: number): string {
  return TIME_LABEL_FORMAT.format(
    new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60),
  );
}

/**
 * The first quarter hour at least five minutes away, so a new schedule
 * defaults to a time that is still in the future when the person saves.
 */
function defaultRunAt(): Date {
  const earliest = new Date(Date.now() + 5 * 60 * 1000);
  const minutes = minutesOfDay(earliest);
  const rounded =
    Math.ceil(minutes / TIME_STEP_MINUTES) * TIME_STEP_MINUTES - minutes;
  earliest.setMinutes(earliest.getMinutes() + rounded, 0, 0);
  return earliest;
}

/**
 * Minimal centered modal for staging a one-time scheduled send. Defaults to
 * the first quarter hour at least five minutes away. The composer owns
 * persistence; this modal only validates and hands back an ISO future-local
 * time.
 */
export function ScheduleMessageModal({
  initialRunAt,
  onCancel,
  onSave,
  ownerDocument,
}: ScheduleMessageModalProps): JSX.Element {
  const defaults = useMemo(() => {
    const seed = initialRunAt ? new Date(initialRunAt) : null;
    const base = seed && !Number.isNaN(seed.getTime()) ? seed : defaultRunAt();
    return {
      date: toIsoDateValue(base),
      time: toTimeValue(minutesOfDay(base)),
    };
  }, [initialRunAt]);

  const [date, setDate] = useState(defaults.date);
  const [time, setTime] = useState(defaults.time);
  // The validation message and the field it is about: an empty date is the
  // date's problem; any other past or missing time shows under Time.
  const [error, setError] = useState<{
    readonly field: 'date' | 'time';
    readonly message: string;
  } | null>(null);

  const today = toIsoDateValue(new Date());
  const timeOptions = useMemo((): SelectOption[] => {
    const slots = new Set<string>([defaults.time]);
    for (
      let minutes = 0;
      minutes < MINUTES_PER_DAY;
      minutes += TIME_STEP_MINUTES
    ) {
      slots.add(toTimeValue(minutes));
    }
    // Earlier today has passed: those slots stay listed but can't be chosen.
    const now = date === today ? toTimeValue(minutesOfDay(new Date())) : null;
    return [...slots].sort().map((slot) => {
      const [hours = 0, minutes = 0] = slot.split(':').map(Number);
      return {
        value: slot,
        label: timeLabel(hours * 60 + minutes),
        disabled: now !== null && slot <= now,
      };
    });
  }, [date, today, defaults.time]);

  const handleSave = useCallback((): void => {
    if (!date || !time) {
      setError({
        field: date ? 'time' : 'date',
        message: 'Choose a future time.',
      });
      return;
    }
    const candidate = new Date(`${date}T${time}:00`);
    if (
      Number.isNaN(candidate.getTime()) ||
      candidate.getTime() <= Date.now()
    ) {
      setError({ field: 'time', message: 'Choose a future time.' });
      return;
    }
    onSave(candidate.toISOString());
  }, [date, time, onSave]);

  // DialogModal registers as an overlay while mounted, so it takes Escape
  // ahead of the composer's cancel-turn shortcut.
  return (
    <DialogModal
      onClose={onCancel}
      title="Schedule message"
      maxWidth="sm"
      dataTestId="schedule-message-modal"
      ownerDocument={ownerDocument}
      footer={
        <>
          <Button
            variant="secondary"
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
        </>
      }
    >
      <FormField
        label="Date"
        error={error?.field === 'date' ? error.message : undefined}
      >
        {(control) => (
          <DateField
            {...control}
            value={date}
            min={today}
            ownerDocument={ownerDocument}
            onValueChange={(next): void => {
              setDate(next);
              setError(null);
            }}
            data-testid="schedule-message-date"
          />
        )}
      </FormField>
      <FormField
        label="Time"
        error={error?.field === 'time' ? error.message : undefined}
      >
        {(control) => (
          <Select
            {...control}
            options={timeOptions}
            value={time}
            onValueChange={(next): void => {
              setTime(next);
              setError(null);
            }}
            data-testid="schedule-message-time"
          />
        )}
      </FormField>
    </DialogModal>
  );
}

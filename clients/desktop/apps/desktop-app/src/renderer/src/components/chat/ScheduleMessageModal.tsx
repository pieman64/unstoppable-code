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
import {
  buildTimeSlotOptions,
  defaultScheduleRunAt,
  passedTimeOn,
  toTimeSlotValue,
} from '@/lib/timeSlotOptions';

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
    const base =
      seed && !Number.isNaN(seed.getTime()) ? seed : defaultScheduleRunAt();
    return {
      date: toIsoDateValue(base),
      time: toTimeSlotValue(base),
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
  // Earlier today has passed: those slots stay listed but can't be chosen.
  const passed = passedTimeOn(date);
  const timeOptions = useMemo(
    (): SelectOption[] =>
      buildTimeSlotOptions({ keep: [defaults.time], passed }),
    [defaults.time, passed],
  );

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

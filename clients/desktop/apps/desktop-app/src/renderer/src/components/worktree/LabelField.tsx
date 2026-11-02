import { Button } from '@canopy/ui-shared/components';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { Tooltip } from '@canopy/ui-shared';
import { PencilIcon as AppCatalogPencilIcon } from '@canopy/ui-shared/icons/AppIcons';

function PencilIcon(): JSX.Element {
  return <AppCatalogPencilIcon width="14" height="14" />;
}

export interface LabelFieldProps {
  /** Current custom label, or undefined/empty when none is set. */
  label: string | undefined;
  /**
   * Generated value shown (muted) in the non-edit display when no custom label
   * is set. Restored as the effective name whenever the label is cleared.
   */
  fallback: string;
  /**
   * Persist a new label. An empty string clears the custom label so the
   * fallback is used again.
   */
  onSubmit: (label: string) => void | Promise<void>;
  /** When true, open directly into edit mode with the input focused. */
  startInEdit?: boolean;
  /** Called once the `startInEdit` request has been consumed. */
  onEditConsumed?: () => void;
  /** Placeholder shown in the edit input (defaults to the fallback). */
  placeholder?: string;
}

/**
 * Inline editable display-label field used by the Branch Info and Chat Info
 * modals. The non-edit display shows the custom label when set, otherwise the
 * generated fallback (muted). The edit input always starts from the custom
 * label (empty when only a fallback is in use); saving an empty value clears
 * the label so the fallback is restored. Mirrors the branch-rename edit flow.
 */
export function LabelField({
  label,
  fallback,
  onSubmit,
  startInEdit,
  onEditConsumed,
  placeholder,
}: LabelFieldProps): JSX.Element {
  const trimmedLabel = label?.trim() ?? '';
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(trimmedLabel);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const beginEdit = (): void => {
    setValue(trimmedLabel);
    setError(null);
    setEditing(true);
  };

  // Focus (and select) the input as soon as it mounts on entering edit mode.
  // A layout effect keyed on `editing` is more reliable than a post-render
  // timeout, which can miss the freshly-committed input node.
  useLayoutEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, [editing]);

  const cancelEdit = (): void => {
    setEditing(false);
    setValue(trimmedLabel);
    setError(null);
  };

  useEffect(() => {
    if (!startInEdit) return;
    beginEdit();
    onEditConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot request consume
  }, [startInEdit]);

  const submit = (): void => {
    const next = value.trim();
    if (next === trimmedLabel) {
      cancelEdit();
      return;
    }
    setSaving(true);
    setError(null);
    void (async (): Promise<void> => {
      try {
        await onSubmit(next);
        setEditing(false);
      } catch {
        setError('Could not save label. Try again.');
      } finally {
        setSaving(false);
      }
    })();
  };

  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-3xs font-medium fg-secondary">Label</span>
        {!editing && (
          <Tooltip label={trimmedLabel ? 'Edit label' : 'Set label'}>
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              onClick={beginEdit}
              aria-label={trimmedLabel ? 'Edit label' : 'Set label'}
              data-testid="label-field-edit"
            >
              <PencilIcon />
            </Button>
          </Tooltip>
        )}
      </div>
      {editing ? (
        <div className="mt-1 flex items-center gap-1.5">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') {
                submit();
              } else if (e.key === 'Escape') {
                cancelEdit();
              }
            }}
            disabled={saving}
            placeholder={placeholder ?? fallback}
            className="min-w-0 flex-1 rounded border bg-fg-primary/5 px-2 py-1 text-xs fg-primary outline-none focus:border-line-accent disabled:opacity-60"
            aria-label="Label"
            data-testid="label-field-input"
          />
          <Button
            variant="primary"
            size="compact"
            disabled={saving}
            onClick={submit}
            data-testid="label-field-save"
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button size="compact" onClick={cancelEdit} disabled={saving}>
            Cancel
          </Button>
          {error && (
            <p className="sr-only" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        <p
          className={`mt-1 truncate text-xs ${
            trimmedLabel ? 'fg-primary' : 'fg-secondary'
          }`}
          title={trimmedLabel || fallback}
          data-testid="label-field-display"
        >
          {trimmedLabel || fallback || 'No label set'}
        </p>
      )}
    </div>
  );
}

'use client';

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';

const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function useDialogFocus(
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  returnFocusRef?: RefObject<HTMLButtonElement | null>,
): (event: React.KeyboardEvent<HTMLElement>) => void {
  useEffect(() => {
    const container = containerRef.current;
    const returnTarget =
      returnFocusRef?.current ??
      (container?.ownerDocument.activeElement instanceof HTMLElement
        ? container.ownerDocument.activeElement
        : null);
    const initial = container?.querySelector<HTMLElement>(
      '[autofocus],button:not([disabled]),input:not([disabled]),[tabindex="0"]',
    );
    (initial ?? container)?.focus();
    return (): void => {
      returnTarget?.focus();
    };
  }, [containerRef, returnFocusRef]);
  return (event): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ??
        [],
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        !containerRef.current?.contains(document.activeElement))
    ) {
      event.preventDefault();
      last?.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last ||
        !containerRef.current?.contains(document.activeElement))
    ) {
      event.preventDefault();
      first?.focus();
    }
  };
}

export interface WorktreeInfoDialogTestIds {
  readonly dialog?: string;
  readonly labelInput?: string;
  readonly save?: string;
}

export interface WorktreeInfoDialogProps {
  readonly mode: 'label' | 'info';
  readonly branch: string;
  readonly worktreeId: string;
  readonly initialLabel?: string;
  readonly onSaveLabel?: (label: string | null) => void | Promise<void>;
  readonly onClose: () => void;
  readonly returnFocusRef?: RefObject<HTMLButtonElement | null>;
  readonly testIds?: WorktreeInfoDialogTestIds;
  /** Early access: the label mode is titled "Rename", as its menu row reads. */
  readonly renameTitle?: boolean;
}

export function WorktreeInfoDialog({
  mode,
  branch,
  worktreeId,
  initialLabel,
  onSaveLabel,
  onClose,
  returnFocusRef,
  testIds,
  renameTitle = false,
}: WorktreeInfoDialogProps): JSX.Element {
  const [label, setLabel] = useState(initialLabel ?? '');
  const [saveError, setSaveError] = useState(false);
  const dialogRef = useRef<HTMLFormElement | null>(null);
  const onKeyDown = useDialogFocus(dialogRef, onClose, returnFocusRef);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSaveError(false);
    const result = onSaveLabel?.(label.trim() || null);
    if (result instanceof Promise) {
      void result.then(onClose, () => {
        // A rejected save keeps the dialog open with feedback instead of
        // silently emitting an unhandled rejection.
        setSaveError(true);
      });
    } else {
      onClose();
    }
  };
  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-overlay-scrim p-4"
      role="presentation"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'label' ? 'Set worktree label' : 'Branch info'}
        data-testid={testIds?.dialog}
        className="max-h-[85dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-xl bg-popover p-4 shadow-xl"
        onSubmit={submit}
        onKeyDown={onKeyDown}
      >
        <h2 className="text-m font-semibold fg-primary">
          {mode === 'label'
            ? renameTitle
              ? 'Rename'
              : 'Set label'
            : 'Branch info'}
        </h2>
        {mode === 'info' ? (
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-s">
            <dt className="fg-secondary">Branch</dt>
            <dd className="min-w-0 break-all fg-primary">{branch}</dd>
            <dt className="fg-secondary">Worktree</dt>
            <dd className="min-w-0 break-all fg-primary">{worktreeId}</dd>
          </dl>
        ) : (
          <label className="mt-4 block text-s fg-secondary">
            Display label
            <input
              autoFocus
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={branch}
              data-testid={testIds?.labelInput}
              className="focus-ring mt-1 w-full rounded-md border bg-base px-3 py-2 fg-primary"
            />
            {saveError && (
              <p role="alert" className="mt-2 text-s fg-destructive">
                Failed to save the label. Try again.
              </p>
            )}
          </label>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button size="compact" onClick={onClose}>
            Close
          </Button>
          {mode === 'label' && onSaveLabel && (
            <Button
              type="submit"
              variant="primary"
              size="compact"
              data-testid={testIds?.save}
            >
              Save
            </Button>
          )}
        </div>
      </form>
    </div>,
    document.body,
  );
}

export interface PipelinePickerEntry {
  readonly id: string;
  readonly name: string;
  readonly disabled?: boolean;
  readonly statusLabel?: string;
}

export interface PipelinePickerDialogTestIds {
  readonly dialog?: string;
  readonly entry?: (id: string) => string;
}

export interface PipelinePickerDialogProps {
  readonly entries: readonly PipelinePickerEntry[];
  readonly onRun: (id: string) => void | Promise<void>;
  readonly onClose: () => void;
  readonly returnFocusRef?: RefObject<HTMLButtonElement | null>;
  readonly testIds?: PipelinePickerDialogTestIds;
}

export function PipelinePickerDialog({
  entries,
  onRun,
  onClose,
  returnFocusRef,
  testIds,
}: PipelinePickerDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onKeyDown = useDialogFocus(dialogRef, onClose, returnFocusRef);
  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-overlay-scrim p-4"
      role="presentation"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Dispatch workflow"
        tabIndex={-1}
        data-testid={testIds?.dialog}
        className="max-h-[85dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-xl bg-popover p-4 shadow-xl"
        onKeyDown={onKeyDown}
      >
        <h2 className="text-m font-semibold fg-primary">Dispatch workflow</h2>
        <div className="mt-3 space-y-1">
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              disabled={entry.disabled}
              onClick={() => {
                const result = onRun(entry.id);
                if (result instanceof Promise) {
                  void result.then(onClose);
                } else {
                  onClose();
                }
              }}
              data-testid={testIds?.entry?.(entry.id)}
              className="focus-ring flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-s fg-primary hover:bg-fg-primary/[0.06] disabled:cursor-not-allowed disabled:fg-secondary/50"
            >
              <span>{entry.name}</span>
              {entry.statusLabel && (
                <span className="text-xs">{entry.statusLabel}</span>
              )}
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Button size="compact" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

'use client';

import {
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from 'react';
import { Fact, FactList } from './FactList';
import { Button } from './Button';
import { DialogModal } from './DialogModal';
import { DialogFormField } from './DialogFormField';
import { TextInput } from './Field';

function stopPropagation(event: SyntheticEvent): void {
  event.stopPropagation();
}

/**
 * Keeps a click on the dialog's scrim from reaching the sidebar row that
 * rendered it. The dialog portals to the body, but React still bubbles its
 * events through the row, where a click selects the worktree. The span is
 * hidden and holds nothing in the DOM; the dialog's own nodes live in its
 * portal.
 */
function RowEventBoundary({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span hidden onClick={stopPropagation}>
      {children}
    </span>
  );
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
  const [saving, setSaving] = useState(false);
  const labelInputId = useId();
  const formId = useId();
  const labelInputRef = useRef<HTMLInputElement | null>(null);
  const close = saving ? (): void => undefined : onClose;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (saving) return;
    setSaveError(false);
    const result = onSaveLabel?.(label.trim() || null);
    if (result instanceof Promise) {
      setSaving(true);
      void result.then(onClose, () => {
        // A rejected save keeps the dialog open with feedback instead of
        // silently emitting an unhandled rejection.
        setSaving(false);
        setSaveError(true);
      });
    } else {
      onClose();
    }
  };
  return (
    <RowEventBoundary>
      <DialogModal
        variant="confirm"
        onClose={close}
        closeOnBackdrop={!saving}
        title={
          mode === 'label'
            ? renameTitle
              ? 'Rename'
              : 'Set label'
            : 'Branch info'
        }
        titleId={`${formId}-title`}
        dataTestId={testIds?.dialog}
        trapFocus
        {...(mode === 'label' ? { initialFocusRef: labelInputRef } : {})}
        {...(returnFocusRef ? { restoreFocusRef: returnFocusRef } : {})}
      >
        <form id={formId} className="flex flex-col" onSubmit={submit}>
          {mode === 'info' ? (
            <FactList
              size="s"
              columnGap="3"
              rowGap="2"
              labelTone="secondary"
              placement="mt-4"
            >
              <Fact label="Branch" fit="break-all">
                {branch}
              </Fact>
              <Fact label="Worktree" fit="break-all">
                {worktreeId}
              </Fact>
            </FactList>
          ) : (
            <div className="mt-4">
              <DialogFormField label="Display label" htmlFor={labelInputId}>
                <TextInput
                  ref={labelInputRef}
                  id={labelInputId}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder={branch}
                  data-testid={testIds?.labelInput}
                />
              </DialogFormField>
              {saveError && (
                <p role="alert" className="mt-2 text-s fg-destructive">
                  Failed to save the label. Try again.
                </p>
              )}
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button size="compact" onClick={close} disabled={saving}>
              Close
            </Button>
            {mode === 'label' && onSaveLabel && (
              <Button
                type="submit"
                variant="primary"
                size="compact"
                disabled={saving}
                aria-busy={saving}
                data-testid={testIds?.save}
              >
                Save
              </Button>
            )}
          </div>
        </form>
      </DialogModal>
    </RowEventBoundary>
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
  const [running, setRunning] = useState(false);
  const titleId = useId();
  const close = running ? (): void => undefined : onClose;
  return (
    <RowEventBoundary>
      <DialogModal
        variant="confirm"
        onClose={close}
        closeOnBackdrop={!running}
        title="Dispatch workflow"
        titleId={titleId}
        dataTestId={testIds?.dialog}
        trapFocus
        {...(returnFocusRef ? { restoreFocusRef: returnFocusRef } : {})}
      >
        <div className="mt-3 space-y-1">
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              disabled={entry.disabled === true || running}
              onClick={() => {
                const result = onRun(entry.id);
                if (result instanceof Promise) {
                  setRunning(true);
                  void result.then(onClose, () => setRunning(false));
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
          <Button size="compact" onClick={close} disabled={running}>
            Cancel
          </Button>
        </div>
      </DialogModal>
    </RowEventBoundary>
  );
}

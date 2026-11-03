import { type JSX, type ReactNode } from 'react';
import { AnsiOutput, Button, DialogModal } from '@canopy/ui-shared/components';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';

/** Operational status of the run, which inks the status text. */
export type RunOutputStatus = 'active' | 'success' | 'paused' | 'failed';

export interface RunOutputModalProps {
  /** Modal title — typically the run label (e.g. script/hook name). */
  title: string;
  /** Modal subtitle slot. Both sections route the status label here. */
  subtitle: string;
  /** DOM id for the dialog title (a11y). */
  titleId: string;
  /** Status text rendered in the top status row. */
  statusLabel: string;
  status: RunOutputStatus;
  /** Run duration in milliseconds. Rendered as `{seconds}s` when not running
   * and the duration is greater than zero. */
  durationMs: number;
  /** ANSI output lines. When empty, the log surface shows `emptyText`. */
  outputLines: readonly string[];
  /** True while the run is still in flight. Hides the duration display and
   * shows the optional Stop button. */
  isRunning: boolean;
  onClose: () => void;
  /** Stop click handler. Required for the Stop button to appear. */
  onStop?: () => void;
  /** Stop button label — script section flips between `Stop` and `Stopping…`,
   * hooks always pass `Stop`. */
  stopLabel?: string;
  /** Disable the stop button (e.g. while a stop is in-flight). */
  stopDisabled?: boolean;
  /** Optional search bar slot, rendered between the status row and the output
   * panel. Scripts mount their AnsiSearch input here; hooks omit. */
  searchSlot?: ReactNode;
  /**
   * Optional dev-server open-control slot, rendered before the duration text
   * in the right-aligned status row. Rendered regardless of `isRunning` so
   * the in-memory completed run can still display detected URLs.
   */
  devServerSlot?: ReactNode;
  /** Empty-state copy displayed when `outputLines.length === 0`. */
  emptyText: string;
  /** Optional additional ANSI output props (search highlighting). */
  ansiSearchQuery?: string;
  ansiActiveMatchIndex?: number;
  ansiOnMatchCountChange?: (count: number) => void;
}

/**
 * Shared "enlarge run output" modal used by both {@link HooksSection} and
 * {@link ScriptsSection}. The two sections previously hand-rolled the same
 * `DialogModal` + status row + ANSI output / empty-state combo; the shared
 * component only differs by the search slot (script-only) and stop-button
 * copy/disabled state.
 *
 * Visible copy is supplied entirely by the caller — this component never
 * embeds section-specific text.
 */
export function RunOutputModal({
  title,
  subtitle,
  titleId,
  statusLabel,
  status,
  durationMs,
  outputLines,
  isRunning,
  onClose,
  onStop,
  stopLabel,
  stopDisabled,
  searchSlot,
  devServerSlot,
  emptyText,
  ansiSearchQuery,
  ansiActiveMatchIndex,
  ansiOnMatchCountChange,
}: RunOutputModalProps): JSX.Element {
  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      titleId={titleId}
      maxWidth="3xl"
      minHeight="24rem"
    >
      {/* The controls keep the dialog's 20px column. The log below runs edge to
          edge and the dialog clips it, so it shares the dialog's corners. The
          status row already says whether the run failed, so the log surface
          stays neutral. */}
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        data-testid="run-output-body"
      >
        <div
          className="flex flex-col gap-3 px-6 pb-3 pt-3"
          data-testid="run-output-controls"
        >
          <div className="flex items-center justify-between text-xs">
            <span
              className={`font-medium ${OPERATIONAL_STATUS_COLORS[status].foreground}`}
            >
              {statusLabel}
            </span>
            <div className="flex items-center gap-2">
              {devServerSlot}
              {!isRunning && durationMs > 0 && (
                <span className="fg-secondary">
                  {Math.round(durationMs / 1000)}s
                </span>
              )}
              {isRunning && onStop && (
                <Button
                  type="button"
                  variant="ghost-destructive"
                  size="compact"
                  onClick={onStop}
                  disabled={stopDisabled}
                >
                  {stopLabel ?? 'Stop'}
                </Button>
              )}
            </div>
          </div>
          {searchSlot}
        </div>
        <AnsiOutput
          lines={outputLines}
          variant="reader"
          className="min-h-0 flex-1"
          placeholder={emptyText}
          searchQuery={ansiSearchQuery}
          activeMatchIndex={ansiActiveMatchIndex}
          onMatchCountChange={ansiOnMatchCountChange}
        />
      </div>
    </DialogModal>
  );
}

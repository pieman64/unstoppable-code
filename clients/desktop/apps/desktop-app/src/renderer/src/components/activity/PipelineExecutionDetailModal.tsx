import { useCallback, useEffect, useId, useRef, type JSX } from 'react';
import { PipelineIcon } from '@canopy/ui-shared/icons';
import { CloseIcon as AppCatalogCloseIcon } from '@canopy/ui-shared/icons/AppIcons';
import { hasEscapeEnabledOverlay } from '@canopy/ui-shared/components';
import type { PipelineDetailOwner } from '@/stores/pipelineDetailCoordinator';
import { PipelineExecutionDetail } from './details/PipelineExecutionDetail';
import type {
  ArchivedPipelineSource,
  BreadcrumbEntry,
  PipelineDetailDestination,
  PipelineExecutionDetailRevealTarget,
} from './details/pipelineDetailTypes';
import type { PipelineExecutionActions } from './usePipelineExecutionActions';
import { PIPELINE_DETAIL_MODAL_UI_STATE_KEY } from '@/lib/current-ui-state/pipelineDetailUiState';

/** The current-UI slice the compatibility modal reports under. */
export { PIPELINE_DETAIL_MODAL_UI_STATE_KEY };

export type { BreadcrumbEntry } from './details/pipelineDetailTypes';

interface PipelineExecutionDetailModalProps {
  executionId: string;
  onClose: () => void;
  initialJobId?: string;
  /** Pre-populate breadcrumb navigation when opening directly to a child. */
  initialViewStack?: BreadcrumbEntry[];
  /**
   * Explicit target for an already-open modal. Re-opening the same run at a
   * different job or breadcrumb changes the nonce, and the open detail
   * applies it instead of ignoring it.
   */
  revealTarget?: PipelineExecutionDetailRevealTarget;
  /**
   * Execution-action controller that outlives the modal (the run list's), so
   * report and follow-up dialogs survive the modal closing to reveal them.
   * Omit it for a read-only host; archived runs show no actions.
   */
  actions?: PipelineExecutionActions;
  /**
   * Read-only archived-container source. Execution state, reports, and step
   * logs are read through the archive transport, and every live-only control
   * is hidden. Pass a referentially stable (memoized) object.
   */
  archivedSource?: ArchivedPipelineSource;
  /**
   * Owner of this detail's lease. Defaults to the worktree selected when the
   * modal opened.
   */
  detailOwner?: PipelineDetailOwner | null;
}

/**
 * The compatibility takeover around {@link PipelineExecutionDetail}: a
 * fullscreen dialog with a drag-region title bar and a close button. It is
 * the host for runs the Activity run list opens and for archived runs; the
 * detail body carries no modal chrome of its own.
 *
 * Escape closes the modal only when nothing else handled it: a nested dialog
 * or menu that owns Escape, or a search field that prevented it, keeps the
 * modal open.
 */
export function PipelineExecutionDetailModal({
  executionId,
  onClose,
  initialJobId,
  initialViewStack,
  revealTarget,
  actions,
  archivedSource,
  detailOwner,
}: PipelineExecutionDetailModalProps): JSX.Element {
  const titleId = `${useId()}-pipeline-execution-detail-title`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const ownerDocument = rootRef.current?.ownerDocument ?? document;
    function handleKeyDown(event: KeyboardEvent): void {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        // A nested dialog or sheet owns Escape while it is open; it registers
        // its listener after this one, so `defaultPrevented` cannot tell yet.
        hasEscapeEnabledOverlay(ownerDocument)
      ) {
        return;
      }
      onCloseRef.current();
    }
    ownerDocument.addEventListener('keydown', handleKeyDown);
    return (): void =>
      ownerDocument.removeEventListener('keydown', handleKeyDown);
  }, []);

  // A covering modal gets out of the way when an action opens another
  // surface. Report and follow-up dialogs live in `actions`, so closing only
  // happens when that controller outlives the modal; the report chat
  // follow-up never closed the modal.
  const handleNavigatedAway = useCallback(
    (destination: PipelineDetailDestination): void => {
      if (destination === 'report-chat') return;
      if (
        actions === undefined &&
        (destination === 'report' || destination === 'pipeline-follow-up')
      ) {
        return;
      }
      onCloseRef.current();
    },
    [actions],
  );

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-modal flex flex-col bg-base"
      role="presentation"
    >
      {/* The frame records; `PipelineExecutionDetail` blocks its own body
          (step logs, output, reports, pause inputs, job and step names). */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <PipelineExecutionDetail
          executionId={executionId}
          owner={detailOwner}
          initialTarget={{ viewStack: initialViewStack, jobId: initialJobId }}
          revealTarget={revealTarget}
          archivedSource={archivedSource}
          actions={actions}
          onNavigatedAway={handleNavigatedAway}
          uiStateKey={
            archivedSource === undefined
              ? PIPELINE_DETAIL_MODAL_UI_STATE_KEY
              : undefined
          }
          renderHeader={({ title }) => (
            // Electron drag region with centered title and close button
            <div className="electron-drag relative flex h-10 shrink-0 items-center justify-center border-b">
              <h2
                id={titleId}
                className="flex min-w-0 items-center gap-2 px-28 text-m font-semibold fg-primary"
              >
                <PipelineIcon
                  width={16}
                  height={16}
                  className="shrink-0 fg-secondary"
                />
                <span className="truncate">{title}</span>
              </h2>
              <div className="electron-no-drag absolute right-2 top-1/2 -translate-y-1/2">
                <button
                  type="button"
                  onClick={onClose}
                  className="focus-ring rounded-md p-1 fg-secondary hover:bg-secondary hover:fg-primary"
                  aria-label="Close"
                >
                  <AppCatalogCloseIcon width="20" height="20" />
                </button>
              </div>
            </div>
          )}
        />
      </div>
    </div>
  );
}

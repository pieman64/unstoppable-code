import { useEffect, useState, type JSX } from 'react';
import { DialogModal, getModelCatalogProviderLabel } from '@canopy/ui-shared';
import { useShallow } from 'zustand/shallow';
import type {
  ResumeQueueControl,
  ResumeQueueEntry,
} from '@canopy/desktop-shared/types';
import {
  useResumeQueueStore,
  resumeQueueProgress,
} from '@/stores/resumeQueueStore';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { LinearProgress } from '@/components/shared/loading';

const labels: Record<ResumeQueueEntry['status'], string> = {
  waiting: 'Waiting',
  resuming: 'Resuming…',
  resumed: 'Resumed',
  skipped: 'No longer interrupted',
  failed: 'Needs attention',
  stopped: 'Stopped',
};

export function ResumeQueueModal(): JSX.Element | null {
  const { snapshot, isOpen, close, apply, connectionError } =
    useResumeQueueStore(
      useShallow((state) => ({
        snapshot: state.snapshot,
        isOpen: state.isOpen,
        close: state.close,
        apply: state.apply,
        connectionError: state.connectionError,
      })),
    );
  const selecting = useUsageLimitResumePromptStore((state) => state.isOpen);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = snapshot ? resumeQueueProgress(snapshot) : null;
  useCurrentUiStateReporter('usage.resumeQueueModal', {
    open: isOpen && !selecting,
    paused: snapshot?.paused ?? false,
    pending,
    processed: progress?.processed ?? 0,
    total: progress?.total ?? 0,
    active: progress?.active ?? false,
    errorVisible: Boolean(error || snapshot?.error || connectionError),
  });
  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.api.onResumeQueueChanged(apply);
    void window.api
      .getResumeQueue()
      .then((state): void => {
        if (!disposed) apply(state);
      })
      .catch((): void => {
        if (!disposed)
          useResumeQueueStore.setState({
            connectionError: 'Could not load the resume queue.',
          });
      });
    return (): void => {
      disposed = true;
      unsubscribe();
    };
  }, [apply]);

  if (!isOpen || selecting) return null;
  const control = async (action: ResumeQueueControl): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      apply(await window.api.controlResumeQueue(action));
      if (action === 'dismiss') close();
    } catch {
      setError('Could not update the queue. Try again.');
    } finally {
      setPending(false);
    }
  };
  const status = snapshot?.error
    ? 'Paused'
    : progress?.active
      ? snapshot?.paused
        ? 'Paused'
        : 'In progress'
      : 'Finished';
  return (
    <DialogModal
      title="Resume queue"
      onClose={close}
      maxWidth="lg"
      subtitle="You can close this window. Your queue is saved automatically."
    >
      <div data-testid="resume-queue-modal" className="flex flex-col">
        <div className="space-y-3 px-5 py-4" role="status" aria-live="polite">
          <div className="flex items-center justify-between text-s">
            <span className="font-medium">{status}</span>
            <span className="fg-secondary">
              {progress?.processed ?? 0} of {progress?.total ?? 0} processed
            </span>
          </div>
          <LinearProgress
            percentage={progress?.percentage ?? 0}
            label="Resume progress"
          />
          <p className="text-xs fg-secondary">
            {progress?.resumed ?? 0} resumed
            {progress?.active ? ` · ${progress.waiting} waiting` : ''}
          </p>
          {progress?.active && (
            <p className="text-xs fg-secondary">
              {snapshot?.paused
                ? 'Waiting sessions will stay paused after restarting the app. Sessions already started keep running.'
                : 'Sessions resume one at a time, with a 10-second delay between starts. Sessions already started keep running.'}
            </p>
          )}
          {(error || snapshot?.error || connectionError) && (
            <p role="alert" className="text-s fg-destructive">
              {error || snapshot?.error || connectionError}
            </p>
          )}
        </div>
        <ol
          className="relative max-h-[45vh] overflow-y-auto px-5 py-2 before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-[var(--border-hairline)] before:bg-[var(--line-base)] before:content-[''] after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-[var(--border-hairline)] after:bg-[var(--line-base)] after:content-['']"
          aria-label="Sessions to resume"
        >
          {snapshot?.entries.map((entry) => (
            <li
              key={entry.id}
              data-testid={`resume-queue-entry-${entry.id}`}
              className="flex items-start justify-between gap-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-s fg-primary" title={entry.title}>
                  {entry.title}
                </p>
                <p className="truncate text-xs fg-secondary">
                  {entry.workspaceName}
                </p>
                <p
                  className="text-xs fg-secondary"
                  data-testid="resume-queue-entry-identity"
                >
                  {entry.target.kind === 'pipeline' ? 'Pipeline · ' : ''}
                  {entry.providers?.length
                    ? entry.providers
                        .map(getModelCatalogProviderLabel)
                        .join(', ')
                    : 'Provider unavailable'}
                </p>
                {entry.error && (
                  <p className="mt-1 text-xs fg-destructive">{entry.error}</p>
                )}
              </div>
              <span
                className={`shrink-0 text-xs ${entry.status === 'failed' ? 'fg-destructive' : 'fg-secondary'}`}
              >
                {labels[entry.status]}
              </span>
            </li>
          ))}
        </ol>
        <div className="flex items-center justify-between gap-2 px-5 py-4">
          <button
            type="button"
            onClick={close}
            className="focus-ring rounded-md px-3 py-1.5 text-s fg-secondary hover:fg-primary"
          >
            Close
          </button>
          <div className="flex gap-2">
            {progress?.active ? (
              <>
                <button
                  type="button"
                  disabled={pending || !!snapshot?.error}
                  onClick={() => {
                    void control('stop');
                  }}
                  className="focus-ring rounded-md px-3 py-1.5 text-s fg-secondary disabled:opacity-50"
                >
                  Stop remaining
                </button>
                <button
                  type="button"
                  disabled={pending || !!snapshot?.error}
                  onClick={() => {
                    void control(snapshot?.paused ? 'resume' : 'pause');
                  }}
                  className="focus-ring rounded-md bg-accent px-3 py-1.5 text-s font-medium fg-emphasis disabled:opacity-50"
                >
                  {snapshot?.paused ? 'Resume queue' : 'Pause queue'}
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={pending || !!snapshot?.error}
                onClick={() => {
                  void control('dismiss');
                }}
                className="focus-ring rounded-md bg-accent px-3 py-1.5 text-s font-medium fg-emphasis disabled:opacity-50"
              >
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </DialogModal>
  );
}

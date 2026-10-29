'use client';

import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { useAnsiSearch } from '@canopy/ui-shared/components';
import { SearchBar } from '@canopy/ui-shared/components/SearchBar';
import { RunOutputModal, type RunOutputStatus } from './RunOutputModal';
import type { ScriptsSectionRun } from './ScriptsSectionBody';

export interface ScriptOutputModalProps {
  readonly run: Pick<
    ScriptsSectionRun,
    | 'label'
    | 'status'
    | 'outputLines'
    | 'exitCode'
    | 'timedOut'
    | 'durationMs'
    | 'startError'
  >;
  readonly onClose: () => void;
  readonly onStop?: () => void;
  readonly devServerSlot?: ReactNode;
}

/** The same searchable script output on Desktop, Remote Control, and Cloud. */
export function ScriptOutputModal({
  run,
  onClose,
  onStop,
  devServerSlot,
}: ScriptOutputModalProps): JSX.Element {
  const isStopping = run.status === 'stopping';
  const isRunning = run.status === 'running' || isStopping;
  const isSuccess = run.status === 'success';
  const search = useAnsiSearch();
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        event.stopPropagation();
        searchInputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return (): void =>
      document.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  const statusLabel = isStopping
    ? 'Stopping…'
    : isRunning
      ? 'Running…'
      : isSuccess
        ? 'Success'
        : run.startError
          ? 'Failed to start'
          : run.timedOut
            ? 'Timed out'
            : run.exitCode === null
              ? 'Stopped'
              : `Exit ${run.exitCode}`;
  const isStopped =
    run.status === 'failed' &&
    run.exitCode === null &&
    !run.timedOut &&
    !run.startError;
  const status: RunOutputStatus = isRunning
    ? 'active'
    : isSuccess
      ? 'success'
      : isStopped
        ? 'paused'
        : 'failed';

  return (
    <RunOutputModal
      title={run.label}
      subtitle={statusLabel}
      titleId="script-output-modal-title"
      statusLabel={statusLabel}
      status={status}
      durationMs={run.durationMs}
      outputLines={run.outputLines}
      isRunning={isRunning}
      onClose={onClose}
      onStop={onStop}
      stopLabel={isStopping ? 'Stopping…' : 'Stop'}
      stopDisabled={isStopping}
      searchSlot={
        <SearchBar
          query={search.query}
          onQueryChange={search.setQuery}
          currentIndex={search.currentIndex}
          totalCount={search.totalCount}
          onNext={search.goToNext}
          onPrevious={search.goToPrevious}
          inputRef={searchInputRef}
        />
      }
      devServerSlot={devServerSlot}
      emptyText="No output"
      ansiSearchQuery={search.ansiSearchQuery}
      ansiActiveMatchIndex={search.ansiActiveMatchIndex}
      ansiOnMatchCountChange={search.ansiOnMatchCountChange}
    />
  );
}

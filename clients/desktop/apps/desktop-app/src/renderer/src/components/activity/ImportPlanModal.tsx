import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/shallow';
import type {
  DetectedPlanEntry,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { isImportablePlanFile } from '@canopy/desktop-shared/importable-plan-file';
import { getWorktreeCacheKey, useFileListStore } from '@/stores/fileListStore';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { searchFiles, type FileSearchResult } from '@/lib/fuzzySearch';
import { getBaseName } from '@/lib/format';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { LoadingSpinner } from '@/components/shared/loading/spinners/LoadingSpinner';
import {
  getFilenameMatchedIndices,
  splitMatchSegments,
  type MatchSegment,
} from '@/components/file-search-palette/file-search-palette-helpers';
import { shouldFetchFileSearchPaletteEntry } from '@/components/file-search-palette/file-search-palette-state';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon } from '@canopy/ui-shared/icons/AppIcons';

const RESULT_LIMIT = 50;

// Stable empty reference so the Zustand selector for detected plans does not
// return a fresh array each render (which loops useSyncExternalStore —
// "Maximum update depth exceeded") when no detections exist for this worktree.
const EMPTY_DETECTED_PLANS: DetectedPlanEntry[] = [];

interface ImportPlanModalProps {
  projectId: string;
  worktreeId: string;
  onClose: () => void;
  onImported: (plan: TrackedPlanData) => void;
  initialTab?: 'search' | 'detected';
  originChatId?: string;
}

export function ImportPlanModal({
  projectId,
  worktreeId,
  onClose,
  onImported,
  initialTab,
  originChatId,
}: ImportPlanModalProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<'search' | 'detected'>(
    initialTab ?? 'search',
  );
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLLIElement>>(new Map());
  const deferredQuery = useDeferredValue(query);

  const importTrackedPlan = useActivityStore(
    (state) => state.importTrackedPlan,
  );
  const loadDetectedPlans = useActivityStore(
    (state) => state.loadDetectedPlans,
  );
  const updateDetectedPlan = useActivityStore(
    (state) => state.updateDetectedPlan,
  );
  const addToast = useGitHubStore((state) => state.addToast);

  const worktreeKey = `${projectId}/${worktreeId}`;
  const detectedEntries = useActivityStore(
    (state) => state.detectedPlans[worktreeKey] ?? EMPTY_DETECTED_PLANS,
  );

  const cacheKey = getWorktreeCacheKey(projectId, worktreeId);
  const { entry, error, isLoading, fetchFileIndex } = useFileListStore(
    useShallow((state) => ({
      entry: state.indexCache[cacheKey],
      error: state.indexErrors[cacheKey],
      isLoading: state.indexLoading.has(cacheKey),
      fetchFileIndex: state.fetchFileIndex,
    })),
  );

  useEffect(() => {
    if (!shouldFetchFileSearchPaletteEntry(entry, isLoading, error)) return;
    void fetchFileIndex(projectId, worktreeId);
  }, [entry, error, fetchFileIndex, isLoading, projectId, worktreeId]);

  useEffect(() => {
    void loadDetectedPlans(projectId, worktreeId);
  }, [loadDetectedPlans, projectId, worktreeId]);

  const results = useMemo(() => {
    const repos = (entry?.data.repos ?? [])
      .filter(
        (repo) =>
          repo.rootKind === 'git-repo' || repo.rootKind === 'workspace-root',
      )
      .map((repo) => ({
        ...repo,
        files: repo.files.filter((file) => isImportablePlanFile(file.filename)),
      }));
    return searchFiles(deferredQuery, repos, RESULT_LIMIT);
  }, [entry, deferredQuery]);

  useEffect(() => {
    if (activeTab === 'search') {
      inputRef.current?.focus();
    }
  }, [activeTab]);

  useEffect(() => {
    if (results.length === 0) {
      setSelectedIndex(-1);
      return;
    }
    setSelectedIndex((current) => {
      if (current < 0) return 0;
      if (current >= results.length) return results.length - 1;
      return current;
    });
  }, [results]);

  useEffect(() => {
    if (selectedIndex < 0) return;
    itemRefs.current.get(selectedIndex)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const runImport = useCallback(
    async (filePath: string | undefined, repoId?: string): Promise<void> => {
      if (importingRef.current) return;
      importingRef.current = true;
      setImporting(true);
      try {
        const plan = await importTrackedPlan(
          projectId,
          worktreeId,
          filePath,
          repoId,
        );
        if (plan) {
          onImported(plan);
          onClose();
        }
        // A null result from Browse means the native dialog was cancelled;
        // keep the modal open so the user can pick again.
      } catch (err: unknown) {
        addToast(
          err instanceof Error ? err.message : 'Failed to import plan',
          'error',
          undefined,
          { projectId, worktreeId },
        );
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    },
    [addToast, importTrackedPlan, onClose, onImported, projectId, worktreeId],
  );

  const runImportDetectedEntry = useCallback(
    async (entry: DetectedPlanEntry): Promise<void> => {
      if (importingRef.current) return;
      importingRef.current = true;
      setImporting(true);
      try {
        const plan = await importTrackedPlan(
          projectId,
          worktreeId,
          entry.sourceFilePath,
          entry.sourceRepoId,
        );
        if (plan) {
          await updateDetectedPlan(projectId, worktreeId, entry.id, {
            status: 'imported',
            importedPlanId: plan.id,
          });
          onImported(plan);
          if (originChatId) {
            useChatStore
              .getState()
              .queuePlanImportInstruction(originChatId, entry.sourceFilePath);
          }
        }
      } catch (err: unknown) {
        addToast(
          err instanceof Error ? err.message : 'Failed to import plan',
          'error',
          undefined,
          { projectId, worktreeId },
        );
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    },
    [
      addToast,
      importTrackedPlan,
      onImported,
      originChatId,
      projectId,
      updateDetectedPlan,
      worktreeId,
    ],
  );

  const runDismissDetectedEntry = useCallback(
    async (entry: DetectedPlanEntry): Promise<void> => {
      try {
        await updateDetectedPlan(projectId, worktreeId, entry.id, {
          status: 'dismissed',
        });
      } catch (err: unknown) {
        addToast(
          err instanceof Error ? err.message : 'Failed to dismiss plan',
          'error',
          undefined,
          { projectId, worktreeId },
        );
      }
    },
    [addToast, projectId, updateDetectedPlan, worktreeId],
  );

  function handleSelect(result: FileSearchResult | undefined): void {
    if (!result) return;
    void runImport(result.relativePath, result.repoId);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (activeTab !== 'search') return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (results.length === 0) return;
      setSelectedIndex((current) =>
        current < 0 ? 0 : (current + 1) % results.length,
      );
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length === 0) return;
      setSelectedIndex((current) =>
        current <= 0 ? results.length - 1 : current - 1,
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      handleSelect(selectedIndex >= 0 ? results[selectedIndex] : undefined);
    }
  }

  const showLoading = isLoading && !entry;
  const showEmpty = !showLoading && results.length === 0 && !error;

  const scopedDetectedEntries = detectedEntries.filter(
    (e) => !originChatId || e.detectedInChatId === originChatId,
  );
  const activeDetected = scopedDetectedEntries.filter(
    (e) => e.status === 'detected' || e.status === 'imported',
  );
  const dismissedEntries = scopedDetectedEntries.filter(
    (e) => e.status === 'dismissed',
  );
  useCurrentUiStateReporter('plans.importModal', {
    open: true,
    projectId,
    worktreeId,
    activeTab,
    importing,
    detectedEntryCount: scopedDetectedEntries.length,
    activeDetectedEntryCount: activeDetected.length,
    dismissedEntryCount: dismissedEntries.length,
    ...(originChatId ? { originChatId } : {}),
  });

  return (
    <div
      className="fixed inset-0 z-modal flex items-start justify-center bg-overlay-scrim px-4 pt-[10vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import plan"
        data-testid="import-plan-modal"
        className="flex w-full max-w-160 flex-col overflow-hidden rounded-2xl bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
          <h2 className="text-s font-semibold fg-primary">Import plan</h2>
          <button
            type="button"
            data-testid="import-plan-browse"
            disabled={importing}
            onClick={() => void runImport(undefined)}
            className="focus-ring shrink-0 rounded-md border bg-secondary px-3 py-1.5 text-xs fg-primary transition hover:bg-accent-subtle hover:fg-accent disabled:opacity-50"
          >
            Browse…
          </button>
        </div>

        <div className="flex gap-1 border-b px-4 py-2">
          <button
            type="button"
            data-testid="import-plan-tab-search"
            onClick={() => setActiveTab('search')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              activeTab === 'search'
                ? 'bg-accent-subtle fg-accent'
                : 'fg-secondary hover:bg-fg-primary/[0.06] hover:fg-primary'
            }`}
          >
            Search
          </button>
          <button
            type="button"
            data-testid="import-plan-tab-detected"
            onClick={() => setActiveTab('detected')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              activeTab === 'detected'
                ? 'bg-accent-subtle fg-accent'
                : 'fg-secondary hover:bg-fg-primary/[0.06] hover:fg-primary'
            }`}
          >
            Detected
          </button>
        </div>

        {activeTab === 'search' && (
          <>
            <div
              className="border-b bg-fg-primary/[0.03] px-4 py-2 text-xs fg-secondary"
              data-testid="import-plan-hint"
            >
              You can tell your agent{' '}
              <span className="font-mono fg-primary/80">
                {'"Import @<file> as a plan"'}
              </span>{' '}
              to import directly from chat
            </div>

            <div className="border-b px-4 py-3">
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelectedIndex(0);
                }}
                placeholder="Search files (.md or .txt)…"
                data-testid="import-plan-input"
                className="w-full bg-transparent text-m fg-primary outline-none placeholder:fg-secondary"
              />
            </div>

            <div className="max-h-88 overflow-y-auto">
              {showLoading && (
                <div className="flex items-center justify-center px-4 py-8">
                  <LoadingSpinner tone="secondary" />
                </div>
              )}
              {error && (
                <div className="px-4 py-8 text-center text-s fg-destructive">
                  {error}
                </div>
              )}
              {showEmpty && (
                <div className="px-4 py-8 text-center text-s fg-secondary">
                  {deferredQuery
                    ? 'No matching files'
                    : 'No importable files in this worktree'}
                </div>
              )}
              {!showLoading && !error && results.length > 0 && (
                <ul role="listbox" aria-label="Files" className="py-2">
                  {results.map((result, index) => {
                    const isSelected = index === selectedIndex;
                    const filenameSegments = splitMatchSegments(
                      result.filename,
                      getFilenameMatchedIndices(result),
                    );
                    const pathSegments = splitMatchSegments(
                      result.relativePath,
                      result.matchedIndices,
                    );
                    return (
                      <li
                        key={`${result.repoId}:${result.absolutePath}`}
                        ref={(node): void => {
                          if (node) {
                            itemRefs.current.set(index, node);
                          } else {
                            itemRefs.current.delete(index);
                          }
                        }}
                      >
                        <button
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          data-testid="import-plan-result"
                          disabled={importing}
                          onMouseEnter={() => setSelectedIndex(index)}
                          onClick={() => handleSelect(result)}
                          className={`flex w-full items-center justify-between gap-4 px-4 py-2 text-left transition-colors disabled:opacity-50 ${
                            isSelected
                              ? 'bg-accent-subtle fg-accent'
                              : 'fg-primary hover:bg-secondary'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-s font-medium">
                              <HighlightedSegments
                                segments={filenameSegments}
                              />
                            </div>
                            <div className="mt-0.5 truncate text-xs fg-secondary">
                              <HighlightedSegments segments={pathSegments} />
                            </div>
                          </div>
                          <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-2xs fg-secondary">
                            {result.repoName}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-between border-t px-4 py-3 text-xs fg-secondary">
              <span>Enter to import</span>
              <span>Esc to close</span>
              <span>↑↓ to navigate</span>
            </div>
          </>
        )}

        {activeTab === 'detected' && (
          <div className="max-h-104 overflow-y-auto">
            {scopedDetectedEntries.length === 0 && (
              <div className="px-4 py-8 text-center text-s fg-secondary">
                No plan files detected in recent chat messages
              </div>
            )}
            {activeDetected.length > 0 && (
              <ul className="divide-y py-1">
                {activeDetected.map((e) => (
                  <DetectedEntryRow
                    key={e.id}
                    entry={e}
                    importing={importing}
                    onImport={(): void => {
                      void runImportDetectedEntry(e);
                    }}
                    onDismiss={
                      e.status === 'detected'
                        ? (): void => {
                            void runDismissDetectedEntry(e);
                          }
                        : undefined
                    }
                  />
                ))}
              </ul>
            )}
            {dismissedEntries.length > 0 && (
              <details
                data-testid="import-plan-dismissed-section"
                className="group border-t"
              >
                <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-xs fg-secondary hover:fg-primary">
                  <AppCatalogChevronRightMediumIcon
                    width="12"
                    height="12"
                    className="shrink-0 transition group-open:rotate-90"
                  />
                  {dismissedEntries.length} dismissed
                </summary>
                <ul className="divide-y">
                  {dismissedEntries.map((e) => (
                    <DetectedEntryRow
                      key={e.id}
                      entry={e}
                      importing={importing}
                      onImport={(): void => {
                        void runImportDetectedEntry(e);
                      }}
                      onDismiss={undefined}
                    />
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ImportPlanModalHost(): JSX.Element {
  const importModalRequest = useActivityStore(
    (state) => state.importModalRequest,
  );
  const closeImportModal = useActivityStore((state) => state.closeImportModal);

  if (!importModalRequest) {
    return <></>;
  }
  const { originChatId } = importModalRequest;

  return createPortal(
    <ImportPlanModal
      projectId={importModalRequest.projectId}
      worktreeId={importModalRequest.worktreeId}
      initialTab={importModalRequest.initialTab}
      originChatId={originChatId}
      onClose={closeImportModal}
      onImported={(plan): void => {
        // Import runs from the plan's worktree (its plan list or a chat's
        // detection banner), so the new plan opens there, beside the chat
        // that asked for it when there is one.
        void openTrackedPlan(
          {
            projectId: plan.projectId,
            worktreeId: plan.worktreeId,
            planId: plan.id,
          },
          originChatId
            ? { navigate: false, origin: { chatTabId: originChatId } }
            : { navigate: false },
        );
        closeImportModal();
      }}
    />,
    document.body,
  );
}

interface DetectedEntryRowProps {
  entry: DetectedPlanEntry;
  importing: boolean;
  onImport: () => void;
  onDismiss: (() => void) | undefined;
}

function DetectedEntryRow({
  entry,
  importing,
  onImport,
  onDismiss,
}: DetectedEntryRowProps): JSX.Element {
  const filename = getBaseName(entry.sourceFilePath);
  const isImported = entry.status === 'imported';

  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-s font-medium fg-primary">{filename}</div>
        <div className="mt-0.5 truncate text-xs fg-secondary">
          {entry.sourceFilePath}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isImported ? (
          <span className="rounded-full bg-success-subtle px-2 py-0.5 text-2xs font-medium fg-success">
            Imported
          </span>
        ) : null}
        <button
          type="button"
          data-testid={`import-plan-detected-import-${entry.id}`}
          disabled={importing || isImported}
          onClick={onImport}
          className="focus-ring rounded-md border bg-secondary px-2.5 py-1 text-xs fg-primary transition hover:bg-accent-subtle hover:fg-accent disabled:opacity-50"
        >
          Import
        </button>
        {onDismiss !== undefined ? (
          <button
            type="button"
            data-testid={`import-plan-detected-dismiss-${entry.id}`}
            disabled={importing}
            onClick={onDismiss}
            className="focus-ring rounded-md px-2.5 py-1 text-xs fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary disabled:opacity-50"
          >
            Dismiss
          </button>
        ) : null}
      </div>
    </li>
  );
}

interface HighlightedSegmentsProps {
  segments: MatchSegment[];
}

function HighlightedSegments({
  segments,
}: HighlightedSegmentsProps): JSX.Element {
  return (
    <>
      {segments.map((segment, index) =>
        segment.highlighted ? (
          <mark key={index} className="bg-transparent font-semibold fg-accent">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

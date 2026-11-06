/**
 * Read-only Changes explorer for an archived worktree container.
 *
 * Two-pane surface: the shared code-review changed-file tree
 * ({@link DiffFileTree}, the same folder/file display the Code Review modal
 * uses) on the left and a lazy per-file diff on the right, rendered through
 * the shared `DiffContentView`. All data arrives through the typed
 * archived-container transport (`listChanges` / `readChangeDiff`) — this
 * component never sees Git paths, refs, or object ids, never parses cursors,
 * and treats list ordering and file membership as backend-authoritative.
 * Rename/copy old-side resolution is backend-owned: `previousPath` is
 * display-only and is never sent back.
 *
 * The tree renders every loaded row (it is not virtualized), so paging is
 * bounded rather than scroll-driven: pages load automatically up to
 * {@link AUTO_PAGE_FILE_LIMIT} rows and anything beyond that waits for an
 * explicit "Load more" — a very large archive must not silently build a
 * six-figure DOM tree.
 *
 * The archive is immutable, so the explorer is strictly read-only — no
 * editing, reverting, commenting, reveal-in-Finder, live file tabs, or
 * network actions. The per-file diff cache lives only for this mounted view
 * and is dropped when the archive identity changes or the view unmounts.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type {
  ArchivedContainerReadChangeDiffResponse,
  ArchivedGitChangesSummary,
  ChangedFileInfo,
} from '@canopy/desktop-shared/types';
import {
  Button,
  DiffViewModeToggle,
  Notice,
} from '@canopy/ui-shared/components';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { DiffBadge } from '@/components/worktree/DiffBadge';
import { DiffFileTree } from '@/components/activity/DiffFileTree';
import { DiffContentView } from '@/components/activity/DiffContentView';
import {
  clampCodeReviewFileTreeWidth,
  loadCodeReviewFileTreeWidth,
  saveCodeReviewFileTreeWidth,
} from '@/components/code-review/codeReviewLayout';
import { LoadingSpinner } from '@/components/shared/loading/spinners/LoadingSpinner';

/**
 * Rows the explorer pages in on its own. Past this, the next page needs an
 * explicit click so the non-virtualized tree stays a bounded render.
 */
const AUTO_PAGE_FILE_LIMIT = 2_000;

/**
 * An archived capture is one combined diff, with no committed/uncommitted
 * split, so every file goes through the tree's `uncommitted` slot and the
 * `committed` slot is permanently empty. Module-level so the array identity
 * stays stable across renders.
 */
const EMPTY_COMMITTED_FILES: ChangedFileInfo[] = [];

type DiffEntry =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'success'; response: ArchivedContainerReadChangeDiffResponse };

function diffKey(repoId: string, path: string): string {
  return `${repoId}\0${path}`;
}

/** Full status/path/rename/count description for titles & accessible labels
 * so row truncation never removes meaning. */
function fileRowTitle(file: ChangedFileInfo): string {
  const pathText =
    file.previousPath !== undefined
      ? `${file.previousPath} → ${file.path}`
      : file.path;
  return `${file.status}: ${pathText} (+${file.insertions} −${file.deletions})`;
}

function changedFilesText(count: number): string {
  return `${count.toLocaleString('en-US')} changed file${count === 1 ? '' : 's'}`;
}

export interface ArchivedChangesViewProps {
  workspaceId: string;
  containerId: string;
  /** Immutable aggregate captured with the archive (version-2 manifests). */
  gitChanges?: ArchivedGitChangesSummary;
}

export function ArchivedChangesView({
  workspaceId,
  containerId,
  gitChanges,
}: ArchivedChangesViewProps): JSX.Element {
  const changes = useArchivedContainersStore((s) =>
    s.changesList !== null &&
    s.changesList.workspaceId === workspaceId &&
    s.changesList.containerId === containerId
      ? s.changesList
      : null,
  );
  const openChanges = useArchivedContainersStore((s) => s.openChanges);
  const loadMoreChanges = useArchivedContainersStore((s) => s.loadMoreChanges);
  const retryChanges = useArchivedContainersStore((s) => s.retryChanges);
  const resetChanges = useArchivedContainersStore((s) => s.resetChanges);
  const readChangeDiff = useArchivedContainersStore((s) => s.readChangeDiff);

  const [viewMode, setViewMode] = useState<'unified' | 'split'>('unified');
  const [selected, setSelected] = useState<{
    repoId: string;
    path: string;
  } | null>(null);
  const userSelectedRef = useRef(false);

  // File-tree chrome mirrors the Code Review panel, including its persisted
  // width, so the two surfaces feel like the same list.
  const [fileTreeWidth, setFileTreeWidth] = useState<number>(() =>
    loadCodeReviewFileTreeWidth(),
  );
  const handleFileTreeWidthCommit = useCallback((widthPx: number): void => {
    setFileTreeWidth(widthPx);
    saveCodeReviewFileTreeWidth(widthPx);
  }, []);
  const [fileTreeCollapsed, setFileTreeCollapsed] = useState(false);
  const handleToggleFileTree = useCallback((): void => {
    setFileTreeCollapsed((prev) => !prev);
  }, []);

  // Mounted-view diff cache. The Map identity doubles as the stale-response
  // guard: switching archives replaces the Map, so late completions for the
  // previous archive can never write into (or blank) the new view's cache.
  const diffCacheRef = useRef<Map<string, DiffEntry>>(new Map());
  const [, setDiffVersion] = useState(0);

  // Start the paged list for this archive identity; reset list, selection,
  // and the mounted-view diff cache when the identity changes or the view
  // unmounts.
  useEffect(() => {
    userSelectedRef.current = false;
    setSelected(null);
    diffCacheRef.current = new Map();
    setDiffVersion((version) => version + 1);
    openChanges(workspaceId, containerId);
    return (): void => {
      resetChanges();
    };
  }, [workspaceId, containerId, openChanges, resetChanges]);

  const files = changes?.files;
  // Single-repo archives drop the backend's repository display name so the
  // tree is rooted at the repository's own paths — matching the single-repo
  // code-review tree, which never receives a `repoName` at all. Multi-repo
  // archives keep it, which is what groups each repository under its own
  // top-level folder.
  const treeFiles = useMemo<ChangedFileInfo[]>(() => {
    const list = files ?? [];
    const multiRepo =
      new Set(list.map((file) => file.repoId ?? '')).size > 1 ||
      (gitChanges?.status === 'complete' && gitChanges.repositories.length > 1);
    if (multiRepo) {
      return list;
    }
    return list.map((file) => ({
      path: file.path,
      status: file.status,
      insertions: file.insertions,
      deletions: file.deletions,
      ...(file.previousPath !== undefined
        ? { previousPath: file.previousPath }
        : {}),
      ...(file.repoId !== undefined ? { repoId: file.repoId } : {}),
    }));
  }, [files, gitChanges]);

  // Auto-select the first changed file of the first page unless the user has
  // already picked one. Later page appends keep the selection stable.
  useEffect(() => {
    if (userSelectedRef.current || selected !== null) {
      return;
    }
    const first = changes?.status === 'success' ? treeFiles[0] : undefined;
    if (first !== undefined) {
      setSelected({ repoId: first.repoId ?? '', path: first.path });
    }
  }, [changes?.status, treeFiles, selected]);

  // Selections always originate from loaded pages, so a selected record that
  // is no longer present means the archive view itself changed (e.g. the
  // list restarted) — clear it rather than showing a diff for a ghost row.
  useEffect(() => {
    if (selected === null || changes?.status !== 'success') {
      return;
    }
    const stillPresent = treeFiles.some(
      (file) =>
        (file.repoId ?? '') === selected.repoId && file.path === selected.path,
    );
    if (!stillPresent) {
      setSelected(null);
    }
  }, [changes?.status, treeFiles, selected]);

  const fetchDiff = useCallback(
    (repoId: string, path: string): void => {
      const cache = diffCacheRef.current;
      const key = diffKey(repoId, path);
      const existing = cache.get(key);
      if (existing !== undefined && existing.status !== 'error') {
        return;
      }
      cache.set(key, { status: 'loading' });
      setDiffVersion((version) => version + 1);
      void readChangeDiff(workspaceId, containerId, repoId, path)
        .then((response) => {
          if (diffCacheRef.current !== cache) return; // archive switched
          cache.set(key, { status: 'success', response });
          setDiffVersion((version) => version + 1);
        })
        .catch(() => {
          if (diffCacheRef.current !== cache) return;
          cache.set(key, { status: 'error' });
          setDiffVersion((version) => version + 1);
        });
    },
    [workspaceId, containerId, readChangeDiff],
  );

  // Lazily issue exactly one request when a selection has no cached state.
  // Cached success/error/loading entries render as-is (retry is explicit),
  // so rapid switching back to a loaded file makes no second call.
  useEffect(() => {
    if (selected === null) {
      return;
    }
    if (!diffCacheRef.current.has(diffKey(selected.repoId, selected.path))) {
      fetchDiff(selected.repoId, selected.path);
    }
  }, [selected, fetchDiff]);

  const retryDiff = useCallback((): void => {
    if (selected === null) {
      return;
    }
    diffCacheRef.current.delete(diffKey(selected.repoId, selected.path));
    fetchDiff(selected.repoId, selected.path);
  }, [selected, fetchDiff]);

  const morePagesAvailable =
    changes?.status === 'success' &&
    changes.nextCursor !== null &&
    !changes.loadingMore &&
    !changes.loadMoreError;

  // Page in the rest of the list without waiting on scroll position: the tree
  // needs whole folders to be meaningful. The store's in-flight guard means
  // this effect can only ever have one page outstanding.
  //
  // `autoPagedAtRef` is the loaded count that triggered the previous automatic
  // page. If a page comes back without growing the list while still reporting
  // a cursor, auto-paging stops instead of spinning on the same cursor
  // forever; the explicit Load more control remains available.
  const autoPagedAtRef = useRef<number | null>(null);
  useEffect(() => {
    autoPagedAtRef.current = null;
  }, [workspaceId, containerId]);
  const loadedFileCount = changes?.files.length ?? 0;
  useEffect(() => {
    if (!morePagesAvailable || loadedFileCount >= AUTO_PAGE_FILE_LIMIT) {
      return;
    }
    if (autoPagedAtRef.current === loadedFileCount) {
      return;
    }
    autoPagedAtRef.current = loadedFileCount;
    loadMoreChanges();
  }, [morePagesAvailable, loadedFileCount, loadMoreChanges]);

  const selectedFile = useMemo(
    () =>
      selected !== null
        ? (treeFiles.find(
            (file) =>
              (file.repoId ?? '') === selected.repoId &&
              file.path === selected.path,
          ) ?? null)
        : null,
    [treeFiles, selected],
  );
  const handleSelectFile = useCallback((file: ChangedFileInfo): void => {
    userSelectedRef.current = true;
    setSelected({ repoId: file.repoId ?? '', path: file.path });
  }, []);
  const selectedDiff =
    selected !== null
      ? diffCacheRef.current.get(diffKey(selected.repoId, selected.path))
      : undefined;

  const knownTotal = changes?.status === 'success' ? changes.totalCount : null;
  const summaryCount =
    knownTotal ??
    (gitChanges?.status === 'complete' ? gitChanges.fileCount : null);
  const manualPagingRequired =
    morePagesAvailable && loadedFileCount >= AUTO_PAGE_FILE_LIMIT;

  return (
    <div
      data-testid="archived-changes-view"
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* Summary bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        {summaryCount !== null && (
          <span
            data-testid="archived-changes-summary-count"
            className="text-xs font-medium fg-primary"
          >
            {changedFilesText(summaryCount)}
          </span>
        )}
        {gitChanges?.status === 'complete' ? (
          <DiffBadge
            stats={{
              insertions: gitChanges.insertions,
              deletions: gitChanges.deletions,
            }}
          />
        ) : (
          <span
            data-testid="archived-changes-totals-unavailable"
            className="text-xs fg-secondary"
          >
            Change totals unavailable
          </span>
        )}
        <div className="ml-auto shrink-0">
          <DiffViewModeToggle
            value={viewMode}
            onChange={setViewMode}
            dataTestId="archived-changes-view-mode"
          />
        </div>
      </div>

      {changes !== null && changes.status === 'success' && (
        <>
          {changes.truncated && (
            <Notice
              intent="attention"
              role="none"
              title="List truncated"
              data-testid="archived-changes-truncation"
              className="mx-4 my-2 shrink-0"
            >
              Showing the first 50,000 of{' '}
              {changes.totalCount.toLocaleString('en-US')} changed files.
            </Notice>
          )}
          {changes.loadMoreError ? (
            <div
              data-testid="archived-changes-page-error"
              className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-2xs fg-secondary"
            >
              Changed files couldn’t be loaded for this archive.
              <Button
                size="compact"
                data-testid="archived-changes-page-retry"
                onClick={retryChanges}
              >
                Try again
              </Button>
            </div>
          ) : manualPagingRequired ? (
            <div
              data-testid="archived-changes-load-more"
              className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-2xs fg-secondary"
            >
              Showing {loadedFileCount.toLocaleString('en-US')} of{' '}
              {(knownTotal ?? loadedFileCount).toLocaleString('en-US')} changed
              files.
              <Button
                size="compact"
                data-testid="archived-changes-load-more-button"
                onClick={loadMoreChanges}
              >
                Load more
              </Button>
            </div>
          ) : (
            changes.loadingMore && (
              <div
                data-testid="archived-changes-page-loading"
                className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-2xs fg-secondary"
              >
                <LoadingSpinner tone="secondary" />
                Loading more files…
              </div>
            )
          )}
        </>
      )}

      {changes === null || changes.status === 'loading' ? (
        <div
          data-testid="archived-changes-loading"
          className="flex min-h-30 flex-1 items-center justify-center gap-3 text-s fg-secondary"
        >
          <LoadingSpinner tone="secondary" />
          Loading changed files…
        </div>
      ) : changes.status === 'error' ? (
        <div
          data-testid="archived-changes-list-error"
          className="flex min-h-30 flex-1 flex-col items-center justify-center gap-2 text-s fg-secondary"
        >
          Changed files couldn’t be loaded for this archive.
          <Button
            size="compact"
            data-testid="archived-changes-list-retry"
            onClick={retryChanges}
          >
            Try again
          </Button>
        </div>
      ) : changes.files.length === 0 ? (
        <div
          data-testid="archived-changes-empty"
          className="flex min-h-30 flex-1 items-center justify-center text-s fg-secondary"
        >
          No changed files were captured with this archive.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Left file pane — the shared code-review folder/file tree. */}
          <DiffFileTree
            uncommitted={treeFiles}
            committed={EMPTY_COMMITTED_FILES}
            selectedFile={selectedFile}
            selectedSource="uncommitted"
            onSelectFile={handleSelectFile}
            collapsed={fileTreeCollapsed}
            onToggleCollapsed={handleToggleFileTree}
            width={fileTreeWidth}
            clampWidth={clampCodeReviewFileTreeWidth}
            onWidthCommit={handleFileTreeWidthCommit}
          />

          {/* Right diff pane */}
          <div
            data-testid="archived-changes-diff-pane"
            className="flex min-h-0 flex-1 flex-col"
          >
            {selected === null ? (
              <div className="flex flex-1 items-center justify-center text-s fg-secondary">
                Select a file to view its archived diff.
              </div>
            ) : selectedDiff === undefined ||
              selectedDiff.status === 'loading' ? (
              <DiffContentView
                oldValue=""
                newValue=""
                viewMode={viewMode}
                loading
                truncated={false}
                binary={false}
              />
            ) : selectedDiff.status === 'error' ? (
              <div
                data-testid="archived-changes-diff-error"
                className="flex flex-1 flex-col items-center justify-center gap-2 text-s fg-secondary"
              >
                This archived diff couldn’t be loaded.
                <Button
                  size="compact"
                  data-testid="archived-changes-diff-retry"
                  onClick={retryDiff}
                >
                  Try again
                </Button>
              </div>
            ) : (
              <>
                {selectedFile !== null && (
                  <div className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5">
                    <span
                      className="min-w-0 truncate text-xs font-medium fg-primary/85"
                      title={fileRowTitle(selectedFile)}
                    >
                      {selectedFile.previousPath !== undefined
                        ? `${selectedFile.previousPath} → ${selectedFile.path}`
                        : selectedFile.path}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-2xs">
                      <span className="fg-success">
                        +{selectedFile.insertions}
                      </span>
                      <span className="fg-destructive">
                        −{selectedFile.deletions}
                      </span>
                    </span>
                  </div>
                )}
                <DiffContentView
                  oldValue={selectedDiff.response.oldValue}
                  newValue={selectedDiff.response.newValue}
                  viewMode={viewMode}
                  loading={false}
                  truncated={selectedDiff.response.truncated}
                  binary={selectedDiff.response.binary}
                  imagePreview={selectedDiff.response.imagePreview}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

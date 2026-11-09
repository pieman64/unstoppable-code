import {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  ChangedFileInfo,
  ChangedFileStatus,
  FileDiffSource,
} from '@canopy/desktop-shared/types';
import { Surface, DiffLineCounts } from '@canopy/ui-shared/components';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon as CentralFolderIcon,
  InfoIcon,
  MessageIcon,
} from '@canopy/ui-shared/icons';
import {
  ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon,
  ChevronLeftMediumIcon as AppCatalogChevronLeftMediumIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { normalizeRepoKey } from '@/components/code-review/codeReviewLayout';
import { ResizeHandle } from '@/components/shared/ResizeHandle';
import { RichHoverTooltip } from '@/components/shared/RichHoverTooltip';
import { Button } from '@canopy/ui-shared/components';

const STATUS_DOT_COLORS: Record<ChangedFileStatus, string> = {
  added: 'bg-fg-success-strong',
  modified: 'bg-warning',
  deleted: 'bg-fg-destructive-strong',
  // Copied shares the renamed identity: a file that came from another path.
  renamed: 'bg-fg-info',
  copied: 'bg-fg-info',
  unmerged: 'bg-destructive',
  'type-changed': 'bg-fg-special-strong',
  untracked: 'bg-fg-success-strong',
  unknown: 'bg-fg-primary/40',
};

type FileContextMenu = (
  file: ChangedFileInfo,
  source: FileDiffSource,
  point: { clientX: number; clientY: number },
) => void;

interface FileEntry {
  file: ChangedFileInfo;
  source: FileDiffSource;
}

/** Per-file annotation/open-comment counts for the review file-tree badges. */
export interface FileBadgeCounts {
  annotations: number;
  comments: number;
}

function fileBadgeKey(file: ChangedFileInfo): string {
  return `${normalizeRepoKey(file.repoId)}:${file.path}`;
}

/**
 * Row test id, disambiguated by group only where it has to be.
 *
 * A path can appear in both groups — a file committed on the branch and then
 * modified again in the working tree — and the shared-container Changes view is
 * the first consumer that routinely renders both. Keying on `repoId:path` alone
 * produced two DOM nodes with the same id, which is a Playwright strict-mode
 * failure (CAN-2551). The React key and the selection check already include the
 * source.
 *
 * Only the committed row takes the suffix. Every existing selector across the
 * archived viewer, code review, and the file viewer addresses an uncommitted
 * row, so leaving that shape alone fixes the collision without a rename sweep
 * through specs this change has nothing to do with.
 */
function fileRowTestId(file: ChangedFileInfo, source: FileDiffSource): string {
  const key = fileBadgeKey(file);
  return source === 'committed' ? `${key}:committed` : key;
}

/**
 * Full status/path/rename/count description, so a row truncated by the tree's
 * folder indentation still exposes its whole meaning on hover and to assistive
 * technology.
 */
/**
 * Whether this row's `+/−` chip carries information.
 *
 * Two independent rules, both opt-in per group so no existing caller changes
 * (CAN-2551):
 *
 * - `sourcesWithoutDiffCounts` — the caller has no counts at all for that
 *   group, so no row in it shows a chip.
 * - `sourcesWithUnknownZeroCounts` — the caller's counts for that group can be
 *   *absent* rather than zero, which arrives here as `0`/`0`. A shared
 *   container's publisher omits counts it cannot vouch for (binary numstat,
 *   rename/copy rows published as plain adds), and "+0 −0" would assert the
 *   file is unchanged when it plainly is not. Callers whose `0`/`0` is a real
 *   measurement — a mode-only change, an added empty file — leave this unset
 *   and keep the counts in the row title.
 *
 * Even when counts show, a zero count renders no chip.
 */
function showsDiffCounts(
  file: ChangedFileInfo,
  sourcesWithoutDiffCounts: readonly FileDiffSource[] | undefined,
  sourcesWithUnknownZeroCounts: readonly FileDiffSource[] | undefined,
  source: FileDiffSource,
): boolean {
  if (sourcesWithoutDiffCounts?.includes(source) === true) return false;
  if (
    sourcesWithUnknownZeroCounts?.includes(source) === true &&
    file.insertions === 0 &&
    file.deletions === 0
  ) {
    return false;
  }
  return true;
}

function fileRowTitle(file: ChangedFileInfo, showDiffCounts: boolean): string {
  const pathText =
    file.previousPath !== undefined
      ? `${file.previousPath} → ${file.path}`
      : file.path;
  if (!showDiffCounts) return `${file.status}: ${pathText}`;
  return `${file.status}: ${pathText} (+${file.insertions} −${file.deletions})`;
}

interface TreeNode {
  name: string;
  fullPath: string;
  children: TreeNode[];
  entries: FileEntry[];
  fileCount: number;
}

function buildTree(
  uncommitted: ChangedFileInfo[],
  committed: ChangedFileInfo[],
): TreeNode {
  const root: TreeNode = {
    name: '',
    fullPath: '',
    children: [],
    entries: [],
    fileCount: 0,
  };

  const addFile = (file: ChangedFileInfo, source: FileDiffSource): void => {
    const prefix = file.repoName ? `${file.repoName}/` : '';
    const fullPath = `${prefix}${file.path}`;
    const segments = fullPath.split(/[\\/]/);
    const fileName = segments.pop();
    if (!fileName) return;

    let current = root;
    let pathSoFar = '';
    for (const segment of segments) {
      pathSoFar = pathSoFar ? `${pathSoFar}/${segment}` : segment;
      let child = current.children.find((c) => c.name === segment);
      if (!child) {
        child = {
          name: segment,
          fullPath: pathSoFar,
          children: [],
          entries: [],
          fileCount: 0,
        };
        current.children.push(child);
      }
      current = child;
    }

    current.entries.push({ file, source });
  };

  for (const file of uncommitted) {
    addFile(file, 'uncommitted');
  }
  for (const file of committed) {
    addFile(file, 'committed');
  }

  // Sort children and entries alphabetically
  const sortNode = (node: TreeNode): void => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.entries.sort((a, b) => a.file.path.localeCompare(b.file.path));
    for (const child of node.children) {
      sortNode(child);
    }
  };
  sortNode(root);

  const computeFileCounts = (node: TreeNode): number => {
    let count = node.entries.length;
    for (const child of node.children) {
      count += computeFileCounts(child);
    }
    node.fileCount = count;
    return count;
  };
  computeFileCounts(root);

  return root;
}

interface FolderRowProps {
  node: TreeNode;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
}

function FolderRow({
  node,
  depth,
  expanded,
  onToggle,
}: FolderRowProps): JSX.Element {
  const fileCount = node.fileCount;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex w-max min-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs fg-secondary transition-colors hover:bg-fg-primary/[0.04]"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      {expanded ? (
        <ChevronDownIcon size="sm" />
      ) : (
        <ChevronRightIcon size="sm" />
      )}
      <CentralFolderIcon size="sm" className="shrink-0 fg-secondary" />
      <span className="whitespace-nowrap">{node.name}</span>
      {!expanded && (
        <span className="ml-auto shrink-0 pl-2 text-3xs fg-secondary">
          {fileCount}
        </span>
      )}
    </button>
  );
}

interface FileNodeRowProps {
  entry: FileEntry;
  depth: number;
  isSelected: boolean;
  onSelect: (file: ChangedFileInfo, source: FileDiffSource) => void;
  onFileContextMenu?: FileContextMenu;
  badge?: FileBadgeCounts;
  /** False when this row's group has no real counts to show. */
  showDiffCounts: boolean;
  showFullPath?: boolean;
}

function FileNodeRow({
  entry,
  depth,
  isSelected,
  onSelect,
  onFileContextMenu,
  showDiffCounts,
  showFullPath = false,
  badge,
}: FileNodeRowProps): JSX.Element {
  const fileName = showFullPath
    ? `${entry.file.repoName ? `${entry.file.repoName}/` : ''}${entry.file.path}`
    : (entry.file.path.split(/[\\/]/).pop() ?? entry.file.path);
  const dotClass = STATUS_DOT_COLORS[entry.file.status];

  return (
    <RichHoverTooltip
      content={fileRowTitle(entry.file, showDiffCounts)}
      triggerWrapperClassName={
        showFullPath ? 'w-full min-w-0' : 'w-max min-w-full'
      }
      surfaceClassName="w-max max-w-96"
      surfacePadding="compact"
    >
      <button
        type="button"
        // Stable automation hook for every surface that mounts this tree (code
        // review, archived changes). Keyed exactly like `fileBadges`.
        data-testid={`diff-file-tree-row-${fileRowTestId(entry.file, entry.source)}`}
        data-selected={isSelected ? 'true' : 'false'}
        aria-label={fileRowTitle(entry.file, showDiffCounts)}
        onClick={() => onSelect(entry.file, entry.source)}
        onContextMenu={(event) => {
          if (onFileContextMenu) {
            event.preventDefault();
            onFileContextMenu(entry.file, entry.source, event);
          }
        }}
        className={`flex ${showFullPath ? 'w-full min-w-0' : 'w-max min-w-full'} items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
          isSelected
            ? 'bg-accent/[0.08] fg-primary'
            : 'fg-primary/80 hover:bg-fg-primary/[0.06]'
        }`}
        style={{
          paddingLeft: `${depth * 16 + 8}px`,
        }}
      >
        <span className={`h-1.75 w-1.75 shrink-0 rounded-full ${dotClass}`} />
        <span
          className={
            showFullPath ? 'min-w-0 truncate text-left' : 'whitespace-nowrap'
          }
        >
          {fileName}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          {badge && badge.annotations > 0 && (
            <span
              data-testid="review-file-annotation-badge"
              title={`${badge.annotations} annotation${badge.annotations === 1 ? '' : 's'}`}
              className="flex items-center gap-0.5 text-3xs fg-info"
            >
              <InfoIcon size="sm" />
              {badge.annotations}
            </span>
          )}
          {badge && badge.comments > 0 && (
            <span
              data-testid="review-file-comment-badge"
              title={`${badge.comments} open comment${badge.comments === 1 ? '' : 's'}`}
              className="flex items-center gap-0.5 text-3xs fg-accent"
            >
              <MessageIcon size="sm" />
              {badge.comments}
            </span>
          )}
          {showDiffCounts && (
            <DiffLineCounts
              insertions={entry.file.insertions}
              deletions={entry.file.deletions}
              size="compact"
              tone="strong"
            />
          )}
        </span>
      </button>
    </RichHoverTooltip>
  );
}

interface TreeRendererProps {
  node: TreeNode;
  depth: number;
  selectedFile: ChangedFileInfo | null;
  selectedSource: FileDiffSource | null;
  onSelectFile: (file: ChangedFileInfo, source: FileDiffSource) => void;
  onFileContextMenu?: FileContextMenu;
  expandedPaths: Set<string>;
  onTogglePath: (path: string) => void;
  fileBadges?: Map<string, FileBadgeCounts>;
  sourcesWithoutDiffCounts?: readonly FileDiffSource[];
  sourcesWithUnknownZeroCounts?: readonly FileDiffSource[];
}

function TreeRenderer({
  node,
  depth,
  selectedFile,
  selectedSource,
  onSelectFile,
  onFileContextMenu,
  expandedPaths,
  onTogglePath,
  fileBadges,
  sourcesWithoutDiffCounts,
  sourcesWithUnknownZeroCounts,
}: TreeRendererProps): JSX.Element {
  return (
    <>
      {node.children.map((child) => {
        const isExpanded = expandedPaths.has(child.fullPath);
        return (
          <div key={`folder-${child.fullPath}`}>
            <FolderRow
              node={child}
              depth={depth}
              expanded={isExpanded}
              onToggle={() => onTogglePath(child.fullPath)}
            />
            {isExpanded && (
              <TreeRenderer
                node={child}
                depth={depth + 1}
                selectedFile={selectedFile}
                selectedSource={selectedSource}
                onSelectFile={onSelectFile}
                onFileContextMenu={onFileContextMenu}
                expandedPaths={expandedPaths}
                onTogglePath={onTogglePath}
                fileBadges={fileBadges}
                sourcesWithoutDiffCounts={sourcesWithoutDiffCounts}
                sourcesWithUnknownZeroCounts={sourcesWithUnknownZeroCounts}
              />
            )}
          </div>
        );
      })}
      {node.entries.map((entry) => {
        const key = `${entry.file.repoId ?? 'r'}:${entry.file.path}:${entry.source}`;
        const isSelected =
          selectedFile !== null &&
          selectedSource !== null &&
          selectedFile.path === entry.file.path &&
          selectedFile.repoId === entry.file.repoId &&
          selectedSource === entry.source;
        return (
          <FileNodeRow
            key={key}
            entry={entry}
            depth={depth}
            isSelected={isSelected}
            onSelect={onSelectFile}
            onFileContextMenu={onFileContextMenu}
            badge={fileBadges?.get(fileBadgeKey(entry.file))}
            showDiffCounts={showsDiffCounts(
              entry.file,
              sourcesWithoutDiffCounts,
              sourcesWithUnknownZeroCounts,
              entry.source,
            )}
          />
        );
      })}
    </>
  );
}

function collectAllPaths(node: TreeNode): Set<string> {
  const paths = new Set<string>();
  for (const child of node.children) {
    paths.add(child.fullPath);
    const childPaths = Array.from(collectAllPaths(child));
    for (const p of childPaths) {
      paths.add(p);
    }
  }
  return paths;
}

interface DiffFileTreeProps {
  uncommitted: ChangedFileInfo[];
  committed: ChangedFileInfo[];
  selectedFile: ChangedFileInfo | null;
  selectedSource: FileDiffSource | null;
  onSelectFile: (file: ChangedFileInfo, source: FileDiffSource) => void;
  onFileContextMenu?: FileContextMenu;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Current expanded width of the tree, in pixels. */
  width: number;
  /** Clamp a raw dragged width to the caller's allowed range. */
  clampWidth: (value: number) => number;
  /** Fires once on drag mouseup with the final (already clamped) width. */
  onWidthCommit: (width: number) => void;
  /**
   * Optional per-file annotation/open-comment counts, keyed
   * `${normalizeRepoKey(file.repoId)}:${file.path}` (see
   * `@/components/code-review/codeReviewLayout`). Renders small count chips
   * in each file row when present; no behavior change when absent.
   */
  fileBadges?: Map<string, FileBadgeCounts>;
  /**
   * Unfiltered file count for the header when the passed lists are already
   * label-filtered. Defaults to the passed lists' length.
   */
  totalFileCount?: number;
  /**
   * Rows still shown under an active label filter. When it is below
   * `totalFileCount` the header reads `N Files (S)`.
   */
  visibleFileCount?: number;
  /** Filter control rendered to the right of the header counter. */
  headerAccessory?: ReactNode;
  resizable?: boolean;
  hideHeader?: boolean;
  listView?: boolean;
  collapseAllRequest?: number;
  expandAllRequest?: number;
  revealFileRequest?: number;
  /**
   * Groups whose `+/−` chips are hidden because the caller has no real counts
   * for them (CAN-2551).
   *
   * A shared container publishes its uncommitted overlay without numstat
   * counts, so those rows arrive as `0`/`0`. Rendering "+0 −0" claims the file
   * is unchanged, which is worse than saying nothing; committed rows in the
   * same tree do carry publisher-computed counts and keep their chips. Absent
   * means every group shows counts, so no existing caller changes.
   */
  sourcesWithoutDiffCounts?: readonly FileDiffSource[];
  /**
   * Groups whose `0`/`0` means "the publisher did not tell us" rather than
   * "nothing changed" (CAN-2551).
   *
   * A shared container's publisher omits counts it cannot vouch for — a binary
   * numstat, or a rename/copy published as a plain add — and those arrive here
   * as zeroes. Only rows in a listed group have their chip suppressed on that
   * basis, so callers whose `0`/`0` is a real measurement (a mode-only change,
   * an added empty file) keep theirs. Absent means no group opts in.
   */
  sourcesWithUnknownZeroCounts?: readonly FileDiffSource[];
}

export function DiffFileTree({
  uncommitted,
  committed,
  selectedFile,
  selectedSource,
  onSelectFile,
  onFileContextMenu,
  collapsed,
  onToggleCollapsed,
  width,
  clampWidth,
  onWidthCommit,
  fileBadges,
  totalFileCount,
  visibleFileCount,
  headerAccessory,
  resizable = true,
  hideHeader = false,
  listView = false,
  collapseAllRequest = 0,
  expandAllRequest = 0,
  revealFileRequest = 0,
  sourcesWithoutDiffCounts,
  sourcesWithUnknownZeroCounts,
}: DiffFileTreeProps): JSX.Element {
  const tree = useMemo(
    () => buildTree(uncommitted, committed),
    [uncommitted, committed],
  );
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() =>
    collectAllPaths(tree),
  );

  const knownPaths = useRef(collectAllPaths(tree));
  const lastExpandRequest = useRef(expandAllRequest);
  useEffect(() => {
    setExpandedPaths((prev) => {
      const allPaths = collectAllPaths(tree);
      const expandAll = lastExpandRequest.current !== expandAllRequest;
      lastExpandRequest.current = expandAllRequest;
      const merged = new Set(prev);
      for (const p of Array.from(allPaths)) {
        if (expandAll || !knownPaths.current.has(p)) merged.add(p);
      }
      knownPaths.current = allPaths;
      return merged;
    });
  }, [tree, expandAllRequest]);

  const handleTogglePath = useCallback((path: string): void => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // Horizontal resize. Mirrors the smoothing approach in `CommentsTray`:
  // dragging the right-edge handle writes the panel's `width` directly to the
  // DOM (rAF-batched) instead of re-rendering the whole tree on every move,
  // and `onWidthCommit` fires once on mouseup so the caller can persist it.
  const panelRef = useRef<HTMLDivElement>(null);
  const lastCollapseRequest = useRef(collapseAllRequest);
  useEffect(() => {
    if (lastCollapseRequest.current !== collapseAllRequest)
      setExpandedPaths(new Set());
    lastCollapseRequest.current = collapseAllRequest;
  }, [collapseAllRequest]);
  useEffect(() => {
    if (!revealFileRequest || !selectedFile) return;
    const segments =
      `${selectedFile.repoName ? `${selectedFile.repoName}/` : ''}${selectedFile.path}`.split(
        /[\\/]/,
      );
    segments.pop();
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      for (let length = 1; length <= segments.length; length++)
        next.add(segments.slice(0, length).join('/'));
      return next;
    });
    const frame = requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLElement>('[data-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    });
    return (): void => cancelAnimationFrame(frame);
  }, [revealFileRequest, selectedFile]);
  const pendingWidthRef = useRef(width);
  const isResizingRef = useRef(false);
  const resizeRafRef = useRef<number | null>(null);

  useEffect(() => {
    pendingWidthRef.current = width;
  }, [width]);

  useEffect(
    () => (): void => {
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
      }
    },
    [],
  );

  const applyWidth = useCallback((value: number): void => {
    const el = panelRef.current;
    if (el) {
      el.style.width = `${value}px`;
    }
  }, []);

  const scheduleWidthPaint = useCallback(
    (value: number): void => {
      pendingWidthRef.current = value;
      if (resizeRafRef.current !== null) {
        return;
      }
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = null;
        applyWidth(pendingWidthRef.current);
      });
    },
    [applyWidth],
  );

  const handleResizeDrag = useCallback(
    (clientX: number): void => {
      const el = panelRef.current;
      if (!el) {
        return;
      }
      const rect = el.getBoundingClientRect();
      isResizingRef.current = true;
      // The handle sits at the panel's right edge, so the width is the
      // distance from its left edge to the pointer.
      scheduleWidthPaint(clampWidth(clientX - rect.left));
    },
    [clampWidth, scheduleWidthPaint],
  );

  const handleResizeCommit = useCallback((): void => {
    const committedWidth = clampWidth(pendingWidthRef.current);
    pendingWidthRef.current = committedWidth;
    if (resizeRafRef.current !== null) {
      cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = null;
    }
    applyWidth(committedWidth);
    isResizingRef.current = false;
    onWidthCommit(committedWidth);
  }, [applyWidth, clampWidth, onWidthCommit]);

  const totalFiles = totalFileCount ?? uncommitted.length + committed.length;
  const visibleFiles =
    visibleFileCount ?? uncommitted.length + committed.length;

  if (collapsed) {
    return (
      <Surface variant="section" boundary="right" className="w-10 shrink-0">
        <div
          data-testid="diff-file-tree"
          className="flex shrink-0 flex-col items-center py-2"
        >
          <Button
            variant="ghost"
            size="compact"
            iconOnly
            onClick={onToggleCollapsed}
            aria-label="Expand file tree"
          >
            <AppCatalogChevronRightMediumIcon size="sm" />
          </Button>
        </div>
      </Surface>
    );
  }

  return (
    <>
      <div
        ref={panelRef}
        data-testid="diff-file-tree"
        data-view={listView ? 'list' : 'tree'}
        style={{
          width: `${isResizingRef.current ? pendingWidthRef.current : width}px`,
        }}
        className="flex shrink-0 flex-col border-r"
      >
        {!hideHeader && (
          <Surface variant="section" boundary="bottom" className="shrink-0">
            <div className="flex shrink-0 items-center justify-between px-3 py-2">
              <div className="flex min-w-0 items-center gap-1">
                <span
                  className="truncate text-3xs font-medium fg-secondary"
                  data-testid="diff-file-tree-header-count"
                >
                  {`${totalFiles} File${totalFiles === 1 ? '' : 's'}${visibleFiles < totalFiles ? ` (${visibleFiles})` : ''}`}
                </span>
                {headerAccessory}
              </div>
              <Button
                variant="ghost"
                size="compact"
                iconOnly
                onClick={onToggleCollapsed}
                aria-label="Collapse file tree"
              >
                <AppCatalogChevronLeftMediumIcon size="sm" />
              </Button>
            </div>
          </Surface>
        )}
        {/* `overflow-auto` (both axes): deeply nested paths are never
            truncated — the rows size to `w-max` and scroll horizontally
            instead. */}
        <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
          {listView ? (
            [
              ...uncommitted.map((file) => ({
                file,
                source: 'uncommitted' as const,
              })),
              ...committed.map((file) => ({
                file,
                source: 'committed' as const,
              })),
            ]
              .sort((a, b) =>
                `${a.file.repoName ?? ''}/${a.file.path}`.localeCompare(
                  `${b.file.repoName ?? ''}/${b.file.path}`,
                ),
              )
              .map((entry) => (
                <FileNodeRow
                  key={`${fileRowTestId(entry.file, entry.source)}:${entry.source}`}
                  entry={entry}
                  depth={0}
                  showFullPath
                  isSelected={
                    selectedFile?.path === entry.file.path &&
                    selectedFile.repoId === entry.file.repoId &&
                    selectedSource === entry.source
                  }
                  onSelect={onSelectFile}
                  onFileContextMenu={onFileContextMenu}
                  badge={fileBadges?.get(fileBadgeKey(entry.file))}
                  showDiffCounts={showsDiffCounts(
                    entry.file,
                    sourcesWithoutDiffCounts,
                    sourcesWithUnknownZeroCounts,
                    entry.source,
                  )}
                />
              ))
          ) : (
            <TreeRenderer
              node={tree}
              depth={0}
              selectedFile={selectedFile}
              selectedSource={selectedSource}
              onSelectFile={onSelectFile}
              onFileContextMenu={onFileContextMenu}
              expandedPaths={expandedPaths}
              onTogglePath={handleTogglePath}
              fileBadges={fileBadges}
              sourcesWithoutDiffCounts={sourcesWithoutDiffCounts}
              sourcesWithUnknownZeroCounts={sourcesWithUnknownZeroCounts}
            />
          )}
        </div>
      </div>
      {resizable && (
        <ResizeHandle
          orientation="horizontal"
          onDrag={handleResizeDrag}
          onCommit={handleResizeCommit}
          ariaLabel="Resize file tree"
        />
      )}
    </>
  );
}

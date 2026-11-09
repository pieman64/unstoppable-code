import {
  ChevronLeftMediumIcon,
  ChevronRightMediumIcon,
} from '../../icons/AppIcons';
import type { JSX, ReactNode } from 'react';
import { Button } from '../Button';
import { DiffLineCounts } from '../DiffLineCounts';
import { RichHoverTooltip } from '../RichHoverTooltip';
import { Heading } from '../Heading';

/**
 * Closed set of changed-file status strings recognized by the shared diff
 * file tree. Matches the desktop `ChangedFileStatus` union plus a generic
 * `unknown` fallback so callers can pass through unmapped values.
 */
export type DiffFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'type-changed'
  | 'untracked'
  | 'unknown';

/** Tailwind color class for each status dot. */
export const DIFF_STATUS_DOT_COLORS: Record<DiffFileStatus, string> = {
  added: 'bg-success',
  modified: 'bg-warning',
  deleted: 'bg-destructive',
  // Copied shares the renamed identity: a file that came from another path.
  renamed: 'bg-fg-info',
  copied: 'bg-fg-info',
  unmerged: 'bg-destructive',
  'type-changed': 'bg-fg-special-strong',
  untracked: 'bg-success',
  unknown: 'bg-fg-primary/40',
};

/** Sentence-case label for each status, shown after the change counts. */
const DIFF_STATUS_LABELS: Record<DiffFileStatus, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  unmerged: 'Unmerged',
  'type-changed': 'Type changed',
  untracked: 'Untracked',
  unknown: 'Unknown',
};

export interface DiffFileTreeFile {
  /** Display path of the file relative to the worktree (or repo-prefixed). */
  filePath: string;
  /**
   * Optional display text for the row, when the full {@link filePath} would be
   * redundant — e.g. a caller that groups by directory renders just the base
   * name under a directory heading. Selection still addresses `filePath`.
   */
  label?: string;
  /** Canonical status. Unknown / unrecognised values render as `'unknown'`. */
  status: DiffFileStatus;
  /** Optional line additions. */
  insertions?: number;
  /** Optional line deletions. */
  deletions?: number;
  /** Stable key used by both selection and React reconciliation. */
  key: string;
  /** True when this row is the active selection. */
  selected?: boolean;
}

export interface DiffFileTreeGroup {
  /** Group heading ("Uncommitted", "Committed", repo name, etc). */
  heading: string;
  files: DiffFileTreeFile[];
}

export interface DiffFileTreeProps {
  /** Ordered groups of files. */
  groups: DiffFileTreeGroup[];
  /** Click handler for a file entry. */
  onSelect: (file: DiffFileTreeFile, groupIndex: number) => void;
  /** Header label rendered above the groups (e.g. "Files (12)"). */
  headerLabel?: string;
  /** Optional collapse state; when set, the sidebar renders as a narrow rail
   * with an expand button. */
  collapsed?: boolean;
  /** Callback fired when the user toggles the sidebar collapse state. */
  onToggleCollapsed?: () => void;
  /** Optional preamble slot rendered above the groups (e.g. "combined" button). */
  preamble?: ReactNode;
  /** Optional empty-state slot when no groups have files. */
  emptyState?: ReactNode;
  /** Optional wrapper class override. */
  className?: string;
  /** Test ID hook for automation. */
  dataTestId?: string;
}

function CollapseArrow({
  direction,
}: {
  direction: 'left' | 'right';
}): JSX.Element {
  return direction === 'left' ? (
    <ChevronLeftMediumIcon size={14} />
  ) : (
    <ChevronRightMediumIcon size={14} />
  );
}

function resolveStatus(value: DiffFileStatus): DiffFileStatus {
  switch (value) {
    case 'added':
    case 'modified':
    case 'deleted':
    case 'renamed':
    case 'copied':
    case 'unmerged':
    case 'type-changed':
    case 'untracked':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

/**
 * Pure display sidebar that lists changed files grouped by section. The
 * desktop diff viewer wraps this with its expanded folder-tree rendering;
 * the web portal uses it directly with two flat groups (uncommitted /
 * committed). Selection state, header label, and collapse callbacks are all
 * owned by the parent.
 */
export function DiffFileTree({
  groups,
  onSelect,
  headerLabel,
  collapsed = false,
  onToggleCollapsed,
  preamble,
  emptyState,
  className,
  dataTestId,
}: DiffFileTreeProps): JSX.Element {
  if (collapsed) {
    return (
      <div
        className="flex w-10 shrink-0 flex-col items-center border-r py-2"
        data-testid={dataTestId ? `${dataTestId}-collapsed` : undefined}
      >
        {onToggleCollapsed && (
          <Button
            variant="ghost"
            size="compact"
            iconOnly
            onClick={onToggleCollapsed}
            aria-label="Expand file tree"
          >
            <CollapseArrow direction="right" />
          </Button>
        )}
      </div>
    );
  }

  const allFiles = groups.flatMap((g) => g.files);
  const wrapperClass = className ?? 'flex w-65 shrink-0 flex-col border-r';

  return (
    <div className={wrapperClass} data-testid={dataTestId}>
      {(headerLabel || onToggleCollapsed) && (
        <div className="flex items-center justify-between border-b px-3 py-2">
          {headerLabel && (
            <span className="text-3xs font-medium fg-secondary">
              {headerLabel}
            </span>
          )}
          {onToggleCollapsed && (
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              onClick={onToggleCollapsed}
              aria-label="Collapse file tree"
            >
              <CollapseArrow direction="left" />
            </Button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {preamble}
        {allFiles.length === 0
          ? emptyState
          : groups.map((group, groupIndex) => (
              <DiffFileTreeGroupRow
                key={`${group.heading}:${groupIndex}`}
                group={group}
                groupIndex={groupIndex}
                onSelect={onSelect}
              />
            ))}
      </div>
    </div>
  );
}

interface DiffFileTreeGroupRowProps {
  group: DiffFileTreeGroup;
  groupIndex: number;
  onSelect: (file: DiffFileTreeFile, groupIndex: number) => void;
}

function DiffFileTreeGroupRow({
  group,
  groupIndex,
  onSelect,
}: DiffFileTreeGroupRowProps): JSX.Element {
  return (
    <section
      className="flex flex-col gap-1 px-1 py-1"
      data-testid={`diff-file-tree-group-${group.heading.toLowerCase()}`}
    >
      <div className="px-1">
        <Heading level={3} variant="label">
          {group.heading}
        </Heading>
      </div>
      {group.files.length === 0 ? (
        <p className="px-1 text-3xs fg-secondary">None</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {group.files.map((file) => (
            <DiffFileTreeRow
              key={file.key}
              file={file}
              onSelect={(): void => onSelect(file, groupIndex)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface DiffFileTreeRowProps {
  file: DiffFileTreeFile;
  onSelect: () => void;
}

function DiffFileTreeRow({
  file,
  onSelect,
}: DiffFileTreeRowProps): JSX.Element {
  const status = resolveStatus(file.status);
  const dotClass = DIFF_STATUS_DOT_COLORS[status];
  const selectedClass = file.selected
    ? 'border-l-2 border-line-accent bg-accent/[0.08] fg-primary pl-1.5'
    : 'fg-primary/80 hover:bg-fg-primary/[0.06]';
  return (
    <li>
      <RichHoverTooltip
        content={<span className="font-mono">{file.filePath}</span>}
        triggerWrapperClassName="w-full"
        surfaceClassName="w-max max-w-96"
        surfacePadding="compact"
      >
        <button
          type="button"
          onClick={onSelect}
          data-testid="diff-file-tree-row"
          data-selected={file.selected ? 'true' : 'false'}
          // Rows under a directory heading show only the base name, so the
          // visible text alone is ambiguous when two directories hold the same
          // filename. The full path stays the accessible name (and tooltip).
          aria-label={file.filePath}
          className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${selectedClass}`}
        >
          <span className={`h-1.75 w-1.75 shrink-0 rounded-full ${dotClass}`} />
          <span className="truncate font-mono">
            {file.label ?? file.filePath}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <DiffLineCounts
              insertions={file.insertions}
              deletions={file.deletions}
              size="compact"
            />
            <span className="text-3xs fg-secondary">
              {DIFF_STATUS_LABELS[status]}
            </span>
          </span>
        </button>
      </RichHoverTooltip>
    </li>
  );
}

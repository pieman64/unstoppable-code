import { useState, type JSX } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '../../icons';
import {
  CloseIcon as AppCatalogCloseIcon,
  ForwardIcon as AppCatalogForwardIcon,
  PencilIcon as AppCatalogPencilIcon,
} from '../../icons/AppIcons';
import { RichHoverTooltip } from '../RichHoverTooltip';

export type TurnDiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface TurnDiffFileEntry {
  path: string;
  status: TurnDiffStatus;
  insertions?: number;
  deletions?: number;
  previousPath?: string;
  /** Optional repo name shown as a small caption under the filename. */
  repoName?: string;
}

export interface TurnDiffSummaryProps {
  files: TurnDiffFileEntry[];
  /** Optional click handler. Receives the original `path` for the row. */
  onFileClick?: (path: string) => void;
  /** Whether the body starts expanded. Defaults to `true` when ≤10 files. */
  defaultExpanded?: boolean;
  /** Test ID hook for automation. */
  dataTestId?: string;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function renderStatusIcon(status: TurnDiffStatus): JSX.Element {
  if (status === 'added') {
    return (
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-success" />
    );
  }
  if (status === 'deleted') {
    return (
      <AppCatalogCloseIcon
        aria-hidden="true"
        width="12"
        height="12"
        className="fg-destructive"
      />
    );
  }
  if (status === 'renamed') {
    return (
      <AppCatalogForwardIcon
        aria-hidden="true"
        width="12"
        height="12"
        className="fg-info"
      />
    );
  }
  // modified
  return (
    <AppCatalogPencilIcon
      aria-hidden="true"
      width="12"
      height="12"
      className="fg-info"
    />
  );
}

/**
 * Pure display per-turn diff summary. Renders a header with the file count +
 * totals and an expandable grid of file cards. Click handlers are delegated
 * to the host so this primitive stays free of `window.api`, file-tab stores,
 * etc.
 */
export function TurnDiffSummary({
  files,
  onFileClick,
  defaultExpanded,
  dataTestId,
}: TurnDiffSummaryProps): JSX.Element {
  const initialExpanded = defaultExpanded ?? files.length <= 10;
  const [isExpanded, setIsExpanded] = useState(initialExpanded);

  const totalInsertions = files.reduce(
    (sum, f) => sum + (f.insertions ?? 0),
    0,
  );
  const totalDeletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
  const fileCount = files.length;
  const fileLabel = fileCount === 1 ? 'file changed' : 'files changed';

  return (
    <div
      className="rounded-md border bg-fg-primary/[0.02] px-3 py-2"
      data-testid={dataTestId}
    >
      <button
        type="button"
        onClick={(): void => setIsExpanded((prev) => !prev)}
        aria-expanded={isExpanded}
        className="flex w-full items-center gap-x-2 text-xs"
      >
        <span className="flex-shrink-0 fg-secondary">
          {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </span>
        <span className="font-medium fg-primary">
          {fileCount} {fileLabel}
        </span>
        <span className="font-medium tabular-nums fg-success">
          +{totalInsertions}
        </span>
        <span className="font-medium tabular-nums fg-destructive">
          -{totalDeletions}
        </span>
      </button>
      {isExpanded && (
        <div className="mt-2 flex flex-wrap gap-2">
          {files.map((file) => {
            const baseName = basename(file.path);
            const titleText =
              file.status === 'renamed' && file.previousPath
                ? `${file.previousPath} → ${file.path}`
                : file.path;
            return (
              <RichHoverTooltip
                key={`${file.repoName ?? ''}:${file.path}`}
                content={<span className="font-mono">{titleText}</span>}
                triggerWrapperClassName="min-w-0"
                surfaceClassName="w-max max-w-96"
                surfacePadding="compact"
              >
                <button
                  type="button"
                  onClick={
                    onFileClick ? (): void => onFileClick(file.path) : undefined
                  }
                  className="min-w-0 cursor-pointer rounded-md border bg-fg-primary/[0.02] px-2 py-1.5 text-left text-xs transition hover:bg-fg-primary/[0.04]"
                  data-file-status={file.status}
                  data-file-path={file.path}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="flex h-3 w-3 shrink-0 items-center justify-center">
                      {renderStatusIcon(file.status)}
                    </span>
                    <span className="min-w-0 flex-1 truncate fg-primary">
                      {baseName}
                    </span>
                    <span className="shrink-0 font-medium tabular-nums">
                      <span className="fg-success">
                        +{file.insertions ?? 0}
                      </span>
                      <span className="ml-1 fg-destructive">
                        -{file.deletions ?? 0}
                      </span>
                    </span>
                  </div>
                  {file.repoName && (
                    <div className="mt-1 truncate text-3xs fg-secondary">
                      {file.repoName}
                    </div>
                  )}
                </button>
              </RichHoverTooltip>
            );
          })}
        </div>
      )}
    </div>
  );
}

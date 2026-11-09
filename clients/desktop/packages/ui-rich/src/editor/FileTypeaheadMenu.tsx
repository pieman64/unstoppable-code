import { LoadingSpinner } from '@canopy/ui-shared/components';
import { useEffect, useMemo, useRef, type JSX, type ReactNode } from 'react';
import type { FileMentionOption } from '../types';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

export interface FileTypeaheadMenuProps {
  files: FileMentionOption[];
  selectedIndex: number;
  /**
   * Shows repo section headers even when the current results only contain one
   * repo. Results spanning multiple named groups are always sectioned.
   */
  isMultiRepo: boolean;
  isLoading: boolean;
  onSelect: (file: FileMentionOption) => void;
  /** Replaces the default loading spinner. */
  loadingIcon?: ReactNode;
}

function highlightPath(path: string, indices: number[] | undefined): ReactNode {
  if (!indices || indices.length === 0) {
    return path;
  }
  const matches = new Set(indices);
  return path.split('').map((char, index) => (
    <span
      key={`${char}-${index}`}
      className={matches.has(index) ? 'fg-accent' : undefined}
    >
      {char}
    </span>
  ));
}

export function FileTypeaheadMenu({
  files,
  selectedIndex,
  isMultiRepo,
  isLoading,
  onSelect,
  loadingIcon,
}: FileTypeaheadMenuProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const spinner = loadingIcon ?? <LoadingSpinner decorative sizePx={14} />;

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const selected = container.querySelector<HTMLElement>(
      `[data-file-index="${selectedIndex}"]`,
    );
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const showGroupHeaders = useMemo(
    () => isMultiRepo || new Set(files.map((file) => file.repoName)).size > 1,
    [files, isMultiRepo],
  );

  const groupedFiles = useMemo(() => {
    if (!showGroupHeaders) {
      return [{ repoName: '', items: files }];
    }

    const groups = new Map<string, FileMentionOption[]>();
    for (const file of files) {
      const existing = groups.get(file.repoName);
      if (existing) {
        existing.push(file);
      } else {
        groups.set(file.repoName, [file]);
      }
    }
    return Array.from(groups.entries()).map(([repoName, items]) => ({
      repoName,
      items,
    }));
  }, [files, showGroupHeaders]);

  const indexMap = useMemo(() => {
    const map = new Map<string, number>();
    let index = 0;
    for (const group of groupedFiles) {
      for (const file of group.items) {
        map.set(`${file.repoId}:${file.relativePath}`, index++);
      }
    }
    return map;
  }, [groupedFiles]);

  if (isLoading && files.length === 0) {
    return (
      <div
        data-canopy-browser-native-overlay="true"
        data-testid="file-typeahead-menu"
        className="absolute bottom-full left-0 right-0 z-10 mb-1 rounded-lg bg-popover px-4 py-3 shadow-lg"
      >
        <div className="flex items-center gap-2 text-s fg-secondary">
          {spinner}
          Loading files…
        </div>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div
        data-canopy-browser-native-overlay="true"
        data-testid="file-typeahead-menu"
        className="absolute bottom-full left-0 right-0 z-10 mb-1 rounded-lg bg-popover px-4 py-3 shadow-lg"
      >
        <p className="text-s fg-secondary">No matching files</p>
      </div>
    );
  }

  return (
    <div
      data-canopy-browser-native-overlay="true"
      data-testid="file-typeahead-menu"
      className="absolute bottom-full left-0 right-0 z-10 mb-1 overflow-hidden rounded-lg bg-popover shadow-lg"
    >
      <div
        ref={listRef}
        role="listbox"
        className="max-h-60 overflow-y-auto py-1"
      >
        {groupedFiles.map((group) => (
          <div key={group.repoName || 'default'}>
            {showGroupHeaders && (
              <div
                data-testid="file-typeahead-section-header"
                className="sticky top-0 bg-popover px-3 py-0.5 text-3xs font-medium fg-secondary "
              >
                <span className={REPLAY_MASK_CLASS}>{group.repoName}</span>
              </div>
            )}
            {group.items.map((file) => {
              const flatIndex =
                indexMap.get(`${file.repoId}:${file.relativePath}`) ?? -1;
              const filenameStart = Math.max(
                0,
                file.relativePath.length - file.filename.length,
              );
              const filenameMatchIndices = (file.matchedIndices ?? [])
                .filter((index) => index >= filenameStart)
                .map((index) => index - filenameStart);
              const directoryMatchIndices = (file.matchedIndices ?? []).filter(
                (index) => index < filenameStart,
              );
              const directory =
                file.relativePath === file.filename
                  ? ''
                  : file.relativePath.slice(0, filenameStart);

              return (
                <button
                  key={`${file.repoId}:${file.relativePath}`}
                  data-file-index={flatIndex}
                  type="button"
                  role="option"
                  aria-selected={flatIndex === selectedIndex}
                  onMouseDown={(event): void => {
                    event.preventDefault();
                    onSelect(file);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                    flatIndex === selectedIndex
                      ? 'bg-fg-primary/[0.08]'
                      : 'hover:bg-fg-primary/[0.04]'
                  }`}
                >
                  <span className="shrink-0 text-xs font-medium fg-primary">
                    {highlightPath(file.filename, filenameMatchIndices)}
                  </span>
                  <span className="min-w-0 truncate text-2xs fg-secondary">
                    {directory
                      ? highlightPath(directory, directoryMatchIndices)
                      : file.relativePath}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

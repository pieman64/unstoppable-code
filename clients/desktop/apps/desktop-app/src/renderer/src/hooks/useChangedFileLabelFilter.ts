import { changedFilesHeaderSubtitle } from '@canopy/ui-app';
import { useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/shallow';
import type { ChangedFileInfo } from '@canopy/desktop-shared/types';
import {
  OTHER_FILE_LABEL_ID,
  OTHER_FILE_LABEL_NAME,
  isFileVisibleWithHiddenLabels,
} from '@canopy/desktop-shared/file-labels';
import { useFileLabelsStore } from '@/stores/fileLabelsStore';

export interface FileLabelFilterOption {
  id: string;
  name: string;
  /** Rows in the current file lists carrying this label. */
  count: number;
}

export interface ChangedFileLabelFilter {
  visibleUncommitted: ChangedFileInfo[];
  visibleCommitted: ChangedFileInfo[];
  /** Total rows before filtering. */
  totalCount: number;
  /** Rows still shown after filtering. */
  visibleCount: number;
  /** Rows removed by the active filter. */
  hiddenCount: number;
  /**
   * Enabled buckets in priority order plus the synthetic Other entry,
   * limited to labels that actually match a row in the current lists —
   * an empty label would be a dead menu entry.
   */
  options: FileLabelFilterOption[];
  hiddenLabelIds: string[];
  setHiddenLabelIds: (ids: string[]) => void;
  /** Make a path visible by clearing every hidden label assigned to it. */
  revealFile: (path: string) => void;
}

const EMPTY_FILES: ChangedFileInfo[] = [];

/**
 * Classify changed-file lists with the configured file labels and apply the
 * persisted multi-select label filter. Classification runs on the
 * repo-relative `path` (never the repo-name display prefix), matching the
 * settings-side matcher semantics.
 */
export function useChangedFileLabelFilter(
  uncommitted: readonly ChangedFileInfo[] | undefined,
  committed: readonly ChangedFileInfo[] | undefined,
): ChangedFileLabelFilter {
  // `labels` identity changes on every setLabels/loadFileLabels, so it also
  // stands in for the classifier-cache version.
  const { labels, hiddenLabelIds } = useFileLabelsStore(
    useShallow((s) => ({
      labels: s.labels,
      hiddenLabelIds: s.hiddenLabelIds,
    })),
  );
  const setHiddenLabelIds = useFileLabelsStore((s) => s.setHiddenLabelIds);

  const revealFile = useCallback(
    (path: string): void => {
      const labelsForFile = useFileLabelsStore.getState().classifyPath(path);
      const idsToReveal = new Set(
        labelsForFile.length > 0 ? labelsForFile : [OTHER_FILE_LABEL_ID],
      );
      const next = hiddenLabelIds.filter((id) => !idsToReveal.has(id));
      if (next.length !== hiddenLabelIds.length) {
        setHiddenLabelIds(next);
      }
    },
    [hiddenLabelIds, setHiddenLabelIds],
  );

  const uncommittedFiles = uncommitted ?? EMPTY_FILES;
  const committedFiles = committed ?? EMPTY_FILES;

  return useMemo((): ChangedFileLabelFilter => {
    const classifyPath = useFileLabelsStore.getState().classifyPath;
    const optionIds = new Set<string>(
      labels.filter((bucket) => bucket.enabled).map((bucket) => bucket.id),
    );
    optionIds.add(OTHER_FILE_LABEL_ID);
    // Stale persisted ids (deleted/disabled buckets) must not hide files.
    const effectiveHidden = new Set(
      hiddenLabelIds.filter((id) => optionIds.has(id)),
    );

    const counts = new Map<string, number>();
    const filterList = (files: readonly ChangedFileInfo[]): ChangedFileInfo[] =>
      files.filter((file) => {
        const fileLabels = classifyPath(file.path);
        if (fileLabels.length === 0) {
          counts.set(
            OTHER_FILE_LABEL_ID,
            (counts.get(OTHER_FILE_LABEL_ID) ?? 0) + 1,
          );
        } else {
          for (const id of fileLabels) {
            counts.set(id, (counts.get(id) ?? 0) + 1);
          }
        }
        return isFileVisibleWithHiddenLabels(fileLabels, effectiveHidden);
      });

    const visibleUncommitted = filterList(uncommittedFiles);
    const visibleCommitted = filterList(committedFiles);
    const totalCount = uncommittedFiles.length + committedFiles.length;
    const visibleCount = visibleUncommitted.length + visibleCommitted.length;
    const hiddenCount = totalCount - visibleCount;

    // Only labels present in the current lists are offered. Counts are tallied
    // over every row (not just visible ones), so a label stays listed while it
    // is the one being hidden.
    const options: FileLabelFilterOption[] = labels
      .filter((bucket) => bucket.enabled && (counts.get(bucket.id) ?? 0) > 0)
      .map((bucket) => ({
        id: bucket.id,
        name: bucket.name,
        count: counts.get(bucket.id) ?? 0,
      }));
    const otherCount = counts.get(OTHER_FILE_LABEL_ID) ?? 0;
    if (otherCount > 0) {
      options.push({
        id: OTHER_FILE_LABEL_ID,
        name: OTHER_FILE_LABEL_NAME,
        count: otherCount,
      });
    }

    return {
      visibleUncommitted,
      visibleCommitted,
      totalCount,
      visibleCount,
      hiddenCount,
      options,
      hiddenLabelIds,
      setHiddenLabelIds,
      revealFile,
    };
  }, [
    labels,
    hiddenLabelIds,
    revealFile,
    setHiddenLabelIds,
    uncommittedFiles,
    committedFiles,
  ]);
}

/**
 * Subtitle/header counter shared by the Changed Files card and the Review
 * Changes file tree: `"N files"` for the unfiltered total, plus the count
 * still shown when the label filter is hiding rows (`"N files (S)"`).
 */
export function formatFilteredFileCount(
  totalCount: number,
  visibleCount: number,
): string {
  // One wording for every host (REG-3024): the shared Changed files header.
  return changedFilesHeaderSubtitle({ totalCount, visibleCount });
}

/** Stable no-op filter shape for callers that render without filtering. */
export function useFileLabelFilterToggle(
  filter: Pick<ChangedFileLabelFilter, 'hiddenLabelIds' | 'setHiddenLabelIds'>,
): (labelId: string) => void {
  const { hiddenLabelIds, setHiddenLabelIds } = filter;
  return useCallback(
    (labelId: string): void => {
      const next = new Set(hiddenLabelIds);
      if (next.has(labelId)) {
        next.delete(labelId);
      } else {
        next.add(labelId);
      }
      setHiddenLabelIds(Array.from(next));
    },
    [hiddenLabelIds, setHiddenLabelIds],
  );
}

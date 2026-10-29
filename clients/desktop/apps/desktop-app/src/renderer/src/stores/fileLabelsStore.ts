import { create } from 'zustand';
import type { FileLabelBucket } from '@canopy/desktop-shared/types';
import {
  buildFileLabelClassifier,
  mergeFileLabelsWithBuiltins,
  type FileLabelClassifier,
} from '@canopy/desktop-shared/file-labels';

interface FileLabelsState {
  /** Merged (seeded + persisted) buckets in priority order. */
  labels: FileLabelBucket[];
  labelsVersion: number;
  /** Label ids hidden in the changed-file surfaces (empty = show all). */
  hiddenLabelIds: string[];
  /**
   * Bumped when something (the changed-file filter menus' Settings entry)
   * wants the Files settings page to open with the Labels section already
   * expanded. The Files tab expands whenever this counter changes.
   */
  labelsSectionExpandRequest: number;
  labelsSectionExpandConsumed: number;
  requestLabelsSectionExpand: () => void;
  consumeLabelsSectionExpandRequest: () => boolean;
  loadFileLabels: () => Promise<void>;
  /** Update runtime labels from a freshly persisted array (settings save). */
  setLabels: (persisted: FileLabelBucket[]) => void;
  setHiddenLabelIds: (ids: string[]) => void;
  /** Classify a repo-relative path into bucket ids (cached per version). */
  classifyPath: (path: string) => string[];
}

let classifier: FileLabelClassifier | null = null;
let classifierVersion = -1;
let cache = new Map<string, string[]>();

export const useFileLabelsStore = create<FileLabelsState>((set, get) => ({
  // Seeded defaults apply immediately so classification works before the
  // async preferences load resolves.
  labels: mergeFileLabelsWithBuiltins([]),
  labelsVersion: 0,
  hiddenLabelIds: [],
  labelsSectionExpandRequest: 0,
  labelsSectionExpandConsumed: 0,

  requestLabelsSectionExpand: (): void => {
    set((s) => ({
      labelsSectionExpandRequest: s.labelsSectionExpandRequest + 1,
    }));
  },

  consumeLabelsSectionExpandRequest: (): boolean => {
    let consumed = false;
    set((s) => {
      if (s.labelsSectionExpandRequest <= s.labelsSectionExpandConsumed) {
        return s;
      }
      consumed = true;
      return {
        labelsSectionExpandConsumed: s.labelsSectionExpandRequest,
      };
    });
    return consumed;
  },

  loadFileLabels: async (): Promise<void> => {
    try {
      const prefs = await window.api.loadPreferences();
      set((s) => ({
        labels: mergeFileLabelsWithBuiltins(prefs.fileLabels ?? []),
        labelsVersion: s.labelsVersion + 1,
        hiddenLabelIds: prefs.changedFilesHiddenLabelIds ?? [],
      }));
    } catch {
      // Preferences unavailable — keep the seeded defaults.
    }
  },

  setLabels: (persisted: FileLabelBucket[]): void => {
    set((s) => ({
      labels: mergeFileLabelsWithBuiltins(persisted),
      labelsVersion: s.labelsVersion + 1,
    }));
  },

  setHiddenLabelIds: (ids: string[]): void => {
    set({ hiddenLabelIds: ids });
    void window.api
      .savePreferences({ changedFilesHiddenLabelIds: ids })
      .catch(() => {
        // The runtime store already reflects the choice for this session.
      });
  },

  classifyPath: (path: string): string[] => {
    const { labels, labelsVersion } = get();
    if (classifier === null || classifierVersion !== labelsVersion) {
      classifier = buildFileLabelClassifier(labels);
      classifierVersion = labelsVersion;
      cache = new Map<string, string[]>();
    }
    const cached = cache.get(path);
    if (cached) return cached;
    const result = classifier(path);
    cache.set(path, result);
    return result;
  },
}));

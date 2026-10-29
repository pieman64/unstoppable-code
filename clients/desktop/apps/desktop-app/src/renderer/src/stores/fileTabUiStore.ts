import { create } from 'zustand';

/**
 * The identity a pending unsaved-close modal is bound to. `fileKey` is the
 * canonical shared session key ({@link fileViewerKey}); the modal verifies it
 * (alongside `tabId`) before force-closing so a replacement file opened under
 * the same tab id cannot be closed against a stale save result.
 */
export interface PendingUnsavedFileClose {
  tabId: string;
  fileKey: string;
  projectId: string;
  worktreeId: string;
  title: string;
  filePath: string;
}

interface FileTabUiState {
  /** Desktop Auto Save preference (a policy over the shared file buffer). */
  autoSaveEnabled: boolean;
  /** True once the persisted preference has been hydrated at least once. */
  preferencesLoaded: boolean;
  /** True while the persisted preference read is in flight (dedupes callers). */
  preferencesLoading: boolean;
  /** The tab awaiting an unsaved-close decision, or `null`. */
  pendingUnsavedClose: PendingUnsavedFileClose | null;
  /**
   * Per-file-tab embedded file-tree visibility overrides. Absent entries fall
   * back to the default: expanded while the tab is empty (no file assigned),
   * collapsed once it shows a file. Session-only by design.
   */
  fileTreeVisibleByTabId: Record<string, boolean>;
  fileTreeModeByTabId: Record<string, 'file' | 'diff'>;
  fileTreeListViewByTabId: Record<string, boolean>;
  setFileTreeListView: (tabId: string, listView: boolean) => void;
  initializeFileTreeMode: (tabId: string, mode: 'file' | 'diff') => void;
  setFileTreeMode: (tabId: string, mode: 'file' | 'diff') => void;
  /** Directory a newly opened empty tab should reveal in its embedded tree. */
  fileTreeDirectoryPathByTabId: Record<string, string>;
  /** Last file path whose one-shot embedded-tree reveal ran in each tab. */
  fileTreeRevealedPathByTabId: Record<string, string>;
  loadPreferences: () => Promise<void>;
  setAutoSaveEnabled: (enabled: boolean) => void;
  requestUnsavedClose: (request: PendingUnsavedFileClose) => void;
  clearPendingUnsavedClose: () => void;
  setFileTreeVisible: (tabId: string, visible: boolean) => void;
  openDirectoryInFileTree: (tabId: string, directoryPath: string) => void;
  markFileTreeRevealed: (tabId: string, filePath: string) => void;
}

/**
 * Resolves a tab's embedded-tree visibility: an explicit user toggle wins,
 * otherwise empty tabs open with the tree and file-bearing tabs without it.
 */
export function resolveFileTreeVisible(
  overrides: Record<string, boolean>,
  tabId: string,
  tabIsEmpty: boolean,
): boolean {
  return overrides[tabId] ?? tabIsEmpty;
}

/**
 * UI-only companion to the shared file-viewer store (CAN-1426). It owns
 * the Auto Save preference, the pending unsaved-close modal identity, per-tab
 * embedded-tree visibility, and the one-shot current-file reveal identity. It
 * holds NO file session, content, baseline, mtime, dirty, save-status, error,
 * timer, or write logic — the shared `FileViewerState.files[key]` session is
 * the sole owner of all of that, and the desktop session controller owns the
 * autosave timers keyed off it.
 */
export const useFileTabUiStore = create<FileTabUiState>((set, get) => ({
  autoSaveEnabled: false,
  preferencesLoaded: false,
  preferencesLoading: false,
  pendingUnsavedClose: null,
  fileTreeVisibleByTabId: {},
  fileTreeModeByTabId: {},
  fileTreeListViewByTabId: {},
  setFileTreeListView: (tabId, listView): void => {
    set((state) => ({
      fileTreeListViewByTabId: {
        ...state.fileTreeListViewByTabId,
        [tabId]: listView,
      },
    }));
  },
  initializeFileTreeMode: (tabId, mode): void => {
    if (get().fileTreeModeByTabId[tabId] === undefined)
      get().setFileTreeMode(tabId, mode);
  },
  setFileTreeMode: (tabId, mode): void => {
    set((state) =>
      state.fileTreeModeByTabId[tabId] === mode
        ? state
        : {
            fileTreeModeByTabId: {
              ...state.fileTreeModeByTabId,
              [tabId]: mode,
            },
          },
    );
  },
  fileTreeDirectoryPathByTabId: {},
  fileTreeRevealedPathByTabId: {},

  loadPreferences: async (): Promise<void> => {
    if (get().preferencesLoaded || get().preferencesLoading) return;
    set({ preferencesLoading: true });
    // Snapshot the live value: a toggle made while hydration is in flight must
    // win over the stale persisted value resolving afterwards.
    const beforeHydration = get().autoSaveEnabled;
    try {
      const prefs = await window.api.loadPreferences();
      set(
        get().autoSaveEnabled === beforeHydration
          ? {
              autoSaveEnabled: !!prefs.fileAutoSave,
              preferencesLoaded: true,
              preferencesLoading: false,
            }
          : { preferencesLoaded: true, preferencesLoading: false },
      );
    } catch {
      // If preferences are unavailable, mark as loaded so we don't keep
      // retrying — the user can still flip the toggle from settings.
      set({ preferencesLoaded: true, preferencesLoading: false });
    }
  },

  setAutoSaveEnabled: (enabled: boolean): void => {
    if (enabled === get().autoSaveEnabled) return;
    set({ autoSaveEnabled: enabled });
  },

  requestUnsavedClose: (request: PendingUnsavedFileClose): void => {
    set({ pendingUnsavedClose: request });
  },

  clearPendingUnsavedClose: (): void => {
    set({ pendingUnsavedClose: null });
  },

  setFileTreeVisible: (tabId: string, visible: boolean): void => {
    set((state) =>
      state.fileTreeVisibleByTabId[tabId] === visible
        ? state
        : {
            fileTreeVisibleByTabId: {
              ...state.fileTreeVisibleByTabId,
              [tabId]: visible,
            },
          },
    );
  },

  openDirectoryInFileTree: (tabId: string, directoryPath: string): void => {
    set((state) => ({
      fileTreeVisibleByTabId: {
        ...state.fileTreeVisibleByTabId,
        [tabId]: true,
      },
      fileTreeDirectoryPathByTabId: {
        ...state.fileTreeDirectoryPathByTabId,
        [tabId]: directoryPath,
      },
    }));
  },

  markFileTreeRevealed: (tabId: string, filePath: string): void => {
    set((state) =>
      state.fileTreeRevealedPathByTabId[tabId] === filePath
        ? state
        : {
            fileTreeRevealedPathByTabId: {
              ...state.fileTreeRevealedPathByTabId,
              [tabId]: filePath,
            },
          },
    );
  },
}));

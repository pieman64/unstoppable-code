'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type {
  PreviewSearchControlled,
  PreviewSearchState,
} from '../code/file/FilePreviewSearch';
import { useSurfaceFindStore, type FindController } from './surface-find-store';
import { useFindSurfaceShown } from './useFindSurfaceShown';

export const EMPTY_PREVIEW_SEARCH_STATE: PreviewSearchState = {
  enabled: false,
  open: false,
  queryPresent: false,
  currentIndex: 0,
  totalCount: 0,
};

/** The scope-menu label for a previewed file: its file name. */
export function findFileTitle(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export interface FilePreviewFindOptions {
  /**
   * Register while true and the preview is shown (its panel tab and page
   * host visible); it unregisters, closing the bar, otherwise.
   */
  enabled: boolean;
  /** The bar's scope key for this preview (a file tab id, a file path). */
  scopeKey: string;
  /** Scope-menu label beside other file panels. */
  title: string;
  /** The preview's root: the surface the bar anchors to and marks. */
  rootRef: RefObject<HTMLElement | null>;
}

export interface FilePreviewFindSurfaceProps {
  'data-find-surface': 'file';
  'data-find-scope': string;
  /** The root takes focus back when the bar closes without an opener. */
  tabIndex: -1;
}

/** Spread onto `FileViewer`: the headless preview search, host-driven. */
export interface FilePreviewFindViewerProps {
  previewSearchPresentation: 'headless';
  previewSearchControlled: PreviewSearchControlled;
  onPreviewSearchStateChange: (state: PreviewSearchState) => void;
  onPreviewSearchRequest: (operation: 'open' | 'close') => void;
}

export interface FilePreviewFind {
  /** What the preview last reported: whether it is searchable, and counts. */
  state: PreviewSearchState;
  /** The bar is open on this preview. */
  open: boolean;
  /** Spread onto the preview root so Cmd/Ctrl+F routes to this file. */
  surfaceProps: FilePreviewFindSurfaceProps;
  viewerProps: FilePreviewFindViewerProps;
  openBar: () => void;
  closeBar: () => void;
}

/**
 * Find-bar file mode for a host that renders the shared `FileViewer`
 * (CAN-3048). The preview runs its own in-document search through the
 * headless `FilePreviewSearch`; this hook owns the query and active match the
 * bar drives, registers the preview while it reports itself searchable
 * (images and editable raw text do not), and feeds the counts back.
 */
export function useFilePreviewFindController({
  enabled,
  scopeKey,
  title,
  rootRef,
}: FilePreviewFindOptions): FilePreviewFind {
  const [state, setState] = useState(EMPTY_PREVIEW_SEARCH_STATE);
  const [find, setFind] = useState({ query: '', index: 0 });
  const open = useSurfaceFindStore(
    (s) => s.open && s.mode === 'file' && s.activeScope.file === scopeKey,
  );
  const controlled = useMemo(
    () => ({ open, query: find.query, index: find.index }),
    [find.index, find.query, open],
  );
  const totalCountRef = useRef(state.totalCount);
  totalCountRef.current = state.totalCount;
  const titleRef = useRef(title);
  titleRef.current = title;
  const shown = useFindSurfaceShown();
  const searchable = enabled && state.enabled && shown;

  useEffect(() => {
    if (!searchable) return;
    useSurfaceFindStore.getState().setControllerTitle('file', scopeKey, title);
  }, [searchable, scopeKey, title]);

  useEffect(() => {
    const anchor = rootRef.current;
    if (!searchable || !anchor) return undefined;
    const step = (delta: number): void =>
      setFind((previous) => {
        const total = totalCountRef.current;
        if (total === 0) return previous;
        // Step from the match the preview shows, which resets to the first
        // one when the count shrinks below the stored index.
        const shown = previous.index < total ? previous.index : 0;
        return { ...previous, index: (shown + delta + total) % total };
      });
    const controller: FindController = {
      mode: 'file',
      scopeKey,
      title: titleRef.current,
      anchor,
      setQuery: (query): void => setFind({ query, index: 0 }),
      next: (): void => step(1),
      previous: (): void => step(-1),
      close: (): void => setFind({ query: '', index: 0 }),
    };
    useSurfaceFindStore.getState().registerController(controller);
    return (): void => {
      useSurfaceFindStore.getState().unregisterController(controller);
    };
  }, [rootRef, scopeKey, searchable]);

  const { currentIndex, totalCount } = state;
  useEffect(() => {
    if (!searchable) return;
    useSurfaceFindStore.getState().updateControllerState('file', scopeKey, {
      currentIndex: currentIndex < totalCount ? currentIndex : 0,
      totalCount,
      error: null,
    });
  }, [currentIndex, scopeKey, searchable, totalCount]);

  const openBar = useCallback((): void => {
    useSurfaceFindStore
      .getState()
      .openFor('file', scopeKey, rootRef.current?.ownerDocument.activeElement);
  }, [rootRef, scopeKey]);
  const closeBar = useCallback((): void => {
    const store = useSurfaceFindStore.getState();
    if (
      store.open &&
      store.mode === 'file' &&
      store.activeScope.file === scopeKey
    ) {
      store.close();
    }
  }, [scopeKey]);
  const onPreviewSearchRequest = useCallback(
    (operation: 'open' | 'close'): void => {
      if (operation === 'open') openBar();
      else closeBar();
    },
    [closeBar, openBar],
  );
  const viewerProps = useMemo(
    (): FilePreviewFindViewerProps => ({
      previewSearchPresentation: 'headless',
      previewSearchControlled: controlled,
      onPreviewSearchStateChange: setState,
      onPreviewSearchRequest,
    }),
    [controlled, onPreviewSearchRequest],
  );

  return {
    state,
    open,
    surfaceProps: {
      'data-find-surface': 'file',
      'data-find-scope': scopeKey,
      tabIndex: -1,
    },
    viewerProps,
    openBar,
    closeBar,
  };
}

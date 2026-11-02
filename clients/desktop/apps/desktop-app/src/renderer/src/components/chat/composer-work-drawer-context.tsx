import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefCallback,
} from 'react';

/**
 * Links the chat's compact queue (rendered by `ChatMessageList`, which owns
 * the queue and its handlers) to the composer's `ComposerWorkDrawer`
 * (rendered by `ChatInput`): the list reports how many rows it has, and
 * renders them into the drawer's Queued panel while that tab is open.
 */
export interface ComposerWorkDrawerLink {
  /** The open Queued panel's list element; null while the tab is closed. */
  readonly queuedSlot: HTMLDivElement | null;
  /** Main composer's open panel; an editor takes precedence while mounted. */
  readonly queuedPanelRef: RefCallback<HTMLDivElement>;
  /** The visible queued-message editor's open panel. */
  readonly queuedEditorPanelRef: RefCallback<HTMLDivElement>;
  readonly queuedCount: number;
  readonly setQueuedCount: (count: number) => void;
}

const ComposerWorkDrawerContext = createContext<ComposerWorkDrawerLink | null>(
  null,
);

/**
 * Provides the link to a chat's transcript and composer. A surface that
 * renders them in separate slots provides it around both; a nested provider
 * then reuses the outer link.
 */
export function ComposerWorkDrawerProvider({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const outer = useContext(ComposerWorkDrawerContext);
  return outer !== null ? (
    <>{children}</>
  ) : (
    <OwnComposerWorkDrawerLink>{children}</OwnComposerWorkDrawerLink>
  );
}

function OwnComposerWorkDrawerLink({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const [queuedSlot, setQueuedSlot] = useState<HTMLDivElement | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const panels = useRef<
    { node: HTMLDivElement; owner: 'composer' | 'editor' }[]
  >([]);
  const registerPanel = useCallback(
    (
      node: HTMLDivElement | null,
      owner: 'composer' | 'editor',
    ): (() => void) | undefined => {
      if (node === null) return undefined;
      const selectPanel = (): void => {
        const editor = [...panels.current]
          .reverse()
          .find((panel) => panel.owner === 'editor');
        setQueuedSlot(
          editor?.node ??
            panels.current[panels.current.length - 1]?.node ??
            null,
        );
      };
      panels.current = [...panels.current, { node, owner }];
      selectPanel();
      return (): void => {
        panels.current = panels.current.filter((panel) => panel.node !== node);
        selectPanel();
      };
    },
    [],
  );
  const queuedPanelRef = useCallback(
    (node: HTMLDivElement | null): (() => void) | undefined =>
      registerPanel(node, 'composer'),
    [registerPanel],
  );
  const queuedEditorPanelRef = useCallback(
    (node: HTMLDivElement | null): (() => void) | undefined =>
      registerPanel(node, 'editor'),
    [registerPanel],
  );
  const value = useMemo(
    () => ({
      queuedSlot,
      queuedPanelRef,
      queuedEditorPanelRef,
      queuedCount,
      setQueuedCount,
    }),
    [queuedSlot, queuedPanelRef, queuedEditorPanelRef, queuedCount],
  );
  return (
    <ComposerWorkDrawerContext.Provider value={value}>
      {children}
    </ComposerWorkDrawerContext.Provider>
  );
}

/** The link, or null outside a chat transcript (no queue to show). */
export function useComposerWorkDrawerLink(): ComposerWorkDrawerLink | null {
  return useContext(ComposerWorkDrawerContext);
}

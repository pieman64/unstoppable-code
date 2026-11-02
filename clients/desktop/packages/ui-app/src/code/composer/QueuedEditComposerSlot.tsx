'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  type JSX,
  type ReactElement,
  type ReactNode,
} from 'react';
import { ComposerTrayHost } from '@canopy/ui-shared/components';

export interface QueuedEditComposerSlotProps {
  /**
   * The queued-message editor while one is open, otherwise null. It takes the
   * composer's place in the chat column.
   */
  readonly editor: ReactElement | null;
  /** The chat's composer. */
  readonly children: ReactNode;
}

/**
 * The composer position of a chat surface, shared by every host (CAN-3607).
 *
 * Editing a queued message happens in the composer's place rather than in a
 * second editor inside the transcript. The composer stays mounted, only
 * hidden, so the person's unsent draft, attachments and caret come back
 * exactly as they were when the edit is saved or cancelled. When the edit
 * ends while focus was in the editor, focus returns to the composer at its
 * last caret.
 *
 * Whichever of the two shows hosts the composer tray (the compact queue),
 * so the tray stays on the visible box.
 */
export function QueuedEditComposerSlot({
  editor,
  children,
}: QueuedEditComposerSlotProps): JSX.Element {
  const editing = editor !== null;
  const composerRef = useRef<HTMLDivElement>(null);
  const editorFocusedRef = useRef(false);
  const wasEditingRef = useRef(editing);
  // The composer's last caret. A rich-text composer keeps no DOM selection
  // of its own once the editor takes it, and focusing it again would put
  // the caret at the start of the draft.
  const composerCaretRef = useRef<Range | null>(null);

  useEffect(() => {
    const composer = composerRef.current;
    if (editing || !composer) return undefined;
    const document = composer.ownerDocument;
    const recordCaret = (): void => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (composer.contains(range.startContainer)) {
        composerCaretRef.current = range.cloneRange();
      }
    };
    document.addEventListener('selectionchange', recordCaret);
    return (): void => {
      document.removeEventListener('selectionchange', recordCaret);
    };
  }, [editing]);

  useLayoutEffect(() => {
    const ended = wasEditingRef.current && !editing;
    wasEditingRef.current = editing;
    if (!ended) return;
    const returnFocus = editorFocusedRef.current;
    editorFocusedRef.current = false;
    if (!returnFocus) return;
    const input = composerRef.current?.querySelector<HTMLElement>(
      '[contenteditable="true"], textarea',
    );
    if (!input) return;
    input.focus();
    // A textarea keeps its own selection; a contenteditable needs its caret
    // put back.
    const caret = composerCaretRef.current;
    if (
      input instanceof HTMLTextAreaElement ||
      !caret ||
      !input.contains(caret.startContainer)
    ) {
      return;
    }
    const selection = input.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(caret);
  }, [editing]);

  return (
    <>
      {editing ? (
        <div
          className="contents"
          onFocus={(): void => {
            editorFocusedRef.current = true;
          }}
          onBlur={(event): void => {
            const next = event.relatedTarget;
            editorFocusedRef.current =
              next instanceof Node && event.currentTarget.contains(next);
          }}
        >
          <ComposerTrayHost active>{editor}</ComposerTrayHost>
        </div>
      ) : null}
      <div
        ref={composerRef}
        className={editing ? 'hidden' : 'contents'}
        data-queued-edit-hidden={editing ? 'true' : undefined}
      >
        <ComposerTrayHost active={!editing}>{children}</ComposerTrayHost>
      </div>
    </>
  );
}

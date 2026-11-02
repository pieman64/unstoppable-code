'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ComposerEditor,
  type ComposerEditorHandle,
} from '@canopy/ui-rich/editor';
import { ChatComposerShell, ChatComposerToolbar } from '@canopy/ui-shared';
import { MessageEditCancelSave } from '@canopy/ui-shared/components';

/** The queued message being edited in the composer's place (CAN-3607). */
export interface QueuedMessageEditControls {
  /** The queued entry being edited. Key the editor on it. */
  readonly entryId: string;
  /** The entry's text when the edit opened. */
  readonly initialText: string;
  /** True when the entry carries attachments, so empty text is a valid save. */
  readonly allowEmpty: boolean;
  /** False when focus moved elsewhere while the edit was opening. */
  readonly autoFocus?: boolean;
  /** Optional label above the text, such as an agent-sent title. */
  readonly label?: ReactNode;
  /** Mirrors the edited text, so a host can keep it if the row leaves. */
  readonly onTextChange?: (text: string) => void;
  /** Save the edited text back to the queued entry. */
  readonly onSave: (text: string) => void;
  /** Close the editor and leave the entry unchanged. */
  readonly onCancel: () => void;
}

export interface QueuedMessageComposerProps {
  readonly edit: QueuedMessageEditControls;
}

/**
 * Edits a queued message in the composer's place: the shared composer box
 * and editor holding the queued text, with Cancel and Save where send sits.
 * Enter saves and Escape cancels. The surrounding {@link QueuedEditComposerSlot}
 * keeps the chat's own composer and its draft mounted underneath.
 */
export function QueuedMessageComposer({
  edit,
}: QueuedMessageComposerProps): JSX.Element {
  const editorRef = useRef<ComposerEditorHandle | null>(null);
  const [text, setText] = useState(edit.initialText);
  const canSave = edit.allowEmpty || text.trim().length > 0;
  const { onSave, onCancel, onTextChange } = edit;
  // Focus once when the editor opens, unless focus already moved elsewhere.
  const [focusOnOpen] = useState(edit.autoFocus ?? true);

  useEffect(() => {
    if (focusOnOpen) editorRef.current?.focus();
  }, [focusOnOpen]);

  const save = useCallback((): void => {
    const next = editorRef.current?.serialize().text ?? text;
    if (!edit.allowEmpty && next.trim().length === 0) return;
    onSave(next.trim());
  }, [edit.allowEmpty, onSave, text]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Escape that dismisses an IME candidate keeps the edit open.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      onCancel();
    },
    [onCancel],
  );

  return (
    <div
      data-testid="queued-message-editor"
      className="relative z-30 mx-auto w-full max-w-[var(--chat-composer-shell-width)] shrink-0 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <ChatComposerShell dataTestId="queued-message-edit-shell">
        {edit.label ? (
          <div className="px-4 pt-3 text-3xs fg-secondary">{edit.label}</div>
        ) : null}
        <ComposerEditor
          ref={editorRef}
          initialText={edit.initialText}
          placeholder="Edit the queued message"
          dataTestId="queued-message-edit-input"
          onTextChange={(next): void => {
            setText(next);
            onTextChange?.(next);
          }}
          onKeyDown={handleKeyDown}
          onSubmit={(payload): void => onSave(payload.text.trim())}
          canSubmit={(payload): boolean =>
            edit.allowEmpty || payload.text.trim().length > 0
          }
        />
        <ChatComposerToolbar
          compact
          trailingSlot={
            <MessageEditCancelSave
              onCancel={onCancel}
              onSave={save}
              saveDisabled={!canSave}
            />
          }
        />
      </ChatComposerShell>
    </div>
  );
}

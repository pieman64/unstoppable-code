'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import {
  buildEditorValueFromMessage,
  restoreEditorContent,
  serializeEditorValue,
} from '@canopy/ui-rich/editor';
import type {
  ChatEditor,
  SerializedFileReference,
} from '@canopy/ui-rich/types';

/** The Slate editor value shape (avoids a direct `slate` import). */
type EditorValue = ChatEditor['children'];

/**
 * One coherent unsent New Task draft: the composer's serialized text and the
 * file-reference pills positioned in it. Binary attachments are deliberately
 * not part of a draft; each host keeps its own attachment lifecycle.
 *
 * An empty text with no references is a valid draft (the user cleared the
 * box), not a signal to fall back to an older one.
 */
export interface ComposerDraftSnapshot {
  readonly text: string;
  readonly fileReferences: readonly SerializedFileReference[];
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraftSnapshot = Object.freeze({
  text: '',
  fileReferences: Object.freeze([]),
});

function fileReferencesEqual(
  a: SerializedFileReference,
  b: SerializedFileReference,
): boolean {
  return (
    a.displayPath === b.displayPath &&
    a.absolutePath === b.absolutePath &&
    a.repoName === b.repoName &&
    a.kind === b.kind &&
    a.textStart === b.textStart
  );
}

/**
 * Content equality for drafts. Two drafts whose reference arrays differ only
 * in object identity are equal, so a host never rehydrates an editor just
 * because a store produced a new array.
 */
export function composerDraftContentEquals(
  a: ComposerDraftSnapshot,
  b: ComposerDraftSnapshot,
): boolean {
  if (a.text !== b.text) return false;
  if (a.fileReferences.length !== b.fileReferences.length) return false;
  return a.fileReferences.every((reference, index) =>
    fileReferencesEqual(reference, b.fileReferences[index]),
  );
}

/** Copies a draft so neither side of an ownership boundary can mutate the other. */
export function cloneComposerDraft(draft: ComposerDraftSnapshot): {
  text: string;
  fileReferences: SerializedFileReference[];
} {
  return {
    text: draft.text,
    fileReferences: draft.fileReferences.map((reference) => ({
      ...reference,
    })),
  };
}

/**
 * An in-memory draft owner that outlives the composer view it backs. A host
 * creates one per owning shell/session (see {@link useComposerDraftHolder});
 * it is never persisted, so reload and relaunch start empty.
 */
export interface ComposerDraftHolder {
  read: () => ComposerDraftSnapshot;
  /** Advances for each distinct edit, including edits back to older content. */
  revision: () => number;
  /** Updates text and/or references; omitted fields keep their value. */
  update: (patch: Partial<ComposerDraftSnapshot>) => void;
  clear: () => void;
}

export function createComposerDraftHolder(): ComposerDraftHolder {
  let current: ComposerDraftSnapshot = EMPTY_COMPOSER_DRAFT;
  let revision = 0;
  return {
    read: (): ComposerDraftSnapshot => cloneComposerDraft(current),
    revision: (): number => revision,
    update: (patch): void => {
      const next = cloneComposerDraft({
        text: patch.text ?? current.text,
        fileReferences: patch.fileReferences ?? current.fileReferences,
      });
      if (composerDraftContentEquals(current, next)) return;
      current = next;
      revision += 1;
    },
    clear: (): void => {
      if (!composerDraftContentEquals(current, EMPTY_COMPOSER_DRAFT))
        revision += 1;
      current = EMPTY_COMPOSER_DRAFT;
    },
  };
}

/**
 * Returns a draft holder scoped to `ownerKey`. The holder lives as long as
 * the calling component (the shell, not the view), and a new owner key (a
 * different session or account) starts a fresh, empty holder so one owner's
 * draft is never shown to another.
 */
export function useComposerDraftHolder(ownerKey: string): ComposerDraftHolder {
  const [owned, setOwned] = useState(() => ({
    ownerKey,
    holder: createComposerDraftHolder(),
  }));
  if (owned.ownerKey !== ownerKey) {
    const next = { ownerKey, holder: createComposerDraftHolder() };
    setOwned(next);
    return next.holder;
  }
  return owned.holder;
}

export interface ComposerDraftRestorationOptions {
  editor: ChatEditor;
  /**
   * Whether this editor is the one the user can see. Restoration runs on
   * mount while active and on every inactive-to-active transition, so a
   * hidden, still-mounted editor picks up drafts edited elsewhere.
   */
  active: boolean;
  /** Semantic owner reset/rebind signal; never an ordinary typing revision. */
  resetRevision?: number;
  /** Reads the canonical draft at restoration time (never a stale closure). */
  readDraft: () => ComposerDraftSnapshot;
  /**
   * Called just before the editor content is replaced, with the new value and
   * the draft it came from. Hosts use it to sync local React state and to
   * recognize the editor change callback that restoration triggers, which is
   * not a user edit.
   */
  onRestore: (value: EditorValue, draft: ComposerDraftSnapshot) => void;
}

/**
 * Keeps a long-lived Slate composer aligned with its canonical draft. When
 * the editor already matches the draft (by content, not identity) nothing
 * happens, so selection and history survive; otherwise the editor is rebuilt
 * from the draft with fresh history and the caret at the end. An intentional
 * owner reset can also clear an already-visible editor after a late commit.
 */
export function useComposerDraftRestoration({
  editor,
  active,
  resetRevision,
  readDraft,
  onRestore,
}: ComposerDraftRestorationOptions): void {
  const readDraftRef = useRef(readDraft);
  const onRestoreRef = useRef(onRestore);
  useLayoutEffect(() => {
    readDraftRef.current = readDraft;
    onRestoreRef.current = onRestore;
  });

  useLayoutEffect(() => {
    if (!active) return;
    const draft = readDraftRef.current();
    if (
      composerDraftContentEquals(serializeEditorValue(editor.children), draft)
    )
      return;
    const value = buildEditorValueFromMessage(draft.text, draft.fileReferences);
    onRestoreRef.current(value, draft);
    restoreEditorContent(editor, value);
  }, [active, editor, resetRevision]);
}

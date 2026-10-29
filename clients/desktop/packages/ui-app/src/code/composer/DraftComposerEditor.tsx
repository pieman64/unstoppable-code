'use client';

import {
  forwardRef,
  useCallback,
  useRef,
  type ForwardedRef,
  type JSX,
} from 'react';
import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerEditorProps,
} from '@canopy/ui-rich/editor';
import type { SerializedFileReference } from '@canopy/ui-rich/types';
import {
  cloneComposerDraft,
  type ComposerDraftSnapshot,
} from './composer-draft';

export interface DraftComposerEditorProps extends ComposerEditorProps {
  /** Publishes one text/pill snapshot per editor mutation, including reset and inserts. */
  onDraftChange?: (draft: ComposerDraftSnapshot) => void;
}

/**
 * The common draft-editing unit for Home and web composers. The rich editor
 * publishes text then references in the same mutation; collect that pair before
 * handing it to a surviving draft owner. Host-controlled Slate values, menus,
 * persistence, and submission stay with the caller.
 */
function DraftComposerEditorInner(
  {
    onDraftChange,
    onTextChange,
    onFileReferencesChange,
    ...props
  }: DraftComposerEditorProps,
  ref: ForwardedRef<ComposerEditorHandle>,
): JSX.Element {
  const textRef = useRef(props.initialText ?? '');
  const handleText = useCallback(
    (text: string): void => {
      textRef.current = text;
      onTextChange?.(text);
    },
    [onTextChange],
  );
  const handleReferences = useCallback(
    (fileReferences: SerializedFileReference[]): void => {
      onDraftChange?.(
        cloneComposerDraft({ text: textRef.current, fileReferences }),
      );
      onFileReferencesChange?.(fileReferences);
    },
    [onDraftChange, onFileReferencesChange],
  );

  return (
    <ComposerEditor
      ref={ref}
      {...props}
      onTextChange={handleText}
      onFileReferencesChange={handleReferences}
    />
  );
}

export const DraftComposerEditor = forwardRef<
  ComposerEditorHandle,
  DraftComposerEditorProps
>(DraftComposerEditorInner);
DraftComposerEditor.displayName = 'DraftComposerEditor';

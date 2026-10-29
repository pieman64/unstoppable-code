import { Editor, Range, Transforms, type Point } from 'slate';
import type { ChatEditor } from '@canopy/ui-rich/types';
import { insertTextAtCursor } from '@canopy/ui-rich/editor';
import type { VoiceTarget } from './voice-target';

/**
 * Creates a {@link VoiceTarget} that edits the provided Slate chat editor.
 *
 * The transcript lands once, at the selection as it stands when the take
 * ends, so anything typed or moved while recording is respected. A selection
 * is replaced; a take started before the editor was ever focused appends to
 * the end of the draft. A space separates the transcript from preceding
 * non-whitespace text.
 */
export function createSlateVoiceTarget(editor: ChatEditor): VoiceTarget {
  const characterBefore = (point: Point): string | null => {
    const before = Editor.before(editor, point, { unit: 'character' });
    if (!before) return null;
    const text = Editor.string(editor, Editor.range(editor, before, point));
    return text || null;
  };

  return {
    commitFinal(text: string): void {
      if (!text.trim()) return;
      if (!editor.selection) {
        Transforms.select(editor, Editor.end(editor, []));
      } else if (Range.isExpanded(editor.selection)) {
        Transforms.delete(editor);
      }
      const selection = editor.selection;
      if (!selection) return;
      // Measured after any selection was removed, at the actual boundary.
      const prev = characterBefore(Range.start(selection));
      const separator = prev && !/\s/.test(prev) ? ' ' : '';
      insertTextAtCursor(editor, separator + text);
    },
  };
}

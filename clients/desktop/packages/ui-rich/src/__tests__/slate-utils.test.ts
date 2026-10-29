/**
 * Pure tests for the editor utility helpers exported by `@canopy/ui-rich`.
 * These exercise the round-trip between Slate descendant trees and the wire
 * `{ text, fileReferences }` shape without mounting any React component.
 */
jest.mock('slate-react', () => ({
  withReact: <T>(editor: T): T => editor,
  ReactEditor: {
    focus: jest.fn(),
    isFocused: jest.fn(),
    blur: jest.fn(),
    toDOMNode: jest.fn(),
  },
}));

import { Editor, Node, Transforms } from 'slate';
import { ReactEditor } from 'slate-react';
import {
  appendFileReference,
  buildEditorValueFromMessage,
  createChatEditor,
  createEmptyValue,
  focusEditor,
  insertTextAtCursor,
  resetEditor,
  serializeEditorValue,
} from '../editor';
import { isDetachedSlateDomError } from '../editor/slate-utils';
import type { SerializedFileReference } from '../types';

function editorText(editor: ReturnType<typeof createChatEditor>): string {
  return editor.children.map((node) => Node.string(node)).join('\n');
}

describe('@canopy/ui-rich editor utils', () => {
  it('serializes plain text typing', () => {
    const editor = createChatEditor();
    editor.children = createEmptyValue();
    const end = Editor.end(editor, []);
    editor.selection = { anchor: end, focus: end };

    insertTextAtCursor(editor, 'hello world');
    const serialized = serializeEditorValue(editor.children);
    expect(serialized.text).toBe('hello world');
    expect(serialized.fileReferences).toEqual([]);
  });

  it('round-trips the opaque host `kind` through append/serialize/rebuild', () => {
    const editor = createChatEditor();
    editor.children = createEmptyValue();
    const end = Editor.end(editor, []);
    editor.selection = { anchor: end, focus: end };

    insertTextAtCursor(editor, 'Use ');
    const reference: SerializedFileReference = {
      displayPath: 'Prompt: Review Helper',
      absolutePath: '/data/prompts/review-helper.md',
      kind: 'prompt',
    };
    appendFileReference(editor, reference);

    const serialized = serializeEditorValue(editor.children);
    expect(serialized.fileReferences).toEqual([{ ...reference, textStart: 4 }]);

    const rebuilt = buildEditorValueFromMessage(
      serialized.text,
      serialized.fileReferences,
    );
    const rebuiltSerialized = serializeEditorValue(rebuilt);
    expect(rebuiltSerialized.fileReferences).toEqual([
      { ...reference, textStart: 4 },
    ]);
  });

  it('inserts and serializes a file-reference pill', () => {
    const editor = createChatEditor();
    editor.children = createEmptyValue();
    const end = Editor.end(editor, []);
    editor.selection = { anchor: end, focus: end };

    const reference: SerializedFileReference = {
      displayPath: 'src/main.ts',
      absolutePath: '/repo/src/main.ts',
    };
    appendFileReference(editor, reference);
    insertTextAtCursor(editor, 'please review');

    const serialized = serializeEditorValue(editor.children);
    expect(serialized.text).toContain('src/main.ts');
    expect(serialized.text).toContain('please review');
    expect(serialized.fileReferences).toEqual([{ ...reference, textStart: 0 }]);
  });

  it('rebuilds duplicate file-reference pills from serialized content', () => {
    const fileReferences: SerializedFileReference[] = [
      { displayPath: 'src/main.ts', absolutePath: '/repo/src/main.ts' },
      { displayPath: 'src/main.ts', absolutePath: '/repo/src/main.ts' },
    ];
    const value = buildEditorValueFromMessage(
      'Compare src/main.ts with src/main.ts',
      fileReferences,
    );
    expect(serializeEditorValue(value)).toEqual({
      text: 'Compare src/main.ts with src/main.ts',
      fileReferences: [
        { ...fileReferences[0], textStart: 8 },
        { ...fileReferences[1], textStart: 25 },
      ],
    });
  });

  it('rebuilds the exact positioned pill when ordinary text has the same label', () => {
    const displayPath = 'Prompt: Review Helper';
    const text = `${displayPath} then ${displayPath}`;
    const reference: SerializedFileReference = {
      displayPath,
      absolutePath: '/repo/prompts/review.md',
      textStart: text.lastIndexOf(displayPath),
    };
    const value = buildEditorValueFromMessage(text, [reference]);
    expect(serializeEditorValue(value)).toEqual({
      text,
      fileReferences: [reference],
    });
  });

  it('resetEditor clears the editor back to an empty paragraph', () => {
    const editor = createChatEditor();
    editor.children = createEmptyValue();
    const end = Editor.end(editor, []);
    editor.selection = { anchor: end, focus: end };
    insertTextAtCursor(editor, 'something');
    expect(editorText(editor)).toBe('something');
    resetEditor(editor);
    expect(editorText(editor)).toBe('');
  });

  it('clears stale Slate focus when a composer control owns DOM focus', () => {
    const editor = createChatEditor();
    editor.children = createEmptyValue();
    jest.mocked(ReactEditor.isFocused).mockReturnValueOnce(true);
    jest.mocked(ReactEditor.toDOMNode).mockReturnValueOnce({
      ownerDocument: { activeElement: {} },
    } as HTMLElement);
    focusEditor(editor);
    expect(ReactEditor.blur).toHaveBeenCalledWith(editor);
    expect(ReactEditor.focus).toHaveBeenCalledWith(editor);
  });

  it('ignores a stale Slate DOM mapping while the composer is remounting', () => {
    const editor = createChatEditor();
    editor.children = createEmptyValue();
    const end = Editor.end(editor, []);
    editor.selection = { anchor: end, focus: end };
    jest.mocked(ReactEditor.focus).mockImplementationOnce(() => {
      throw new Error('Cannot resolve a DOM node from Slate node');
    });

    expect(() => focusEditor(editor)).not.toThrow();
  });

  it('does not classify unrelated editor exceptions as stale DOM mappings', () => {
    expect(
      isDetachedSlateDomError(
        new Error('Cannot resolve a DOM node from Slate node'),
      ),
    ).toBe(true);
    expect(
      isDetachedSlateDomError(new Error('Unexpected editor failure')),
    ).toBe(false);
    expect(isDetachedSlateDomError('Cannot resolve a DOM node')).toBe(false);
  });

  it('Transforms.insertText is wired correctly for whitespace insertion', () => {
    // Confirms the editor accepts whitespace insertion at the cursor — a
    // behavior the voice-bridge relies on for leading-space handling.
    const editor = createChatEditor();
    editor.children = createEmptyValue();
    const end = Editor.end(editor, []);
    editor.selection = { anchor: end, focus: end };
    Transforms.insertText(editor, '   ');
    expect(editorText(editor)).toBe('   ');
  });

  // CAN-3794: New Task drafts are restored after navigation by rebuilding the
  // editor from the canonical `{ text, fileReferences }` snapshot. Pin that the
  // round trip is exact for multiline text, a blank line, a trailing newline,
  // and an inline pill, including the pill's text offset.
  it('round-trips multiline drafts with a blank line and a pill exactly', () => {
    const reference: SerializedFileReference = {
      displayPath: 'src/app.ts',
      absolutePath: '/repo/src/app.ts',
      repoName: 'repo',
      textStart: 'first line\n\nsee '.length,
    };
    const text = 'first line\n\nsee src/app.ts now\nlast line\n';
    const value = buildEditorValueFromMessage(text, [reference]);
    expect(value).toHaveLength(5);
    const serialized = serializeEditorValue(value);
    expect(serialized.text).toBe(text);
    expect(serialized.fileReferences).toEqual([reference]);
  });

  it('rebuilds an empty draft as one empty paragraph', () => {
    const serialized = serializeEditorValue(
      buildEditorValueFromMessage('', []),
    );
    expect(serialized).toEqual({ text: '', fileReferences: [] });
  });
});

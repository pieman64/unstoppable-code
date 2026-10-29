jest.mock('slate-react', () => ({
  withReact: <T>(editor: T): T => editor,
  ReactEditor: { focus: (): void => {}, isFocused: (): boolean => false },
}));

import { Editor, Node, Transforms } from 'slate';
import { createChatEditor } from '@canopy/ui-rich/editor';
import type { ChatEditor } from '@canopy/ui-rich/types';
import { createSlateVoiceTarget } from '../insert-into-slate';

function makeEditor(text = ''): ChatEditor {
  const editor = createChatEditor();
  editor.children = [{ type: 'paragraph', children: [{ text }] }];
  const point = Editor.end(editor, []);
  editor.selection = { anchor: point, focus: point };
  return editor;
}

function textOf(editor: ChatEditor): string {
  return editor.children.map((node) => Node.string(node)).join('\n');
}

function select(editor: ChatEditor, anchor: number, focus = anchor): void {
  Transforms.select(editor, {
    anchor: { path: [0, 0], offset: anchor },
    focus: { path: [0, 0], offset: focus },
  });
}

describe('createSlateVoiceTarget', () => {
  it('inserts into an empty editor without a separator', () => {
    const editor = makeEditor();
    createSlateVoiceTarget(editor).commitFinal('hello');
    expect(textOf(editor)).toBe('hello');
  });

  it('inserts at the start of the document without a separator', () => {
    const editor = makeEditor('world');
    select(editor, 0);
    createSlateVoiceTarget(editor).commitFinal('Hello ');
    expect(textOf(editor)).toBe('Hello world');
  });

  it('inserts mid-document with a space after non-whitespace', () => {
    const editor = makeEditor('Review plan');
    select(editor, 6);
    createSlateVoiceTarget(editor).commitFinal('the');
    expect(textOf(editor)).toBe('Review the plan');
  });

  it('adds a space after text at the end of the draft', () => {
    const editor = makeEditor('before');
    createSlateVoiceTarget(editor).commitFinal('hello world');
    expect(textOf(editor)).toBe('before hello world');
    expect(editor.selection?.anchor.offset).toBe('before hello world'.length);
  });

  it('adds no space when the cursor already follows whitespace', () => {
    const editor = makeEditor('before ');
    createSlateVoiceTarget(editor).commitFinal('hello');
    expect(textOf(editor)).toBe('before hello');
  });

  it('replaces a forward selection without touching adjacent text', () => {
    const editor = makeEditor('Keep this word here');
    select(editor, 10, 14);
    createSlateVoiceTarget(editor).commitFinal('phrase');
    expect(textOf(editor)).toBe('Keep this phrase here');
  });

  it('replaces a backward selection and spaces from the real boundary', () => {
    const editor = makeEditor('Keep thisword here');
    // Selects "word" focus-first; the character before it is "s".
    select(editor, 13, 9);
    createSlateVoiceTarget(editor).commitFinal('phrase');
    expect(textOf(editor)).toBe('Keep this phrase here');
  });

  it('appends to the end of the draft when the editor has no selection', () => {
    const editor = makeEditor('draft');
    editor.selection = null;
    createSlateVoiceTarget(editor).commitFinal('more');
    expect(textOf(editor)).toBe('draft more');
  });

  it('leaves the document and selection alone for blank text', () => {
    const editor = makeEditor('draft');
    select(editor, 2, 4);
    const before = editor.selection;
    const target = createSlateVoiceTarget(editor);
    target.commitFinal('');
    target.commitFinal('   ');
    expect(textOf(editor)).toBe('draft');
    expect(editor.selection).toEqual(before);
  });

  it('keeps provider text as delivered', () => {
    const editor = makeEditor();
    createSlateVoiceTarget(editor).commitFinal('  padded. ');
    expect(textOf(editor)).toBe('  padded. ');
  });

  it('appends each take once with the usual spacing', () => {
    const editor = makeEditor();
    const target = createSlateVoiceTarget(editor);
    target.commitFinal('Hello world.');
    target.commitFinal('How are you?');
    target.commitFinal("I'm fine.");
    expect(textOf(editor)).toBe("Hello world. How are you? I'm fine.");
  });
});

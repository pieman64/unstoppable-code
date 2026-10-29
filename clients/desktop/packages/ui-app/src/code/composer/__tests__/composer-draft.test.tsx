/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Transforms } from 'slate';
import { HistoryEditor } from 'slate-history';
import {
  buildEditorValueFromMessage,
  createChatEditor,
  restoreEditorContent,
  serializeEditorValue,
} from '@canopy/ui-rich/editor';
import type {
  ChatEditor,
  SerializedFileReference,
} from '@canopy/ui-rich/types';
import {
  composerDraftContentEquals,
  createComposerDraftHolder,
  useComposerDraftHolder,
  useComposerDraftRestoration,
  type ComposerDraftHolder,
  type ComposerDraftSnapshot,
} from '../composer-draft';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lacks `structuredClone`, which the editor helpers use on plain
// JSON-shaped Slate values.
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = <T,>(value: T): T =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- JSON round trip of a JSON-shaped Slate value
    JSON.parse(JSON.stringify(value));
}

const pill: SerializedFileReference = {
  displayPath: 'src/app.ts',
  absolutePath: '/repo/src/app.ts',
  textStart: 'first\n\nsee '.length,
};
const multilineDraft: ComposerDraftSnapshot = {
  text: 'first\n\nsee src/app.ts now',
  fileReferences: [pill],
};

function seededEditor(draft: ComposerDraftSnapshot): ChatEditor {
  const editor = createChatEditor();
  restoreEditorContent(
    editor,
    buildEditorValueFromMessage(draft.text, draft.fileReferences),
  );
  return editor;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('composerDraftContentEquals', () => {
  it('compares references by content, not identity', () => {
    expect(
      composerDraftContentEquals(multilineDraft, {
        text: multilineDraft.text,
        fileReferences: [{ ...pill }],
      }),
    ).toBe(true);
    expect(
      composerDraftContentEquals(multilineDraft, {
        text: multilineDraft.text,
        fileReferences: [{ ...pill, textStart: 0 }],
      }),
    ).toBe(false);
    expect(
      composerDraftContentEquals(multilineDraft, {
        text: multilineDraft.text,
        fileReferences: [],
      }),
    ).toBe(false);
  });
});

describe('createComposerDraftHolder', () => {
  it('stores text and references and isolates callers from mutation', () => {
    const holder = createComposerDraftHolder();
    const references = [{ ...pill }];
    holder.update({ text: multilineDraft.text, fileReferences: references });
    references[0].displayPath = 'mutated';
    const read = holder.read();
    expect(read).toEqual(multilineDraft);
    holder.update({ text: 'edited' });
    expect(holder.read()).toEqual({ text: 'edited', fileReferences: [pill] });
    holder.clear();
    expect(holder.read()).toEqual({ text: '', fileReferences: [] });
  });
});

describe('useComposerDraftHolder', () => {
  function Owner({
    ownerKey,
    onHolder,
  }: {
    ownerKey: string;
    onHolder: (holder: ComposerDraftHolder) => void;
  }): null {
    onHolder(useComposerDraftHolder(ownerKey));
    return null;
  }

  it('keeps one holder per owner and starts empty for a new owner', () => {
    const holders: ComposerDraftHolder[] = [];
    const record = (holder: ComposerDraftHolder): void => {
      holders.push(holder);
    };
    act(() => root.render(<Owner ownerKey="a" onHolder={record} />));
    const first = holders[holders.length - 1];
    first.update({ text: 'owned by a' });
    act(() => root.render(<Owner ownerKey="a" onHolder={record} />));
    expect(holders[holders.length - 1]).toBe(first);
    act(() => root.render(<Owner ownerKey="b" onHolder={record} />));
    const second = holders[holders.length - 1];
    expect(second).not.toBe(first);
    expect(second.read().text).toBe('');
  });
});

describe('useComposerDraftRestoration', () => {
  function Restorer({
    editor,
    active,
    draft,
    onRestore,
    resetRevision,
  }: {
    editor: ChatEditor;
    active: boolean;
    draft: () => ComposerDraftSnapshot;
    onRestore: jest.Mock;
    resetRevision?: number;
  }): JSX.Element | null {
    useComposerDraftRestoration({
      editor,
      active,
      readDraft: draft,
      onRestore,
      resetRevision,
    });
    return null;
  }

  it('restores multiline text and a pill into an empty active editor', () => {
    const editor = createChatEditor();
    restoreEditorContent(editor, buildEditorValueFromMessage('', []));
    const onRestore = jest.fn();
    act(() =>
      root.render(
        <Restorer
          editor={editor}
          active
          draft={() => multilineDraft}
          onRestore={onRestore}
        />,
      ),
    );
    expect(serializeEditorValue(editor.children)).toEqual(multilineDraft);
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(editor.history.undos).toHaveLength(0);
    expect(editor.selection?.anchor.path).toEqual([2, 2]);
  });

  it('leaves history and selection alone when the editor already matches', () => {
    const editor = seededEditor(multilineDraft);
    Transforms.select(editor, { path: [0, 0], offset: 1 });
    HistoryEditor.withoutSaving(editor, () => undefined);
    const selection = editor.selection;
    const onRestore = jest.fn();
    act(() =>
      root.render(
        <Restorer
          editor={editor}
          active
          draft={() => ({
            text: multilineDraft.text,
            fileReferences: [{ ...pill }],
          })}
          onRestore={onRestore}
        />,
      ),
    );
    expect(onRestore).not.toHaveBeenCalled();
    expect(editor.selection).toBe(selection);
  });

  it('restores an intentional empty draft over stale editor content', () => {
    const editor = seededEditor(multilineDraft);
    const onRestore = jest.fn();
    act(() =>
      root.render(
        <Restorer
          editor={editor}
          active
          draft={() => ({ text: '', fileReferences: [] })}
          onRestore={onRestore}
        />,
      ),
    );
    expect(serializeEditorValue(editor.children)).toEqual({
      text: '',
      fileReferences: [],
    });
  });

  it('clears an already-visible editor when its surviving owner commits after the view reopened', () => {
    const editor = seededEditor(multilineDraft);
    let draft: ComposerDraftSnapshot = multilineDraft;
    const onRestore = jest.fn();
    const render = (resetRevision: number): void =>
      act(() =>
        root.render(
          <Restorer
            editor={editor}
            active
            draft={() => draft}
            onRestore={onRestore}
            resetRevision={resetRevision}
          />,
        ),
      );
    render(0);
    expect(onRestore).not.toHaveBeenCalled();
    draft = { text: '', fileReferences: [] };
    render(1);
    expect(serializeEditorValue(editor.children)).toEqual(draft);
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('restores the latest draft on each hidden-to-visible transition only', () => {
    const editor = createChatEditor();
    restoreEditorContent(editor, buildEditorValueFromMessage('', []));
    let canonical: ComposerDraftSnapshot = { text: '', fileReferences: [] };
    const readDraft = (): ComposerDraftSnapshot => canonical;
    const onRestore = jest.fn();
    const render = (active: boolean): void =>
      act(() =>
        root.render(
          <Restorer
            editor={editor}
            active={active}
            draft={readDraft}
            onRestore={onRestore}
          />,
        ),
      );

    render(false);
    canonical = { text: 'typed elsewhere', fileReferences: [] };
    render(false);
    expect(onRestore).not.toHaveBeenCalled();
    render(true);
    expect(serializeEditorValue(editor.children).text).toBe('typed elsewhere');

    // Rerendering while visible is not a transition, so a later canonical
    // change does not overwrite what the user is typing here.
    canonical = { text: 'stale', fileReferences: [] };
    render(true);
    expect(serializeEditorValue(editor.children).text).toBe('typed elsewhere');

    render(false);
    canonical = { text: 'second\nround', fileReferences: [] };
    render(true);
    expect(serializeEditorValue(editor.children).text).toBe('second\nround');
    expect(onRestore).toHaveBeenCalledTimes(2);
  });
});

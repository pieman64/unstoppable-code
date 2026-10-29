/** @jest-environment jsdom */
import { act, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { deserialize, serialize } from 'node:v8';
import type { FileMentionOption, SlashCommandOption } from '../../types';
import {
  ComposerEditor,
  createChatEditor,
  serializeEditorValue,
  type ComposerEditorProps,
} from '../index';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
if (typeof globalThis.structuredClone !== 'function') {
  Object.defineProperty(globalThis, 'structuredClone', {
    configurable: true,
    value: (value: unknown): unknown => deserialize(serialize(value)),
  });
}
Object.defineProperty(HTMLElement.prototype, 'isContentEditable', {
  configurable: true,
  get(this: HTMLElement): boolean {
    return this.closest('[contenteditable="true"]') !== null;
  },
});

describe('ComposerEditor real Slate submission guards', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalMatchMedia = window.matchMedia;

  function setPointer(coarse: boolean): void {
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: coarse && query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener: (): void => {},
      removeListener: (): void => {},
      addEventListener: (): void => {},
      removeEventListener: (): void => {},
      dispatchEvent: (): boolean => false,
    });
  }

  beforeEach(() => {
    setPointer(false);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.matchMedia = originalMatchMedia;
  });

  async function mount(props: ComposerEditorProps): Promise<void> {
    await act(async () => {
      root.render(<ComposerEditor {...props} dataTestId="editor" />);
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-slate-editor="true"]'),
    ).not.toBeNull();
  }

  async function enter(options: KeyboardEventInit = {}): Promise<void> {
    await act(async () => {
      const editable = container.querySelector<HTMLElement>(
        '[data-testid="editor"]',
      );
      editable?.focus();
      editable?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          ...options,
        }),
      );
      await Promise.resolve();
    });
  }

  it.each(['', '   ', '\n'])(
    'rejects an empty or whitespace draft without a predicate: %j',
    async (initialText) => {
      const onSubmit = jest.fn();
      await mount({ initialText, onSubmit });
      await enter();
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );

  it('submits ordinary text without a predicate', async () => {
    const onSubmit = jest.fn();
    await mount({ initialText: 'hello', onSubmit });
    await enter();
    expect(onSubmit).toHaveBeenCalledWith({
      text: 'hello',
      fileReferences: [],
    });
  });

  it('allows an empty draft only when its host predicate accepts it', async () => {
    const onSubmit = jest.fn();
    const canSubmit = jest.fn().mockReturnValue(true);
    await mount({ onSubmit, canSubmit });
    await enter();
    expect(canSubmit).toHaveBeenCalledWith({ text: '', fileReferences: [] });
    expect(onSubmit).toHaveBeenCalledWith({ text: '', fileReferences: [] });
  });

  it('honors a rejected host predicate even with ordinary text', async () => {
    const onSubmit = jest.fn();
    await mount({ initialText: 'hello', onSubmit, canSubmit: () => false });
    await enter();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('passes actual serialized file references to the host predicate', async () => {
    const onSubmit = jest.fn();
    const editor = createChatEditor();
    editor.children = [
      {
        type: 'paragraph',
        children: [
          { text: '' },
          {
            type: 'file-reference',
            displayPath: 'notes.txt',
            absolutePath: '/notes.txt',
            children: [{ text: '' }],
          },
          { text: '' },
        ],
      },
    ];
    await mount({
      editor,
      value: editor.children,
      onChange: () => {},
      onSubmit,
      canSubmit: (payload) => payload.fileReferences.length > 0,
    });
    await enter();
    expect(onSubmit).toHaveBeenCalledWith({
      text: 'notes.txt',
      fileReferences: [
        { displayPath: 'notes.txt', absolutePath: '/notes.txt', textStart: 0 },
      ],
    });
  });

  it.each([{ shiftKey: true }, { metaKey: true }])(
    'preserves modified Enter %j',
    async (options) => {
      const onSubmit = jest.fn();
      const canSubmit = jest.fn().mockReturnValue(true);
      await mount({ initialText: 'hello', onSubmit, canSubmit });
      await enter(options);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(canSubmit).not.toHaveBeenCalled();
    },
  );

  it('preserves coarse pointer Enter', async () => {
    setPointer(true);
    const onSubmit = jest.fn();
    await mount({ initialText: 'hello', onSubmit, canSubmit: () => true });
    await enter();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('runs host keyboard handling before its predicate', async () => {
    const onSubmit = jest.fn();
    const canSubmit = jest.fn().mockReturnValue(true);
    await mount({
      initialText: 'hello',
      onSubmit,
      canSubmit,
      onKeyDown: (event) => event.preventDefault(),
    });
    await enter();
    expect(canSubmit).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('leaves the desktop host keyboard path intact when onSubmit is omitted', async () => {
    const onKeyDown = jest.fn(
      (event: ReactKeyboardEvent<HTMLDivElement>): void => {
        event.preventDefault();
      },
    );
    const canSubmit = jest.fn().mockReturnValue(true);
    await mount({ initialText: 'hello', onKeyDown, canSubmit });
    await enter();
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(canSubmit).not.toHaveBeenCalled();
  });

  it('selects a slash typeahead entry before considering submission', async () => {
    const editor = createChatEditor();
    editor.children = [{ type: 'paragraph', children: [{ text: '/rev' }] }];
    editor.selection = {
      anchor: { path: [0, 0], offset: 4 },
      focus: { path: [0, 0], offset: 4 },
    };
    const onSubmit = jest.fn();
    const canSubmit = jest.fn().mockReturnValue(true);
    await mount({
      editor,
      value: editor.children,
      onChange: () => {},
      onSubmit,
      canSubmit,
      fetchSlashCommands: (): Promise<SlashCommandOption[]> =>
        Promise.resolve([{ name: 'review' }]),
    });
    await enter();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(canSubmit).not.toHaveBeenCalled();
    expect(serializeEditorValue(editor.children).text).toBe('/review ');
  });

  it('selects a file typeahead entry before considering submission', async () => {
    const editor = createChatEditor();
    editor.children = [{ type: 'paragraph', children: [{ text: '@no' }] }];
    editor.selection = {
      anchor: { path: [0, 0], offset: 3 },
      focus: { path: [0, 0], offset: 3 },
    };
    const onSubmit = jest.fn();
    const canSubmit = jest.fn().mockReturnValue(true);
    await mount({
      editor,
      value: editor.children,
      onChange: () => {},
      onSubmit,
      canSubmit,
      searchFileMentions: (): Promise<FileMentionOption[]> =>
        Promise.resolve([
          {
            repoId: 'repo',
            repoName: 'repo',
            relativePath: 'notes.txt',
            filename: 'notes.txt',
            absolutePath: '/notes.txt',
          },
        ]),
    });
    await enter();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(canSubmit).not.toHaveBeenCalled();
    expect(serializeEditorValue(editor.children).fileReferences).toMatchObject([
      { displayPath: 'notes.txt' },
    ]);
  });
});

/**
 * @jest-environment jsdom
 */
// Key handling of the shared composer editor. The real slate-react Editable
// does not deliver synthetic keydown in jsdom, so the editable is stubbed the
// same way the web composer tests stub it: a focusable div that forwards
// `onKeyDown`. What is under test is the wrapper's ordering — host first,
// then typeaheads, then the Enter-submit rule that only exists when a host
// wires `onSubmit`.
import { act, createRef } from 'react';
import type * as ReactNs from 'react';
import { createRoot, type Root } from 'react-dom/client';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = <T,>(value: T): T => {
    const cloned: unknown = JSON.parse(JSON.stringify(value));
    return cloned as T;
  };
}

jest.mock('../SlateEditor', () => {
  const react = jest.requireActual<typeof ReactNs>('react');
  return {
    __esModule: true,
    DEFAULT_CONTAINER_CLASS_NAME: '',
    SlateEditor: react.forwardRef(
      (
        props: {
          dataTestId?: string;
          onKeyDown?: (event: unknown) => void;
        },
        ref: ReactNs.ForwardedRef<{ focus: () => void }>,
      ) => {
        react.useImperativeHandle(ref, () => ({ focus: (): void => {} }));
        return react.createElement('div', {
          'data-testid': props.dataTestId ?? 'editable',
          tabIndex: 0,
          onKeyDown: props.onKeyDown,
        });
      },
    ),
  };
});

import { Transforms } from 'slate';
import { ComposerEditor, type ComposerEditorHandle } from '../ComposerEditor';
import { createChatEditor, serializeEditorValue } from '../slate-utils';
import type { FileMentionOption, SlashCommandOption } from '../../types';

function stubMatchMedia(coarse: boolean): void {
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

function mount(element: React.ReactElement): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

/** Dispatches a cancelable keydown on the editable; returns whether it was prevented. */
function pressKey(container: HTMLElement, key: string): boolean {
  const editable = container.querySelector<HTMLElement>(
    '[data-testid="editable"]',
  );
  let notPrevented = true;
  act(() => {
    notPrevented =
      editable?.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      ) ?? true;
  });
  return !notPrevented;
}

function pressEnter(container: HTMLElement): boolean {
  const editable = container.querySelector<HTMLElement>(
    '[data-testid="editable"]',
  );
  let notPrevented = true;
  act(() => {
    notPrevented =
      editable?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      ) ?? true;
  });
  return !notPrevented;
}

describe('ComposerEditor keys', () => {
  beforeEach(() => stubMatchMedia(false));
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('leaves Enter to the host when no onSubmit is wired', () => {
    const onKeyDown = jest.fn();
    const { container, root } = mount(
      <ComposerEditor dataTestId="editable" onKeyDown={onKeyDown} />,
    );
    const prevented = pressEnter(container);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(false);
    act(() => root.unmount());
  });

  it('submits the serialized draft on Enter with a fine pointer', () => {
    const onSubmit = jest.fn();
    const ref = createRef<ComposerEditorHandle>();
    const { container, root } = mount(
      <ComposerEditor ref={ref} dataTestId="editable" onSubmit={onSubmit} />,
    );
    act(() => {
      ref.current?.replaceDraft('hello there');
    });
    const prevented = pressEnter(container);
    expect(prevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello there' }),
    );
    act(() => root.unmount());
  });

  it('does not submit when the host already consumed the key', () => {
    const onSubmit = jest.fn();
    const { container, root } = mount(
      <ComposerEditor
        dataTestId="editable"
        onSubmit={onSubmit}
        onKeyDown={(event): void => event.preventDefault()}
      />,
    );
    const prevented = pressEnter(container);
    expect(prevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('leaves Escape alone over a lingering slash draft when the host owns the slash flow', () => {
    // Desktop passes no `fetchSlashCommands`: its composer menu owns `/`. A
    // `/` left in the draft after that menu closed must not make the editor's
    // own slash tracker swallow the next Escape.
    const editor = createChatEditor();
    editor.children = [{ type: 'paragraph', children: [{ text: '/rev' }] }];
    Transforms.select(editor, { path: [0, 0], offset: 4 });
    const { container, root } = mount(
      <ComposerEditor
        dataTestId="editable"
        editor={editor}
        value={editor.children}
        onChange={(): void => {}}
      />,
    );
    expect(pressKey(container, 'Escape')).toBe(false);
    act(() => root.unmount());
  });

  it('handles Escape over a slash draft when the host supplies a catalog', () => {
    const editor = createChatEditor();
    editor.children = [{ type: 'paragraph', children: [{ text: '/rev' }] }];
    Transforms.select(editor, { path: [0, 0], offset: 4 });
    const { container, root } = mount(
      <ComposerEditor
        dataTestId="editable"
        editor={editor}
        value={editor.children}
        onChange={(): void => {}}
        fetchSlashCommands={(): Promise<never[]> => Promise.resolve([])}
      />,
    );
    expect(pressKey(container, 'Escape')).toBe(true);
    act(() => root.unmount());
  });

  it('completes the highlighted slash command on Tab without submitting', async () => {
    const editor = createChatEditor();
    editor.children = [{ type: 'paragraph', children: [{ text: '/rev' }] }];
    Transforms.select(editor, { path: [0, 0], offset: 4 });
    const onSubmit = jest.fn();
    const { container, root } = mount(
      <ComposerEditor
        dataTestId="editable"
        editor={editor}
        value={editor.children}
        onChange={(): void => {}}
        onSubmit={onSubmit}
        fetchSlashCommands={(): Promise<SlashCommandOption[]> =>
          Promise.resolve([{ name: 'review', description: 'Inspect changes' }])
        }
      />,
    );
    // Let the catalog fetch resolve and the menu re-render with its rows.
    await act(async () => {
      await Promise.resolve();
    });
    expect(pressKey(container, 'Tab')).toBe(true);
    expect(serializeEditorValue(editor.children).text).toBe('/review ');
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('inserts the highlighted @ file on Tab without submitting', async () => {
    const editor = createChatEditor();
    editor.children = [{ type: 'paragraph', children: [{ text: '@read' }] }];
    Transforms.select(editor, { path: [0, 0], offset: 5 });
    const onSubmit = jest.fn();
    const readme: FileMentionOption = {
      repoId: 'repo-1',
      repoName: 'Workspace',
      relativePath: 'README.md',
      filename: 'README.md',
      absolutePath: '/workspace/README.md',
    };
    const { container, root } = mount(
      <ComposerEditor
        dataTestId="editable"
        editor={editor}
        value={editor.children}
        onChange={(): void => {}}
        onSubmit={onSubmit}
        searchFileMentions={(): Promise<FileMentionOption[]> =>
          Promise.resolve([readme])
        }
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(pressKey(container, 'Tab')).toBe(true);
    expect(serializeEditorValue(editor.children).fileReferences).toEqual([
      expect.objectContaining({ absolutePath: '/workspace/README.md' }),
    ]);
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('keeps Enter as a line break on a coarse pointer', () => {
    stubMatchMedia(true);
    const onSubmit = jest.fn();
    const ref = createRef<ComposerEditorHandle>();
    const { container, root } = mount(
      <ComposerEditor ref={ref} dataTestId="editable" onSubmit={onSubmit} />,
    );
    act(() => {
      ref.current?.replaceDraft('two lines');
    });
    const prevented = pressEnter(container);
    expect(prevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});

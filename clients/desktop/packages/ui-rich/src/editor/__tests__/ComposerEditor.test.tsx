/**
 * @jest-environment jsdom
 */
// The one composer editor both hosts render (slice 3, PR 2). Web used to own
// this component as `PortalSlateEditor`; desktop drove the bare `SlateEditor`
// with its own density classes. The shared wrapper has to serve both: an
// internal, draft-owning editor for web, and a host-owned, controlled editor
// for desktop, with the density map applied in one place.
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Descendant } from 'slate';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  COMPOSER_DENSITY_CLASS_NAMES,
  ComposerEditor,
  createChatEditor,
  createEmptyValue,
  type ComposerEditorHandle,
} from '../index';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
// jsdom lacks structuredClone, which the empty-document factory uses.
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = <T,>(value: T): T => {
    const cloned: unknown = JSON.parse(JSON.stringify(value));
    return cloned as T;
  };
}

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

function unmount(container: HTMLDivElement, root: Root): void {
  act(() => root.unmount());
  container.remove();
}

describe('ComposerEditor', () => {
  beforeEach(() => stubMatchMedia(false));

  it('applies the requested density step to the container and editable', () => {
    const { container, root } = mount(
      <ComposerEditor density="compact" dataTestId="editor" />,
    );
    const editable = container.querySelector('[data-testid="editor"]');
    expect(editable?.className).toContain(
      COMPOSER_DENSITY_CLASS_NAMES.compact.editable,
    );
    expect(editable?.parentElement?.className).toBe(
      COMPOSER_DENSITY_CLASS_NAMES.compact.container,
    );
    unmount(container, root);
  });

  it('defaults to the comfortable step and lets a host override the container', () => {
    const { container, root } = mount(
      <ComposerEditor dataTestId="editor" containerClassName="custom pr-11" />,
    );
    const editable = container.querySelector('[data-testid="editor"]');
    expect(editable?.className).toContain(
      COMPOSER_DENSITY_CLASS_NAMES.comfortable.editable,
    );
    expect(editable?.parentElement?.className).toBe('custom pr-11');
    unmount(container, root);
  });

  it.each([
    ['without a host class', undefined, 'relative'],
    ['with a host class', 'pr-11', 'relative pr-11'],
  ])(
    'keeps its root and editable recordable %s',
    (_label, className, expectedClasses) => {
      const { container, root } = mount(
        <ComposerEditor
          dataTestId="editor"
          {...(className === undefined ? {} : { className })}
        />,
      );
      // The draft is blocked per paragraph inside the editable (see
      // SlateEditor); the root and the typeahead and slash menus record.
      expect(container.firstElementChild?.className).toBe(expectedClasses);
      expect(
        container
          .querySelector('[data-testid="editor"]')
          ?.closest(`.${REPLAY_BLOCK_CLASS}`),
      ).toBeNull();
      unmount(container, root);
    },
  );
  it('shows the placeholder without an entry animation', async () => {
    // Switching chats remounts the editor, so a fade on the placeholder
    // blinked it in on every switch.
    const { container, root } = mount(
      <ComposerEditor dataTestId="editor" placeholder="Ask anything" />,
    );
    // Slate reveals the placeholder on the next tick.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const placeholder = container.querySelector('[data-slate-placeholder]');
    expect(placeholder?.textContent).toBe('Ask anything');
    expect(placeholder?.outerHTML).not.toContain('animate-');
    unmount(container, root);
  });

  it('runs a host-owned editor in controlled mode and exposes it on the handle', () => {
    const editor = createChatEditor();
    const value: Descendant[] = createEmptyValue();
    const onChange = jest.fn();
    const ref = createRef<ComposerEditorHandle>();
    const { container, root } = mount(
      <ComposerEditor
        ref={ref}
        editor={editor}
        value={value}
        onChange={onChange}
        dataTestId="editor"
      />,
    );
    expect(ref.current?.editor).toBe(editor);
    act(() => {
      ref.current?.insertSlashCommand('/review ');
    });
    expect(onChange).toHaveBeenCalled();
    expect(ref.current?.serialize().text).toBe('/review ');
    unmount(container, root);
  });
});

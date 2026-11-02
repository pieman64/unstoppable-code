/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueuedEditComposerSlot } from '../QueuedEditComposerSlot';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function Editor(): JSX.Element {
  return <textarea data-testid="editor" />;
}

function Composer(): JSX.Element {
  return (
    <div
      data-testid="composer"
      contentEditable
      suppressContentEditableWarning
      tabIndex={0}
    >
      my draft
    </div>
  );
}

function render(root: Root, editing: boolean): void {
  act(() => {
    root.render(
      <QueuedEditComposerSlot editor={editing ? <Editor /> : null}>
        <Composer />
      </QueuedEditComposerSlot>,
    );
  });
}

function selectionChanged(): void {
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
}

describe('QueuedEditComposerSlot', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('hides the composer while editing and keeps it mounted', () => {
    render(root, false);
    const composer = container.querySelector('[data-testid="composer"]');
    render(root, true);
    expect(container.querySelector('[data-testid="editor"]')).toBeInstanceOf(
      HTMLElement,
    );
    expect(container.querySelector('[data-testid="composer"]')).toBe(composer);
    expect(
      composer?.closest('[data-queued-edit-hidden="true"]'),
    ).toBeInstanceOf(HTMLElement);
  });

  it('returns focus to the composer with its caret where it was', () => {
    render(root, false);
    const composer = container.querySelector<HTMLElement>(
      '[data-testid="composer"]',
    );
    const text = composer?.firstChild;
    if (!composer || !(text instanceof Text)) throw new Error('no draft text');
    // The caret sits inside the draft, after "my ".
    composer.focus();
    const selection = document.getSelection();
    selection?.collapse(text, 3);
    selectionChanged();

    render(root, true);
    // Typing in the editor moves the selection out of the composer.
    const editor = container.querySelector<HTMLElement>(
      '[data-testid="editor"]',
    );
    act(() => editor?.focus());
    selection?.collapse(editor ?? null, 0);
    selectionChanged();

    render(root, false);
    expect(document.activeElement).toBe(composer);
    expect(selection?.anchorNode).toBe(text);
    expect(selection?.anchorOffset).toBe(3);
  });

  it('leaves focus alone when the edit ends while focus is elsewhere', () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    render(root, false);
    render(root, true);
    act(() => outside.focus());
    render(root, false);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

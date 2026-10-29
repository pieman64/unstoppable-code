/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Descendant } from 'slate';
import { EDITOR_TO_ELEMENT } from 'slate-dom';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  createChatEditor,
  DEFAULT_CONTAINER_CLASS_NAME,
  SlateEditor,
} from '../editor';

describe('SlateEditor', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('ignores a queued blur after Slate has detached its DOM mapping', () => {
    const editor = createChatEditor();
    const value: Descendant[] = [
      { type: 'paragraph', children: [{ text: '' }] },
    ];
    act(() => {
      root.render(
        <SlateEditor
          editor={editor}
          value={value}
          placeholder="Type a message"
          onChange={(): void => undefined}
          dataTestId="test-editor"
        />,
      );
    });

    const editable = container.querySelector<HTMLElement>(
      '[data-testid="test-editor"]',
    );
    expect(editable).not.toBeNull();
    expect(EDITOR_TO_ELEMENT.has(editor)).toBe(true);

    // Slate clears this weak-map entry while unmounting. A browser blur that
    // was already queued can still reach Editable's React handler afterward.
    EDITOR_TO_ELEMENT.delete(editor);

    const reportedErrors: unknown[] = [];
    const handleError = (event: ErrorEvent): void => {
      reportedErrors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener('error', handleError);
    try {
      act(() => {
        editable?.dispatchEvent(
          new FocusEvent('focusout', { bubbles: true, relatedTarget: null }),
        );
      });
    } finally {
      window.removeEventListener('error', handleError);
    }

    expect(reportedErrors).toEqual([]);
  });

  it.each([
    ['the default container', undefined, DEFAULT_CONTAINER_CLASS_NAME],
    ['a host container', 'custom pr-11', 'custom pr-11'],
  ])(
    'keeps the editable recordable and blocks its content with %s class',
    (_label, containerClassName, expectedClasses) => {
      const value: Descendant[] = [
        { type: 'paragraph', children: [{ text: 'private draft' }] },
      ];
      act(() => {
        root.render(
          <SlateEditor
            editor={createChatEditor()}
            value={value}
            placeholder="Type a message"
            onChange={(): void => undefined}
            dataTestId="test-editor"
            {...(containerClassName === undefined
              ? {}
              : { containerClassName })}
          />,
        );
      });

      const editable = container.querySelector('[data-testid="test-editor"]');
      // The host's container classes are untouched.
      expect(editable?.parentElement?.className).toBe(expectedClasses);
      // Focus and clicks on the editable reach the recorder, so a window
      // whose only interaction is the composer still counts as active.
      expect(editable?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
      // Every node inside it is a placeholder, so the draft never records.
      const nodes = Array.from(editable?.children ?? []);
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) {
        expect(node.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
      }
      expect(editable?.textContent).toContain('private draft');
    },
  );
});

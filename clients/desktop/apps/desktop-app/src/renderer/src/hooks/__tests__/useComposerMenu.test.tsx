/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor, Transforms } from 'slate';
import { createChatEditor, serializeEditorValue } from '@canopy/ui-rich/editor';
import {
  useComposerMenu,
  type ComposerMenuController,
} from '../useComposerMenu';

jest.mock('slate-react', () => ({
  withReact: <T,>(editor: T): T => editor,
  ReactEditor: {
    toDOMNode: (): HTMLElement => document.body,
    focus: jest.fn(),
    blur: jest.fn(),
    isFocused: (): boolean => false,
  },
}));
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('one composer menu session', () => {
  function setup(): {
    editor: ReturnType<typeof createChatEditor>;
    readonly menu: ComposerMenuController;
    type: (text: string) => void;
    changeScope: () => void;
    setDollar: (dollar: boolean) => void;
    setRows: (rows: readonly string[]) => Promise<void>;
    key: (key: string, modifiers?: KeyboardEventInit) => boolean;
    close: () => void;
  } {
    const editor = createChatEditor();
    editor.children = [{ type: 'paragraph', children: [{ text: '' }] }];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let controller: ComposerMenuController;
    let dollar = true;
    let rows: readonly string[] = [];
    function Harness({ scope = 'first' }: { scope?: string }): JSX.Element {
      controller = useComposerMenu(editor, {
        enabled: true,
        dollar,
        scopeKey: scope,
        onChange: () => undefined,
      });
      return (
        <div onKeyDown={controller.handleKeyDown} tabIndex={0}>
          {/* The list the composer renders while open: one button per row. */}
          {controller.open && (
            <div ref={controller.menuRef}>
              {rows.map((id) => (
                <button
                  key={id}
                  id={id}
                  type="button"
                  data-action-row
                  data-completion-row
                />
              ))}
            </div>
          )}
        </div>
      );
    }
    act(() => root.render(<Harness />));
    return {
      editor,
      get menu(): ComposerMenuController {
        return controller;
      },
      type(text: string): void {
        act(() => {
          Transforms.select(editor, Editor.end(editor, []));
          Transforms.insertText(editor, text);
          root.render(<Harness />);
        });
      },
      changeScope(): void {
        act(() => root.render(<Harness scope="second" />));
      },
      setDollar(next: boolean): void {
        dollar = next;
        act(() => root.render(<Harness />));
      },
      async setRows(next: readonly string[]): Promise<void> {
        rows = next;
        act(() => {
          root.render(<Harness />);
        });
        // The hook reconciles the highlight from a MutationObserver, which
        // delivers after the commit; let that microtask run inside act.
        await act(async () => {
          await Promise.resolve();
        });
      },
      key(key: string, modifiers: KeyboardEventInit = {}): boolean {
        const event = new KeyboardEvent('keydown', {
          ...modifiers,
          key,
          bubbles: true,
          cancelable: true,
        });
        act(() => {
          container.firstElementChild?.dispatchEvent(event);
        });
        return event.defaultPrevented;
      },
      close(): void {
        act(() => root.unmount());
        container.remove();
      },
    };
  }
  it.each(['Enter', 'Tab', 'ArrowUp', 'ArrowDown'])(
    'does not swallow %s when there are no results',
    (key) => {
      const h = setup();
      try {
        h.type('@missing');
        expect(h.menu.open).toBe(true);
        expect(h.key(key)).toBe(false);
        expect(h.menu.open).toBe(false);
      } finally {
        h.close();
      }
    },
  );
  for (const trigger of ['/', '@', '$']) {
    it(`replaces only the ${trigger} range and keeps a trailing suffix`, () => {
      const h = setup();
      try {
        h.type(`Before ${trigger}readme`);
        expect(h.menu.open).toBe(true);
        expect(h.menu.variant).toBe(trigger === '@' ? 'add' : 'commands');
        act(() => {
          // RangeRefs follow concurrent editor operations outside the query.
          Transforms.insertText(h.editor, ' after', {
            at: Editor.end(h.editor, []),
          });
          h.menu.consumeTrigger();
          Transforms.insertText(h.editor, 'selected');
        });
        expect(serializeEditorValue(h.editor.children).text).toBe(
          'Before selected after',
        );
      } finally {
        h.close();
      }
    });
  }
  it('filters from continued typing and consumes the complete query', () => {
    const h = setup();
    try {
      h.type('Before /pack');
      h.type('age');
      expect(h.menu.query).toBe('package');
      act(() => h.menu.consumeTrigger());
      expect(serializeEditorValue(h.editor.children).text).toBe('Before ');
    } finally {
      h.close();
    }
  });
  it('opens plus without changing the draft and tracks only newly typed search', () => {
    const h = setup();
    try {
      h.type('Before ');
      act(() => h.menu.onOpenChange(true));
      expect(h.menu.variant).toBe('add');
      expect(h.menu.origin).toBe('toolbar');
      expect(serializeEditorValue(h.editor.children).text).toBe('Before ');
      h.type('package');
      expect(h.menu.query).toBe('package');
      act(() => h.menu.consumeTrigger());
      expect(serializeEditorValue(h.editor.children).text).toBe('Before ');
    } finally {
      h.close();
    }
  });
  it('separates a toolbar command from text on both sides', () => {
    const h = setup();
    try {
      h.type('BeforeAfter');
      act(() => {
        Transforms.select(h.editor, { path: [0, 0], offset: 6 });
        h.menu.onOpenChange(true);
        h.menu.insertCommandText('/review');
      });
      expect(serializeEditorValue(h.editor.children).text).toBe(
        'Before /review After',
      );
    } finally {
      h.close();
    }
  });
  it.each([false, true])(
    'preserves the draft when a plus action starts at a selection (expanded: %s)',
    (expanded) => {
      const h = setup();
      try {
        h.type('Keep this draft.');
        act(() => {
          Transforms.select(h.editor, {
            anchor: { path: [0, 0], offset: 4 },
            focus: { path: [0, 0], offset: expanded ? 9 : 4 },
          });
          h.menu.onOpenChange(true);
        });
        act(() => h.menu.consumeTrigger());
        expect(serializeEditorValue(h.editor.children).text).toBe(
          'Keep this draft.',
        );
      } finally {
        h.close();
      }
    },
  );
  it('changes catalogs as typed triggers change and resets to Add from the toolbar', () => {
    const h = setup();
    try {
      h.type('/');
      expect(h.menu.variant).toBe('commands');
      h.type(' @');
      expect(h.menu.variant).toBe('add');
      expect(h.menu.origin).toBe('editor');
      h.type(' /');
      expect(h.menu.variant).toBe('commands');
      act(() => h.menu.onOpenChange(false));
      act(() => h.menu.onOpenChange(true));
      expect(h.menu.variant).toBe('add');
    } finally {
      h.close();
    }
  });

  it('dismisses without deleting draft text or reopening the same query', () => {
    const h = setup();
    try {
      h.type('Before @readme');
      act(() => h.menu.onOpenChange(false));
      expect(h.menu.open).toBe(false);
      expect(serializeEditorValue(h.editor.children).text).toBe(
        'Before @readme',
      );
    } finally {
      h.close();
    }
  });
  it('inserts a typed prompt reference with its metadata', () => {
    const h = setup();
    try {
      h.type('Use @review');
      act(() =>
        h.menu.insertFile(
          {
            repoId: 'notes',
            repoName: 'Notes',
            filename: 'Review',
            relativePath: 'review.md',
            absolutePath: '/data/review.md',
            kind: 'prompt',
          },
          1,
        ),
      );
      const value = serializeEditorValue(h.editor.children);
      expect(value.text).not.toContain('@review');
      expect(value.fileReferences).toEqual([
        expect.objectContaining({
          absolutePath: '/data/review.md',
          displayPath: 'Prompt: Review',
          kind: 'prompt',
        }),
      ]);
    } finally {
      h.close();
    }
  });
  it.each(['Enter', 'Tab'])(
    'activates the hovered row on %s when the keyboard has no highlight',
    (key) => {
      const h = setup();
      try {
        h.type('/');
        expect(h.menu.open).toBe(true);
        const menu = document.createElement('div');
        const first = document.createElement('button');
        first.id = 'row-first';
        first.setAttribute('data-action-row', 'true');
        first.setAttribute('data-completion-row', 'true');
        const second = document.createElement('button');
        second.id = 'row-second';
        second.setAttribute('data-action-row', 'true');
        second.setAttribute('data-completion-row', 'true');
        menu.append(first, second);
        document.body.append(menu);
        const firstClick = jest.fn();
        const secondClick = jest.fn();
        first.addEventListener('click', firstClick);
        second.addEventListener('click', secondClick);
        h.menu.menuRef.current = menu;
        act(() => h.menu.setActiveId(null));

        // Pointer hover cleared the keyboard highlight; the key must follow the
        // row the user sees hovered, not the first row.
        act(() => h.menu.setHoveredId('row-second'));
        expect(h.key(key)).toBe(true);
        expect(secondClick).toHaveBeenCalledTimes(1);
        expect(firstClick).not.toHaveBeenCalled();

        // Keyboard highlight wins over hover.
        act(() => h.menu.setActiveId('row-first'));
        h.key(key);
        expect(firstClick).toHaveBeenCalledTimes(1);

        // No highlight and no hover: the first enabled row.
        act(() => h.menu.setActiveId(null));
        act(() => h.menu.setHoveredId(null));
        h.key(key);
        expect(firstClick).toHaveBeenCalledTimes(2);
        menu.remove();
      } finally {
        h.close();
      }
    },
  );

  describe('Tab completion', () => {
    /** Counts clicks on the rendered rows, keyed by row id. */
    function trackClicks(ids: readonly string[]): Map<string, jest.Mock> {
      const clicks = new Map<string, jest.Mock>();
      for (const id of ids) {
        const click = jest.fn();
        document.getElementById(id)?.addEventListener('click', click);
        clicks.set(id, click);
      }
      return clicks;
    }

    it.each(['/', '@', '$'])(
      'completes the highlighted row of a typed %s session',
      async (trigger) => {
        const h = setup();
        try {
          await h.setRows(['row-a', 'row-b']);
          h.type(`Before ${trigger}rev`);
          expect(h.menu.open).toBe(true);
          expect(h.menu.origin).toBe('editor');
          const clicks = trackClicks(['row-a', 'row-b']);
          act(() => h.menu.setActiveId('row-b'));
          expect(h.key('Tab')).toBe(true);
          expect(clicks.get('row-b')).toHaveBeenCalledTimes(1);
          expect(clicks.get('row-a')).not.toHaveBeenCalled();
        } finally {
          h.close();
        }
      },
    );

    it.each<[string, KeyboardEventInit]>([
      ['Shift', { shiftKey: true }],
      ['Control', { ctrlKey: true }],
      ['Alt', { altKey: true }],
      ['Meta', { metaKey: true }],
    ])(
      'leaves %s+Tab to focus navigation and closes the menu',
      async (_name, modifiers) => {
        const h = setup();
        try {
          await h.setRows(['row-a']);
          h.type('/rev');
          expect(h.menu.open).toBe(true);
          const clicks = trackClicks(['row-a']);
          expect(h.key('Tab', modifiers)).toBe(false);
          expect(clicks.get('row-a')).not.toHaveBeenCalled();
          expect(h.menu.open).toBe(false);
          expect(serializeEditorValue(h.editor.children).text).toBe('/rev');
        } finally {
          h.close();
        }
      },
    );

    it('skips action rows and completes the first suggestion', async () => {
      const h = setup();
      try {
        await h.setRows(['attach', 'file-a', 'file-b']);
        h.type('@');
        document
          .getElementById('attach')
          ?.removeAttribute('data-completion-row');
        expect(h.menu.open).toBe(true);
        const clicks = trackClicks(['attach', 'file-a', 'file-b']);
        act(() => h.menu.setActiveId('attach'));
        expect(h.key('Tab')).toBe(true);
        expect(clicks.get('attach')).not.toHaveBeenCalled();
        expect(clicks.get('file-a')).toHaveBeenCalledTimes(1);
        expect(clicks.get('file-b')).not.toHaveBeenCalled();
      } finally {
        h.close();
      }
    });

    it('leaves Tab to focus navigation when only action rows are listed', async () => {
      const h = setup();
      try {
        await h.setRows(['attach']);
        h.type('@');
        document
          .getElementById('attach')
          ?.removeAttribute('data-completion-row');
        const clicks = trackClicks(['attach']);
        expect(h.key('Tab')).toBe(false);
        expect(clicks.get('attach')).not.toHaveBeenCalled();
        expect(h.menu.open).toBe(false);
      } finally {
        h.close();
      }
    });

    it('keeps Tab as focus navigation in a toolbar + session', async () => {
      const h = setup();
      try {
        await h.setRows(['row-a']);
        h.type('Keep this draft ');
        act(() => h.menu.onOpenChange(true));
        expect(h.menu.origin).toBe('toolbar');
        const clicks = trackClicks(['row-a']);
        expect(h.key('Tab')).toBe(false);
        expect(clicks.get('row-a')).not.toHaveBeenCalled();
        expect(h.menu.open).toBe(false);
      } finally {
        h.close();
      }
    });
  });

  it('separates a plugin pill from preceding text so the sent token stays a word', () => {
    const h = setup();
    try {
      h.type('Use the tools');
      act(() =>
        h.menu.insertPlugin({
          marketplaceId: 'demo/market',
          pluginName: 'delta-tool',
          label: 'delta-tool',
        }),
      );
      expect(serializeEditorValue(h.editor.children).text).toBe(
        'Use the tools delta-tool ',
      );
    } finally {
      h.close();
    }
  });

  it('inserts a whole-plugin mention pill and consumes the @ trigger', () => {
    const h = setup();
    try {
      h.type('Use @delta');
      expect(h.menu.open).toBe(true);
      act(() =>
        h.menu.insertPlugin({
          marketplaceId: 'demo/market',
          pluginName: 'market-delta-tool',
          label: 'Market Delta Tool',
        }),
      );
      const value = serializeEditorValue(h.editor.children);
      expect(value.text).toBe('Use Market Delta Tool ');
      expect(value.fileReferences).toEqual([
        expect.objectContaining({
          displayPath: 'Market Delta Tool',
          absolutePath: 'plugin://demo%2Fmarket/market-delta-tool',
          kind: 'plugin',
        }),
      ]);
    } finally {
      h.close();
    }
  });
  it('ignores email addresses and closes when the composer target changes', () => {
    const h = setup();
    try {
      h.type('user@example.com');
      expect(h.menu.open).toBe(false);
      h.type(' /');
      expect(h.menu.open).toBe(true);
      h.changeScope();
      expect(h.menu.open).toBe(false);
    } finally {
      h.close();
    }
  });
  it('keeps a / session across a harness change and only drops $ while it is not a trigger', () => {
    // A harness switch changes `dollar` but not the target scope: a typed `/`
    // stays open on the same session, while a `$` session closes only for as
    // long as `$` is not a trigger, without being marked dismissed.
    const h = setup();
    try {
      h.type('/rev');
      expect(h.menu.open).toBe(true);
      h.setDollar(false);
      expect(h.menu.open).toBe(true);
      expect(h.menu.query).toBe('rev');
      h.setDollar(true);
      expect(h.menu.open).toBe(true);
      h.key('Escape');
      expect(h.menu.open).toBe(false);
      h.type(' $sk');
      expect(h.menu.open).toBe(true);
      h.setDollar(false);
      expect(h.menu.open).toBe(false);
      h.setDollar(true);
      expect(h.menu.open).toBe(true);
      expect(h.menu.query).toBe('sk');
    } finally {
      h.close();
    }
  });
  it('moves the highlight to the first row when the active row leaves a re-projected list', async () => {
    const h = setup();
    try {
      await h.setRows(['row-claude-a', 'row-claude-b']);
      h.type('/');
      expect(h.menu.open).toBe(true);
      expect(h.menu.activeId).toBe('row-claude-a');
      // The highlighted row survives a change that keeps it listed.
      await h.setRows(['row-claude-b', 'row-claude-a']);
      expect(h.menu.activeId).toBe('row-claude-a');
      // The old first command is absent from the new harness's rows.
      await h.setRows(['row-cursor-a', 'row-cursor-b']);
      expect(h.menu.activeId).toBe('row-cursor-a');
      expect(document.body.getAttribute('aria-activedescendant')).toBe(
        'row-cursor-a',
      );
      // A cleared (hover) highlight is not re-imposed by a row change, even
      // through an empty list.
      act(() => h.menu.setActiveId(null));
      await h.setRows(['row-cursor-b']);
      expect(h.menu.activeId).toBeNull();
      await h.setRows([]);
      await h.setRows(['row-cursor-c']);
      expect(h.menu.activeId).toBeNull();
    } finally {
      h.close();
    }
  });
  it('re-arms a dismissed $ session once $ is a trigger again', () => {
    // A harness round trip (Codex → Claude → Codex) makes `$` a trigger again.
    // The session the user dismissed under Codex re-arms like a freshly typed
    // trigger, the same way the open `$` session above reopens; the dismissal
    // was tied to a trigger that stopped existing in between.
    const h = setup();
    try {
      h.type('$sk');
      expect(h.menu.open).toBe(true);
      h.key('Escape');
      expect(h.menu.open).toBe(false);
      h.setDollar(false);
      expect(h.menu.open).toBe(false);
      h.setDollar(true);
      expect(h.menu.open).toBe(true);
      expect(h.menu.query).toBe('sk');
    } finally {
      h.close();
    }
  });
  it('restores the highlight after a re-projection that passes through an empty list', async () => {
    // A harness switch clears the inventory before the next one loads, so the
    // rows go from the old harness's row to none to the new harness's row.
    const h = setup();
    try {
      await h.setRows(['row-claude-a', 'row-claude-b']);
      h.type('/');
      expect(h.menu.activeId).toBe('row-claude-a');
      await h.setRows([]);
      expect(h.menu.activeId).toBeNull();
      await h.setRows(['row-cursor-a']);
      expect(h.menu.activeId).toBe('row-cursor-a');
      expect(document.body.getAttribute('aria-activedescendant')).toBe(
        'row-cursor-a',
      );
    } finally {
      h.close();
    }
  });
  it('highlights the first row that arrives in a session opened before any row loaded', async () => {
    const h = setup();
    try {
      h.type('/');
      expect(h.menu.open).toBe(true);
      expect(h.menu.activeId).toBeNull();
      await h.setRows(['row-late-a', 'row-late-b']);
      expect(h.menu.activeId).toBe('row-late-a');
    } finally {
      h.close();
    }
  });
});

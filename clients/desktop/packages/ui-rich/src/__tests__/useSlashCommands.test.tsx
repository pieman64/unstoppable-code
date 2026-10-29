/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createEditor, Transforms } from 'slate';
import {
  useSlashCommands,
  type UseSlashCommandsResult,
} from '../plugins/useSlashCommands';
import type { ChatEditor, SlashCommandOption } from '../types';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('composer command search', () => {
  const commands: SlashCommandOption[] = [
    {
      name: 'linear:create-issue',
      description: 'Create a ticket',
      category: 'Linear',
      namespace: 'linear',
    },
    {
      name: 'linear:list-projects',
      description: 'Browse projects',
      category: 'Linear',
      namespace: 'linear',
    },
    { name: 'review', description: 'Inspect changes' },
  ];
  let editor: ChatEditor;
  let result: UseSlashCommandsResult;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let enabled = true;
  function Harness(): null {
    result = useSlashCommands(editor, { commands, enabled });
    return null;
  }
  function render(text: string): void {
    editor.children = [{ type: 'paragraph', children: [{ text }] }];
    Transforms.select(editor, { path: [0, 0], offset: text.length });
    act(() => root.render(<Harness />));
  }
  beforeEach(() => {
    enabled = true;
    editor = createEditor();
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => act(() => root.unmount()));
  it('finds capabilities by description and fuzzy command name', () => {
    render('/ticket');
    expect(result.filteredCommands.map((command) => command.name)).toEqual([
      'linear:create-issue',
    ]);
    render('/rvw');
    expect(result.filteredCommands.map((command) => command.name)).toEqual([
      'review',
    ]);
  });
  it('scopes plugin search and returns to the full command index', () => {
    render('Keep this /linear');
    expect(result.namespace).toBe('linear');
    expect(result.filteredCommands).toHaveLength(2);
    render('/linear:ticket');
    expect(result.filteredCommands.map((command) => command.name)).toEqual([
      'linear:create-issue',
    ]);
    act(() => result.backToCommands());
    expect(editor.children).toEqual([
      { type: 'paragraph', children: [{ text: '/' }] },
    ]);
  });
  it('replaces only the active trigger, preserving surrounding draft text', () => {
    render('Before /review after');
    Transforms.select(editor, {
      path: [0, 0],
      offset: 'Before /review'.length,
    });
    act(() => root.render(<Harness />));
    act(() => result.selectCommand(commands[2]));
    expect(editor.children).toEqual([
      { type: 'paragraph', children: [{ text: 'Before /review  after' }] },
    ]);
  });
  it('detects no trigger and handles no keys when disabled', () => {
    enabled = false;
    render('/review');
    expect(result.isOpen).toBe(false);
    expect(result.filteredCommands).toEqual([]);
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
    });
    let handled = true;
    act(() => {
      handled = result.onKeyDown(
        escape as unknown as React.KeyboardEvent<HTMLDivElement>,
      );
    });
    expect(handled).toBe(false);
    expect(escape.defaultPrevented).toBe(false);
  });

  it('dismisses an empty search with Escape', () => {
    render('/zzzz');
    const preventDefault = jest.fn();
    act(() => {
      result.onKeyDown({ key: 'Escape', preventDefault } as never);
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(result.isOpen).toBe(false);
  });
});

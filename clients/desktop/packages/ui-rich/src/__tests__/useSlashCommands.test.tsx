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

function key(name: string): never {
  return { key: name, preventDefault: jest.fn() } as never;
}

describe('composer command search', () => {
  const baseCommands: SlashCommandOption[] = [
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
  let commands = baseCommands;
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
    commands = baseCommands;
    editor = createEditor();
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => act(() => root.unmount()));
  it('finds capabilities by description and one-edit command name', () => {
    render('/ticket');
    expect(result.filteredCommands.map((command) => command.name)).toEqual([
      'linear:create-issue',
    ]);
    render('/reveiw');
    expect(result.filteredCommands.map((command) => command.name)).toEqual([
      'review',
    ]);
    render('/rvw');
    expect(result.filteredCommands).toEqual([]);
  });
  it('ranks a bare plugin name globally and scopes only an explicit prefix', () => {
    render('Keep this /linear');
    expect(result.namespace).toBeNull();
    expect(result.filteredCommands).toHaveLength(2);
    render('/linear:');
    expect(result.namespace).toBe('linear');
    expect(result.filteredCommands).toHaveLength(2);
    expect(result.hiddenCount).toBe(0);
    render('/unknown:');
    expect(result.namespace).toBeNull();
    render('/linear:ticket');
    expect(result.filteredCommands.map((command) => command.name)).toEqual([
      'linear:create-issue',
    ]);
    expect(result.namespace).toBe('linear');
    act(() => result.backToCommands());
    expect(editor.children).toEqual([
      { type: 'paragraph', children: [{ text: '/' }] },
    ]);
    render('/');
    expect(result.namespace).toBeNull();
    expect(result.filteredCommands).toHaveLength(3);
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

  describe('capped typed results', () => {
    const many = (count: number, group: string): SlashCommandOption[] =>
      Array.from({ length: count }, (_, index) => ({
        name: `deploy-${group}-${index}`,
        menuGroup: group,
      }));

    it('caps typed results, offers Show all, and browses empty queries uncapped', () => {
      commands = [...many(6, 'Skills'), ...many(6, 'Actions')];
      render('/');
      expect(result.filteredCommands).toHaveLength(12);
      expect(result.hiddenCount).toBe(0);
      render('/deploy');
      expect(result.filteredCommands.map((command) => command.name)).toEqual(
        [...commands.slice(0, 5), ...commands.slice(6, 9)].map(
          (command) => command.name,
        ),
      );
      expect(result.hiddenCount).toBe(4);
      expect(result.totalCount).toBe(12);
    });

    it('CAN-5271 follows interleaved relevance order through arrows and Show all safely', () => {
      commands = Array.from({ length: 12 }, (_, index) => ({
        name: `deploy-${String(index).padStart(2, '0')}`,
        menuGroup: index % 2 === 0 ? 'Skills' : 'Actions',
      }));
      render('/deploy');
      const visible = commands.slice(0, 8);
      expect(result.filteredCommands).toEqual(visible);
      for (const command of visible) {
        expect(result.selectedCommand).toBe(command);
        act(() => void result.onKeyDown(key('ArrowDown')));
      }
      expect(result.isShowAllSelected).toBe(true);
      act(() => void result.onKeyDown(key('Tab')));
      expect(result.hiddenCount).toBe(4);
      expect(editor.children).toEqual([
        { type: 'paragraph', children: [{ text: '/deploy' }] },
      ]);
      act(() => void result.onKeyDown(key('Enter')));
      expect(result.filteredCommands).toEqual(commands);
      expect(result.selectedCommand).toBe(commands[8]);
      expect(editor.children).toEqual([
        { type: 'paragraph', children: [{ text: '/deploy' }] },
      ]);
      act(() => void result.onKeyDown(key('ArrowUp')));
      expect(result.selectedCommand).toBe(commands[7]);
    });

    it('shows five rows plus Show all for a single group of six', () => {
      commands = many(6, 'Skills');
      render('/deploy');
      expect(result.filteredCommands).toHaveLength(5);
      expect(result.hiddenCount).toBe(1);
      for (let step = 0; step < 5; step += 1) {
        act(() => void result.onKeyDown(key('ArrowDown')));
      }
      expect(result.isShowAllSelected).toBe(true);
      expect(result.selectedCommand).toBeNull();
      // Wraps from Show all back to the first command.
      act(() => void result.onKeyDown(key('ArrowDown')));
      expect(result.selectedIndex).toBe(0);
    });

    it('does not render Show all when nothing is hidden', () => {
      commands = many(5, 'Skills');
      render('/deploy');
      expect(result.hiddenCount).toBe(0);
      act(() => void result.onKeyDown(key('ArrowUp')));
      expect(result.isShowAllSelected).toBe(false);
      expect(result.selectedIndex).toBe(4);
    });

    it('expands with Enter on Show all, selecting the first hidden row', () => {
      commands = [...many(6, 'Skills'), ...many(6, 'Actions')];
      render('/deploy');
      act(() => void result.onKeyDown(key('ArrowUp')));
      expect(result.isShowAllSelected).toBe(true);
      const before = JSON.stringify(editor.children);
      act(() => void result.onKeyDown(key('Enter')));
      expect(JSON.stringify(editor.children)).toBe(before);
      expect(result.isOpen).toBe(true);
      expect(result.hiddenCount).toBe(0);
      expect(result.filteredCommands).toHaveLength(12);
      expect(result.selectedCommand?.name).toBe('deploy-Skills-5');
      act(() => void result.onKeyDown(key('ArrowDown')));
      expect(result.selectedCommand?.name).toBe('deploy-Actions-0');
    });

    it('consumes Tab on Show all without expanding or inserting', () => {
      commands = many(6, 'Skills');
      render('/deploy');
      act(() => void result.onKeyDown(key('ArrowUp')));
      const tab = key('Tab');
      let handled = false;
      act(() => {
        handled = result.onKeyDown(tab);
      });
      expect(handled).toBe(true);
      expect(result.hiddenCount).toBe(1);
      expect(editor.children).toEqual([
        { type: 'paragraph', children: [{ text: '/deploy' }] },
      ]);
    });

    it('expands through showAll and resets on query change and close', () => {
      commands = many(7, 'Skills');
      render('/deploy');
      act(() => result.showAll());
      expect(result.filteredCommands).toHaveLength(7);
      expect(result.selectedIndex).toBe(5);
      render('/deploy-');
      expect(result.hiddenCount).toBe(2);
      expect(result.selectedIndex).toBe(0);
      act(() => result.showAll());
      act(() => result.close());
      render('/deploy');
      expect(result.hiddenCount).toBe(2);
    });

    it('does not restore expansion when returning to an earlier query', () => {
      commands = many(7, 'Skills');
      render('/deploy');
      act(() => result.showAll());
      render('/deploy-');
      render('/deploy');
      expect(result.filteredCommands).toHaveLength(5);
      expect(result.hiddenCount).toBe(2);
    });

    it('clamps selection when asynchronous results shrink', () => {
      commands = many(7, 'Skills');
      render('/deploy');
      act(() => result.showAll());
      act(() => void result.onKeyDown(key('ArrowUp')));
      expect(result.selectedIndex).toBe(4);
      commands = many(2, 'Skills');
      act(() => root.render(<Harness />));
      expect(result.selectedIndex).toBe(1);
      expect(result.selectedCommand?.name).toBe('deploy-Skills-1');
    });
  });
});

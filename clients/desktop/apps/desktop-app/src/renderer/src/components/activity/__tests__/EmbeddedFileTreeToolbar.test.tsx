/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EmbeddedFileTreeToolbar } from '../EmbeddedFileTreeToolbar';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

describe('EmbeddedFileTreeToolbar overflow menu', () => {
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

  function openMenu(mode: 'file' | 'diff', onRefresh = jest.fn()): void {
    act(() => {
      root.render(
        <EmbeddedFileTreeToolbar
          mode={mode}
          onModeChange={jest.fn()}
          searchOpen={false}
          onToggleSearch={jest.fn()}
          onFocusFile={jest.fn()}
          onRefresh={onRefresh}
          onCollapseAll={jest.fn()}
          onNewFile={jest.fn()}
          onNewFolder={jest.fn()}
        />,
      );
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="File tree actions"]')
        ?.click();
    });
  }

  function rowTestIds(): (string | null)[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).map((row) => row.getAttribute('data-testid'));
  }

  it('groups create rows above the view rows, each with an icon', () => {
    openMenu('file');
    expect(rowTestIds()).toEqual([
      'files-tree-new-file',
      'files-tree-new-folder',
      'files-tree-refresh',
      'files-tree-collapse-all',
    ]);
    for (const row of Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    )) {
      expect(row.querySelector('span[aria-hidden="true"] svg')).not.toBeNull();
    }
    expect(
      document
        .querySelector('[data-testid="files-tree-refresh"]')
        ?.previousElementSibling?.getAttribute('role'),
    ).toBe('separator');
  });

  it('omits the create rows in diff mode', () => {
    openMenu('diff');
    expect(rowTestIds()).toEqual([
      'files-tree-refresh',
      'files-tree-collapse-all',
    ]);
  });

  it('runs a row and closes the menu', () => {
    const onRefresh = jest.fn();
    openMenu('diff', onRefresh);
    act(() => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="files-tree-refresh"]')
        ?.click();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
  });
});

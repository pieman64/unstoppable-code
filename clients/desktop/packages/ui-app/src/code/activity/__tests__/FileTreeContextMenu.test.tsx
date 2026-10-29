/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  FileTreeContextMenu,
  deriveFileTreeMenuItems,
  type FileTreeMenuOptions,
} from '../FileTreeContextMenu';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

const noop = (): void => undefined;

const everyRow: FileTreeMenuOptions = {
  targetKind: 'file',
  onNewFile: noop,
  onNewFolder: noop,
  onOpen: noop,
  onOpenToSide: noop,
  onOpenExternal: noop,
  openInApp: { appName: 'VS Code', iconSrc: 'data:,', onSelect: noop },
  onMention: noop,
  startPage: { isStartPage: false, onToggle: noop },
  onCut: noop,
  onCopy: noop,
  onPaste: noop,
  canPaste: false,
  onCopyPath: noop,
  onCopyAbsolutePath: noop,
  onRename: noop,
  openInFileManager: { label: 'Open in Finder', onSelect: noop },
  onDownload: noop,
  onDelete: noop,
};

describe('deriveFileTreeMenuItems', () => {
  it('orders every row into its group with Delete alone and last', () => {
    const items = deriveFileTreeMenuItems(everyRow);
    expect(
      items.map((item) => `${item.separatorBefore ? '| ' : ''}${item.key}`),
    ).toEqual([
      'new-file',
      'new-folder',
      '| open',
      'open-side',
      'open-external',
      'open-in-app',
      '| mention',
      'start-page',
      '| cut',
      'copy',
      'paste',
      '| copy-path',
      'copy-absolute-path',
      '| rename',
      '| open-in-file-manager',
      'download',
      '| delete',
    ]);
    expect(items.every((item) => item.icon !== undefined)).toBe(true);
    expect(items.find((item) => item.key === 'paste')?.disabled).toBe(true);
    expect(items.find((item) => item.key === 'open-in-app')?.label).toBe(
      'Open in VS Code',
    );
  });

  it('shows only the rows the host supplies callbacks for', () => {
    const items = deriveFileTreeMenuItems({
      targetKind: 'file',
      onOpen: noop,
      onCopyPath: noop,
    });
    expect(items.map((item) => item.key)).toEqual(['open', 'copy-path']);
    // Neighbouring one-row groups read as one section, not a divider per row.
    expect(items[1]?.separatorBefore).toBe(false);
  });

  it('gives a host with few actions a few sections, not a divider per row', () => {
    // The web host's file menu: create, then one row from each other group.
    const items = deriveFileTreeMenuItems({
      targetKind: 'file',
      onNewFile: noop,
      onNewFolder: noop,
      onOpen: noop,
      onMention: noop,
      onCopyPath: noop,
      onRename: noop,
      onDownload: noop,
      onDelete: noop,
    });
    expect(
      items.map((item) => `${item.separatorBefore ? '| ' : ''}${item.key}`),
    ).toEqual([
      'new-file',
      'new-folder',
      '| open',
      'mention',
      'copy-path',
      'rename',
      'download',
      '| delete',
    ]);
  });

  it('drops file-only and entry rows for folders and the background', () => {
    expect(
      deriveFileTreeMenuItems({ ...everyRow, targetKind: 'folder' }).map(
        (item) => item.key,
      ),
    ).toEqual([
      'new-file',
      'new-folder',
      'cut',
      'copy',
      'paste',
      'copy-path',
      'copy-absolute-path',
      'rename',
      'open-in-file-manager',
      'delete',
    ]);
    expect(
      deriveFileTreeMenuItems({ ...everyRow, targetKind: 'background' }).map(
        (item) => item.key,
      ),
    ).toEqual(['new-file', 'new-folder', 'paste']);
  });

  it('applies host labels and test ids over the defaults', () => {
    const items = deriveFileTreeMenuItems({
      targetKind: 'file',
      onMention: noop,
      onCopyPath: noop,
      labels: { mention: 'Send to chat' },
      testIds: { 'copy-path': 'files-tree-action-copy' },
    });
    expect(items.map((item) => [item.label, item.testId])).toEqual([
      ['Send to chat', 'files-tree-action-mention'],
      ['Copy relative path', 'files-tree-action-copy'],
    ]);
  });
});

describe('FileTreeContextMenu', () => {
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

  it('leads every row with an icon slot and shares one icon across a run', () => {
    act(() => {
      root.render(
        <FileTreeContextMenu x={10} y={10} onClose={noop} {...everyRow} />,
      );
    });
    const menu = document.querySelector(
      '[data-testid="files-tree-action-menu"]',
    );
    const rows = Array.from(
      menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    expect(rows).toHaveLength(17);
    for (const row of rows) {
      expect(row.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    }
    const hasIcon = (testId: string): boolean =>
      document.querySelector(
        `[data-testid="${testId}"] > span[aria-hidden="true"] svg`,
      ) !== null;
    expect(hasIcon('files-tree-action-open')).toBe(true);
    expect(hasIcon('files-tree-action-open-side')).toBe(false);
    expect(hasIcon('files-tree-action-open-in-app')).toBe(false);
    expect(hasIcon('files-tree-action-copy-path')).toBe(true);
    expect(hasIcon('files-tree-action-copy-absolute-path')).toBe(false);
    expect(rows.at(-1)?.textContent).toBe('Delete');
    const openInApp = document.querySelector(
      '[data-testid="files-tree-action-open-in-app"]',
    );
    expect(openInApp?.getAttribute('aria-label')).toBe('Open in VS Code');
    expect(openInApp?.querySelector('img')).toBeInstanceOf(Element);
  });

  it('runs the row and closes the menu', () => {
    const onRename = jest.fn();
    const onClose = jest.fn();
    act(() => {
      root.render(
        <FileTreeContextMenu
          x={10}
          y={10}
          onClose={onClose}
          targetKind="folder"
          onRename={onRename}
        />,
      );
    });
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="files-tree-action-rename"]',
        )
        ?.click();
    });
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });
});

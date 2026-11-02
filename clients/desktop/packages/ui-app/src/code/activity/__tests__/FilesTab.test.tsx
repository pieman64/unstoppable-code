/** @jest-environment jsdom */
import type { JSX } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { IconStyleProvider } from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  FilesTab,
  type FilesTabMutations,
  type FilesTabRoot,
} from '../FilesTab';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});

function mountFilesTab(node: JSX.Element): {
  container: HTMLElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

describe('FilesTab', () => {
  it('keeps saved badges, folder titles and paths distinct', () => {
    const opened = jest.fn();
    const { container, root } = mountFilesTab(
      <FilesTab
        entries={[
          {
            name: 'ses-a',
            isDir: true,
            secondaryLabel: 'Дослідження <script>long title</script>',
          },
        ]}
        currentDir="deliverables"
        onOpenDirectory={opened}
      />,
    );
    const button = container.querySelector<HTMLButtonElement>(
      '[data-path="deliverables/ses-a"]',
    );
    if (!button) throw new Error('Expected session row');
    expect(button.title).toBe(
      'ses-a — Дослідження <script>long title</script>',
    );
    expect(button.textContent).toContain('Дослідження');
    expect(button.querySelector('script')).toBeNull();
    act(() => button.click());
    expect(opened).toHaveBeenCalledWith('deliverables/ses-a');
    act(() => root.unmount());
    container.remove();
    const out = renderToString(
      <FilesTab
        entries={[
          { name: 'deliverables', isDir: true, savedCopy: true },
          { name: 'work', isDir: true },
        ]}
      />,
    );
    expect(out.match(/data-testid="file-tree-row-badge"/g)).toHaveLength(1);
    expect(out).toContain(
      'Saved copy from a completed turn; may differ from current working files',
    );
  });

  it('badges the current session folder beside its title like a saved copy', () => {
    const { container, root } = mountFilesTab(
      <FilesTab
        entries={[
          {
            name: 'ses-current',
            isDir: true,
            secondaryLabel: 'Current title',
            currentSession: true,
          },
          { name: 'ses-other', isDir: true, secondaryLabel: 'Other title' },
          { name: 'README.md', isDir: false },
        ]}
        currentDir="deliverables"
      />,
    );
    const rows: HTMLButtonElement[] = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-path^="deliverables/"]',
      ),
    );
    const badgeOf = (row: HTMLElement): string | null =>
      row.querySelector('[data-testid="file-tree-row-badge"]')?.textContent ??
      null;
    expect(rows.map(badgeOf)).toEqual(['This chat', null, null]);
    expect(
      rows[0].querySelector('[data-testid="file-tree-row-secondary-label"]')
        ?.textContent,
    ).toBe('Current title');
    expect(rows[0].title).toBe('ses-current — Current title');
    expect(rows[0].textContent).not.toContain('Saved copy');
    act(() => root.unmount());
    container.remove();
  });

  it('renders status above rows and suppresses default empty copy', () => {
    const out = renderToString(
      <FilesTab
        entries={[{ name: 'deliverables', isDir: true }]}
        statusBar={<div>Waking project…</div>}
      />,
    );
    expect(out).toContain('Waking project…');
    expect(out.indexOf('Waking project…')).toBeLessThan(
      out.indexOf('data-testid="activity-files"'),
    );
    expect(
      renderToString(
        <FilesTab entries={[]} statusBar={<div>Project is sleeping.</div>} />,
      ),
    ).not.toContain('No files loaded.');
  });

  it('renders saved-download provenance as a neutral notice', () => {
    const out = renderToString(
      <FilesTab
        entries={[]}
        downloadNotice="Downloading saved copy; it may differ from the working file."
      />,
    );
    expect(out).toContain('data-testid="activity-files-download-notice"');
    expect(out).not.toContain('fg-destructive');
  });

  it('renders an empty state when there are no entries', () => {
    expect(renderToString(<FilesTab entries={[]} />)).toContain(
      'data-testid="activity-files-empty"',
    );
  });

  it('renders directory and file rows', () => {
    const out = renderToString(
      <FilesTab
        entries={[
          { name: 'src', isDir: true },
          { name: 'README.md', isDir: false },
        ]}
      />,
    );
    expect(out).toContain('data-testid="activity-files"');
    expect(out).toContain('src');
    expect(out).toContain('README.md');
  });

  it('renders a host empty-state slot without losing the default behavior', () => {
    const out = renderToString(
      <FilesTab
        entries={[]}
        emptyState={<button type="button">Wake project</button>}
      />,
    );
    expect(out).toContain('Wake project');
    expect(out).not.toContain('No files loaded.');
  });

  it('replaces cached rows with a host recovery state', () => {
    const out = renderToString(
      <FilesTab
        entries={[{ name: 'stale.txt', isDir: false }]}
        emptyState={<button type="button">Retry</button>}
      />,
    );
    expect(out).toContain('Retry');
    expect(out).not.toContain('stale.txt');
    expect(out).not.toContain('data-testid="activity-files"');
  });

  it('offers the host download action on files only', () => {
    const out = renderToString(
      <FilesTab
        entries={[
          { name: 'src', isDir: true },
          { name: 'report.zip', isDir: false },
        ]}
        currentDir="out"
        onDownloadFile={(): void => {}}
      />,
    );
    const downloads = out.match(/data-testid="activity-files-download"/g) ?? [];
    expect(downloads).toHaveLength(1);
    expect(out).toContain('Download report.zip');
  });

  it('lets the host limit downloads to eligible root-relative paths', () => {
    const locator =
      'deliverables/.by-id/chat-a/22222222-2222-4222-8222-222222222222/report.pdf';
    const out = renderToString(
      <FilesTab
        entries={[
          { name: 'notes.txt', isDir: false },
          { name: 'report.pdf', isDir: false, relativePath: locator },
        ]}
        onDownloadFile={(): void => {}}
        canDownloadFile={(relativePath): boolean => relativePath === locator}
      />,
    );
    const downloads = out.match(/data-testid="activity-files-download"/g) ?? [];
    expect(downloads).toHaveLength(1);
    expect(out).toContain('Download report.pdf');
    expect(out).not.toContain('Download notes.txt');
  });

  it('renders no download affordance when the host provides no callback', () => {
    const out = renderToString(
      <FilesTab entries={[{ name: 'report.zip', isDir: false }]} />,
    );
    expect(out).not.toContain('data-testid="activity-files-download"');
  });

  it('downloads the root-relative path without opening the row', () => {
    const downloaded: string[] = [];
    let opened = 0;
    const { container, root } = mountFilesTab(
      <FilesTab
        entries={[{ name: 'report.zip', isDir: false }]}
        currentDir="out/nested"
        onOpenFile={(): void => {
          opened += 1;
        }}
        onDownloadFile={(path): void => {
          downloaded.push(path);
        }}
      />,
    );

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-files-download"]',
    );
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(downloaded).toEqual(['out/nested/report.zip']);
    // The action sits inside the row's hover overlay; a bubbled click must not
    // also open the file in the viewer.
    expect(opened).toBe(0);
    act(() => root.unmount());
    container.remove();
  });

  it('uses an exact locator while keeping the visible filename', () => {
    const selected: string[] = [];
    const locator =
      'deliverables/.by-id/chat-a/22222222-2222-4222-8222-222222222222/report.pdf';
    const { container, root } = mountFilesTab(
      <FilesTab
        entries={[{ name: 'report.pdf', isDir: false, relativePath: locator }]}
        workspaceLocalId="workspace"
        worktreeLocalId="worktree"
        fileRootLocalId="artifacts"
        onSelectFile={(selection): void => {
          if (selection.kind === 'file') {
            selected.push(selection.request.relativePath);
          }
        }}
      />,
    );
    expect(container.textContent).toContain('report.pdf');
    const row = container.querySelector<HTMLElement>(
      `[data-path="${locator}"]`,
    );
    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(selected).toEqual([locator]);
    act(() => root.unmount());
    container.remove();
  });

  it('renders same-name files with distinct locators without duplicate keys', () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const first =
      'deliverables/.by-id/chat-a/11111111-1111-4111-8111-111111111111/report.pdf';
    const second =
      'deliverables/.by-id/chat-b/22222222-2222-4222-8222-222222222222/report.pdf';
    const { container, root } = mountFilesTab(
      <FilesTab
        entries={[
          { name: 'report.pdf', isDir: false, relativePath: first },
          { name: 'report.pdf', isDir: false, relativePath: second },
        ]}
      />,
    );

    try {
      expect(
        container.querySelectorAll('[data-path$="/report.pdf"]'),
      ).toHaveLength(2);
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain(
        'same key',
      );
    } finally {
      act(() => root.unmount());
      container.remove();
      consoleError.mockRestore();
    }
  });

  it('surfaces the host download failure in the notice bar, listed or empty', () => {
    const listed = renderToString(
      <FilesTab
        entries={[{ name: 'report.zip', isDir: false }]}
        onDownloadFile={(): void => {}}
        downloadError="This project has expired, so its files are no longer available."
      />,
    );
    expect(listed).toContain('data-testid="activity-files-download-error"');
    expect(listed).toContain('This project has expired');

    // The listing can empty out (root switch) while the failure is still the
    // most recent thing that happened; the notice must survive that.
    const empty = renderToString(
      <FilesTab entries={[]} downloadError="Download failed. Try again." />,
    );
    expect(empty).toContain('data-testid="activity-files-download-error"');
  });

  it('shows the bounded-list notice when the directory is truncated', () => {
    const out = renderToString(
      <FilesTab entries={[{ name: 'README.md', isDir: false }]} truncated />,
    );
    expect(out).toContain('Showing first 2000 entries');
  });
});

function mutationHandlers(): FilesTabMutations {
  return {
    onCreateFile: jest.fn((): Promise<void> => Promise.resolve()),
    onCreateFolder: jest.fn((): Promise<void> => Promise.resolve()),
    onRename: jest.fn((): Promise<void> => Promise.resolve()),
    onDelete: jest.fn((): Promise<void> => Promise.resolve()),
    busy: false,
    error: null,
    onClearError: jest.fn(),
  };
}
function requiredElement<T extends Element>(
  container: ParentNode,
  selector: string,
): T {
  const node = container.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
}
function enterValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
describe('FilesTab editing', () => {
  it('only adds a toolbar for host actions and refreshes', () => {
    expect(renderToString(<FilesTab entries={[]} />)).not.toContain(
      'files-tree-refresh',
    );
    const onReload = jest.fn();
    const { container, root } = mountFilesTab(
      <FilesTab entries={[]} onReload={onReload} />,
    );
    act(() =>
      requiredElement<HTMLButtonElement>(
        container,
        '[data-testid="files-tree-refresh"]',
      ).click(),
    );
    expect(onReload).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    container.remove();
  });
  it('creates in the current folder and keeps rejected editors open', async () => {
    const mutations = mutationHandlers();
    const { container, root } = mountFilesTab(
      <FilesTab entries={[]} currentDir="out" mutations={mutations} />,
    );
    act(() =>
      requiredElement<HTMLButtonElement>(
        container,
        '[data-testid="files-tree-new-file"]',
      ).click(),
    );
    const input = requiredElement<HTMLInputElement>(
      container,
      '[data-testid="files-tree-inline-editor"]',
    );
    expect(input.dataset.parentPath).toBe('out');
    act(() => enterValue(input, 'notes.md'));
    await act(async (): Promise<void> => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(mutations.onCreateFile).toHaveBeenCalledWith('out', 'notes.md');
    expect(container.querySelector('input')).toBeNull();
    act(() =>
      root.render(
        <FilesTab
          entries={[]}
          mutations={{
            ...mutations,
            onCreateFile: (): Promise<void> =>
              Promise.reject(new Error('nope')),
          }}
        />,
      ),
    );
    act(() =>
      requiredElement<HTMLButtonElement>(
        container,
        '[data-testid="files-tree-new-file"]',
      ).click(),
    );
    const next = requiredElement<HTMLInputElement>(container, 'input');
    act(() => enterValue(next, 'bad.md'));
    await act(async (): Promise<void> => {
      next.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('nope');
    expect(container.querySelector('input')).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });
  it.each(['file', 'folder'])(
    'cancels a %s draft and its error after directory navigation',
    async (kind) => {
      const mutations = mutationHandlers();
      const { container, root } = mountFilesTab(
        <FilesTab entries={[]} currentDir="out" mutations={mutations} />,
      );
      try {
        act(() =>
          requiredElement<HTMLButtonElement>(
            container,
            `[data-testid="files-tree-new-${kind}"]`,
          ).click(),
        );
        const input = requiredElement<HTMLInputElement>(container, 'input');
        act(() => enterValue(input, '../name'));
        await act(async (): Promise<void> => {
          input.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
          );
          await Promise.resolve();
        });
        expect(container.querySelector('[role="alert"]')).not.toBeNull();
        act(() =>
          root.render(
            <FilesTab entries={[]} currentDir="other" mutations={mutations} />,
          ),
        );
        expect(container.querySelector('input')).toBeNull();
        expect(container.querySelector('[role="alert"]')).toBeNull();
        act(() =>
          root.render(
            <FilesTab entries={[]} currentDir="out" mutations={mutations} />,
          ),
        );
        expect(container.querySelector('input')).toBeNull();
        expect(mutations.onCreateFile).not.toHaveBeenCalled();
        expect(mutations.onCreateFolder).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    },
  );
  it('creates inside a context-menu folder without changing the displayed directory', async () => {
    const mutations = mutationHandlers();
    const { container, root } = mountFilesTab(
      <FilesTab
        entries={[{ name: 'child', isDir: true }]}
        currentDir="out"
        mutations={mutations}
      />,
    );
    try {
      await act(() =>
        requiredElement(container, '[data-path="out/child"]').dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true }),
        ),
      );
      act(() =>
        requiredElement<HTMLButtonElement>(
          document,
          '[data-testid="files-tree-action-new-file"]',
        ).click(),
      );
      const input = requiredElement<HTMLInputElement>(container, 'input');
      act(() => enterValue(input, 'draft.md'));
      await act(async (): Promise<void> => {
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
        await Promise.resolve();
      });
      expect(mutations.onCreateFile).toHaveBeenCalledWith(
        'out/child',
        'draft.md',
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
  it.each([false, true])(
    'shows clipboard failure independently of an open editor (%s) and clears it on retry',
    async (editing) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        navigator,
        'clipboard',
      );
      const writeText = jest
        .fn()
        .mockRejectedValueOnce(new Error('denied'))
        .mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });
      const { container, root } = mountFilesTab(
        <FilesTab
          entries={[{ name: 'notes.md', isDir: false }]}
          mutations={mutationHandlers()}
        />,
      );
      const copy = async (): Promise<void> => {
        await act(() =>
          requiredElement(container, '[data-path="notes.md"]').dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true }),
          ),
        );
        await act(async (): Promise<void> => {
          requiredElement<HTMLButtonElement>(
            document,
            '[data-testid="files-tree-action-copy-path"]',
          ).click();
          await Promise.resolve();
        });
      };
      try {
        if (editing) {
          act(() =>
            requiredElement<HTMLButtonElement>(
              container,
              '[data-testid="files-tree-new-file"]',
            ).click(),
          );
          act(() =>
            enterValue(
              requiredElement<HTMLInputElement>(container, 'input'),
              'draft.md',
            ),
          );
        }
        await copy();
        expect(
          container.querySelector('[role="alert"]')?.textContent,
        ).toContain('copy the path. Try again.');
        expect(
          container.querySelector(
            '[data-testid="files-tree-inline-editor-container"] [role="alert"]',
          ),
        ).toBeNull();
        await copy();
        expect(container.querySelector('[role="alert"]')).toBeNull();
        if (editing)
          expect(
            requiredElement<HTMLInputElement>(container, 'input').value,
          ).toBe('draft.md');
      } finally {
        act(() => root.unmount());
        container.remove();
        if (descriptor)
          Object.defineProperty(navigator, 'clipboard', descriptor);
        else Reflect.deleteProperty(navigator, 'clipboard');
      }
    },
  );
  it('supports rename keyboard validation and unchanged cancellation', async () => {
    const mutations = mutationHandlers();
    const { container, root } = mountFilesTab(
      <FilesTab
        entries={[{ name: 'a', isDir: false }]}
        mutations={mutations}
      />,
    );
    await act(() =>
      requiredElement(container, '[data-path="a"]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F2', bubbles: true }),
      ),
    );
    const input = requiredElement<HTMLInputElement>(container, 'input');
    act(() => enterValue(input, 'a/b'));
    await act(async (): Promise<void> => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      'Names cannot contain path separators.',
    );
    expect(mutations.onRename).not.toHaveBeenCalled();
    act(() => enterValue(input, 'a'));
    await act(async (): Promise<void> => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(container.querySelector('input')).toBeNull();
    expect(mutations.onRename).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });
  it('mentions eligible files from the hover actions without opening or downloading them', () => {
    const mention = jest.fn();
    const open = jest.fn();
    const download = jest.fn();
    const { container, root } = mountFilesTab(
      <FilesTab
        currentDir="docs"
        entries={[
          { name: 'live.txt', isDir: false },
          { name: 'saved.txt', isDir: false, savedCopy: true },
          { name: 'blocked.txt', isDir: false },
          { name: 'folder', isDir: true },
        ]}
        onMentionInChat={mention}
        canMentionPath={(path) => path !== 'docs/blocked.txt'}
        onOpenFile={open}
        onDownloadFile={download}
      />,
    );
    try {
      const buttons = container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="activity-files-mention"]',
      );
      expect(buttons).toHaveLength(1);
      expect(buttons[0]?.getAttribute('aria-label')).toBe(
        'Mention live.txt in chat',
      );
      act(() => buttons[0]?.click());
      expect(mention).toHaveBeenCalledWith('docs/live.txt');
      expect(open).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('keeps saved-copy menus read-only and dispatches live mentions', async () => {
    const mutations = mutationHandlers();
    const mention = jest.fn();
    const { container, root } = mountFilesTab(
      <FilesTab
        entries={[
          { name: 'saved', isDir: false, savedCopy: true },
          { name: 'live', isDir: false },
        ]}
        mutations={mutations}
        onMentionInChat={mention}
        onDownloadFile={jest.fn()}
      />,
    );
    await act(() =>
      requiredElement(container, '[data-path="saved"]').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true }),
      ),
    );
    expect(
      document.querySelector('[data-testid="files-tree-action-menu"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="files-tree-action-rename"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="files-tree-action-mention"]'),
    ).toBeNull();
    await act(() =>
      requiredElement(container, '[data-path="live"]').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true }),
      ),
    );
    act(() =>
      requiredElement<HTMLButtonElement>(
        document,
        '[data-testid="files-tree-action-mention"]',
      ).click(),
    );
    expect(mention).toHaveBeenCalledWith('live');
    act(() => root.unmount());
    container.remove();
  });
  it('debounces search and renders nested matching files', () => {
    jest.useFakeTimers();
    const ensure = jest.fn();
    const mention = jest.fn();
    const { container, root } = mountFilesTab(
      <FilesTab
        entries={[]}
        search={{ index: undefined, loading: false, onEnsureIndex: ensure }}
      />,
    );
    act(() =>
      requiredElement<HTMLButtonElement>(
        container,
        '[data-testid="files-tree-search-toggle"]',
      ).click(),
    );
    act(() =>
      enterValue(
        requiredElement<HTMLInputElement>(
          container,
          '[data-testid="files-tree-search-input"]',
        ),
        'src',
      ),
    );
    act(() => jest.advanceTimersByTime(179));
    expect(ensure).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(ensure).toHaveBeenCalledTimes(1);
    act(() =>
      root.render(
        <FilesTab
          entries={[]}
          onMentionInChat={mention}
          search={{
            index: { paths: ['src/a.ts', 'README.md'], truncated: true },
            loading: false,
            onEnsureIndex: ensure,
          }}
        />,
      ),
    );
    expect(
      requiredElement<HTMLElement>(container, '[data-path="src/a.ts"]').style
        .paddingLeft,
    ).toBe('24px');
    expect(container.textContent).not.toContain('README.md');
    expect(
      container.querySelector('[data-testid="files-tree-index-truncated"]'),
    ).not.toBeNull();
    act(() =>
      requiredElement<HTMLButtonElement>(
        container,
        '[data-testid="activity-files-mention"]',
      ).click(),
    );
    expect(mention).toHaveBeenCalledWith('src/a.ts');
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });
});

it('opens a delete confirmation from the keyboard and deletes a directory', async () => {
  const mutations = mutationHandlers();
  const { container, root } = mountFilesTab(
    <FilesTab entries={[{ name: 'out', isDir: true }]} mutations={mutations} />,
  );
  try {
    await act(() =>
      requiredElement(container, '[data-path="out"]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }),
      ),
    );
    expect(
      document.querySelector('[data-testid="files-tree-delete-dialog"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      'This folder and everything in it will be deleted.',
    );
    await act(async (): Promise<void> => {
      requiredElement<HTMLButtonElement>(
        document,
        '[data-testid="files-tree-delete-confirm"]',
      ).click();
      await Promise.resolve();
    });
    expect(mutations.onDelete).toHaveBeenCalledWith('out', true);
    expect(
      document.querySelector('[data-testid="files-tree-delete-dialog"]'),
    ).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
it.each(['read-only', 'denied-path', 'busy'] as const)(
  'preserves the native background menu when %s',
  async (mode): Promise<void> => {
    const { container, root } = mountFilesTab(
      <FilesTab
        entries={[]}
        currentDir="out"
        mutations={
          mode === 'read-only'
            ? undefined
            : { ...mutationHandlers(), busy: mode === 'busy' }
        }
        canMutatePath={(path): boolean =>
          mode !== 'denied-path' || path !== 'out'
        }
        onMentionInChat={jest.fn()}
        onDownloadFile={jest.fn()}
      />,
    );
    try {
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      });
      await act(() =>
        requiredElement(
          container,
          '[data-testid="activity-files"]',
        ).dispatchEvent(event),
      );
      expect(event.defaultPrevented).toBe(false);
      expect(
        document.querySelector('[data-testid="files-tree-action-menu"]'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  },
);
it.each(['input', 'textarea', 'contenteditable'])(
  'preserves the native context menu for a listing %s',
  (kind) => {
    const { container, root } = mountFilesTab(
      <FilesTab
        entries={[]}
        mutations={mutationHandlers()}
        emptyState={
          kind === 'contenteditable' ? (
            <div contentEditable>
              <span data-testid="editable-target" />
            </div>
          ) : kind === 'textarea' ? (
            <textarea data-testid="editable-target" />
          ) : (
            <input data-testid="editable-target" />
          )
        }
      />,
    );
    try {
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        requiredElement(
          container,
          '[data-testid="editable-target"]',
        ).dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(
        document.querySelector('[data-testid="files-tree-action-menu"]'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  },
);
it('targets the current directory from the background menu', async () => {
  const { container, root } = mountFilesTab(
    <FilesTab entries={[]} currentDir="out" mutations={mutationHandlers()} />,
  );
  try {
    await act(() =>
      requiredElement(
        container,
        '[data-testid="activity-files"]',
      ).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })),
    );
    act(() =>
      requiredElement<HTMLButtonElement>(
        document,
        '[data-testid="files-tree-action-new-folder"]',
      ).click(),
    );
    expect(
      requiredElement<HTMLInputElement>(
        container,
        '[data-testid="files-tree-inline-editor"]',
      ).dataset.parentPath,
    ).toBe('out');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
it('opens focused search with Cmd+F and caps the visible matches', async () => {
  jest.useFakeTimers();
  const { container, root } = mountFilesTab(
    <FilesTab
      entries={[]}
      search={{
        index: {
          paths: Array.from({ length: 600 }, (_, i): string => `file-${i}.md`),
          truncated: false,
        },
        loading: false,
        onEnsureIndex: jest.fn(),
      }}
    />,
  );
  try {
    await act(() =>
      requiredElement(
        container,
        '[data-testid="activity-files"]',
      ).dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'f',
          metaKey: true,
          bubbles: true,
        }),
      ),
    );
    const input = requiredElement<HTMLInputElement>(
      container,
      '[data-testid="files-tree-search-input"]',
    );
    expect(document.activeElement).toBe(input);
    act(() => enterValue(input, 'file'));
    act(() => jest.advanceTimersByTime(180));
    expect(
      container.querySelectorAll('[data-testid="files-tree-search-result"]'),
    ).toHaveLength(500);
    expect(
      container.querySelector('[data-testid="files-tree-search-truncated"]')
        ?.textContent,
    ).toContain('Showing 500 of 600 matches.');
  } finally {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  }
});
it('renders and clears a host mutation error', () => {
  const mutations = { ...mutationHandlers(), error: 'Boom' };
  const { container, root } = mountFilesTab(
    <FilesTab entries={[]} mutations={mutations} />,
  );
  try {
    expect(
      container.querySelector('[data-testid="files-tree-mutation-error"]')
        ?.textContent,
    ).toContain('Boom');
    act(() =>
      requiredElement<HTMLButtonElement>(
        container,
        '[aria-label="Dismiss file error"]',
      ).click(),
    );
    expect(mutations.onClearError).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

describe('FilesTab toolbar glyphs', () => {
  const TOOLBAR_BUTTONS = [
    'files-tree-new-file',
    'files-tree-new-folder',
    'files-tree-search-toggle',
    'files-tree-refresh',
  ];

  function toolbar(): JSX.Element {
    return (
      <FilesTab
        entries={[]}
        mutations={mutationHandlers()}
        search={{ index: undefined, loading: false, onEnsureIndex: jest.fn() }}
        onReload={jest.fn()}
      />
    );
  }

  function centralGlyphs(container: HTMLElement): boolean[] {
    return TOOLBAR_BUTTONS.map(
      (testId) =>
        requiredElement<HTMLElement>(
          container,
          `[data-testid="${testId}"] svg`,
        ).getAttribute('data-app-icon') === 'true',
    );
  }

  it('uses Lucide glyphs when the host chooses no icon style', () => {
    const { container, root } = mountFilesTab(toolbar());
    expect(centralGlyphs(container)).toEqual([true, true, true, true]);
    expect(
      requiredElement<HTMLElement>(
        container,
        '[data-testid="files-tree-refresh"] svg',
      ).getAttribute('width'),
    ).toBe('14px');
    act(() => root.unmount());
    container.remove();
  });

  it('draws the app glyphs when the host opts in', () => {
    const { container, root } = mountFilesTab(
      <IconStyleProvider value="central">{toolbar()}</IconStyleProvider>,
    );
    expect(centralGlyphs(container)).toEqual([true, true, true, true]);
    expect(
      requiredElement<HTMLElement>(
        container,
        '[data-testid="files-tree-refresh"] svg',
      ).classList.contains('h-4'),
    ).toBe(true);
    act(() => root.unmount());
    container.remove();
  });

  describe('app-owned root group', () => {
    beforeEach(() => localStorage.clear());
    const coworkRoots: FilesTabRoot[] = [
      { localId: 'workspace', label: 'Vendor Spend Q3', kind: 'standalone' },
      { localId: 'notes', label: 'notes', kind: 'standalone' },
      { localId: 'prompts', label: 'prompts', kind: 'standalone' },
      { localId: 'attachments', label: 'attachments', kind: 'attachments' },
    ];
    const chipLabels = (container: HTMLElement): string[] =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="activity-files-roots"] button:not([aria-expanded])',
        ),
        (chip) => chip.textContent ?? '',
      );

    it('groups app-owned roots under a collapsed brand control', () => {
      const onSelectRoot = jest.fn();
      const { container, root } = mountFilesTab(
        <FilesTab
          entries={[]}
          roots={coworkRoots}
          activeRootLocalId="workspace"
          onSelectRoot={onSelectRoot}
          appManagedRootsLabel="Canopy"
        />,
      );
      const group = container.querySelector<HTMLButtonElement>(
        '[data-testid="activity-files-root-group"]',
      );
      expect(group?.textContent).toContain('Canopy');
      expect(group?.getAttribute('aria-expanded')).toBe('false');
      expect(chipLabels(container)).toEqual(['Vendor Spend Q3']);
      const projectLabel = container.querySelector(`.${REPLAY_MASK_CLASS}`);
      expect(projectLabel?.textContent).toBe('Vendor Spend Q3');

      act(() => group?.click());
      expect(group?.getAttribute('aria-expanded')).toBe('true');
      const controlled = group?.getAttribute('aria-controls') ?? '';
      expect(document.getElementById(controlled)?.getAttribute('role')).toBe(
        'group',
      );
      expect(chipLabels(container)).toEqual([
        'Vendor Spend Q3',
        'notes',
        'prompts',
        'attachments',
      ]);
      const notes = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((chip) => chip.textContent === 'notes');
      act(() => notes?.click());
      expect(onSelectRoot).toHaveBeenCalledWith('notes');
      act(() => root.unmount());
      container.remove();
    });

    it('isolates and restores group expansion across workspace switches and remounts', () => {
      const view = (workspace: string): JSX.Element => (
        <FilesTab
          entries={[]}
          roots={coworkRoots}
          workspaceLocalId={workspace}
          worktreeLocalId="home"
          activeRootLocalId="workspace"
          onSelectRoot={jest.fn()}
          appManagedRootsLabel="Canopy"
        />
      );
      const { container, root } = mountFilesTab(view('one'));
      const group = (): HTMLButtonElement | null =>
        container.querySelector('[data-testid="activity-files-root-group"]');
      act(() => group()?.click());
      expect(group()?.getAttribute('aria-expanded')).toBe('true');
      act(() => root.render(view('two')));
      expect(group()?.getAttribute('aria-expanded')).toBe('false');
      act(() => root.render(view('one')));
      expect(group()?.getAttribute('aria-expanded')).toBe('true');
      act(() => group()?.click());
      act(() => root.unmount());
      container.remove();
      const remounted = mountFilesTab(view('one'));
      expect(
        remounted.container
          .querySelector('[data-testid="activity-files-root-group"]')
          ?.getAttribute('aria-expanded'),
      ).toBe('false');
      act(() => remounted.root.unmount());
      remounted.container.remove();
    });

    it('reveals the group when an app-owned root is active', () => {
      const { container, root } = mountFilesTab(
        <FilesTab
          entries={[]}
          roots={coworkRoots}
          activeRootLocalId="notes"
          onSelectRoot={jest.fn()}
          appManagedRootsLabel="Canopy"
        />,
      );
      expect(
        container
          .querySelector('[data-testid="activity-files-root-group"]')
          ?.getAttribute('aria-expanded'),
      ).toBe('true');
      act(() => root.unmount());
      container.remove();
    });

    it.each([
      ['without a brand label', coworkRoots, undefined, true],
      [
        'for an older host without root kinds',
        coworkRoots.map(({ localId, label }) => ({ localId, label })),
        'Canopy',
        false,
      ],
      [
        'outside a Cowork catalog',
        [
          { localId: 'workspace', label: 'workspace', kind: 'git-repo' },
          { localId: 'attachments', label: 'attachments', kind: 'attachments' },
        ] satisfies FilesTabRoot[],
        'Canopy',
        false,
      ],
    ])('keeps every root chip visible %s', (_name, roots, label, masked) => {
      const { container, root } = mountFilesTab(
        <FilesTab
          entries={[]}
          roots={roots}
          activeRootLocalId={roots[0]?.localId}
          onSelectRoot={jest.fn()}
          appManagedRootsLabel={label}
        />,
      );
      expect(
        container.querySelector('[data-testid="activity-files-root-group"]'),
      ).toBeNull();
      expect(chipLabels(container)).toEqual(roots.map((entry) => entry.label));
      // Only an identified Cowork root carries the project title.
      expect(container.querySelector(`.${REPLAY_MASK_CLASS}`) !== null).toBe(
        masked,
      );
      act(() => root.unmount());
      container.remove();
    });
  });
});

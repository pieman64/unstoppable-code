/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { focusViaKeyboard } from '@/test-utils/dom';
import type {
  EditorSelectionContext,
  SelectionFreshness,
} from '@/lib/editorSelectionContext';

const mockReadFileContent = jest.fn();
const mockFileViewerState: {
  files: Record<
    string,
    {
      preview: object | null;
      content: string;
    }
  >;
} = { files: {} };

jest.mock('@canopy/app-state', () => ({
  fileViewerKey: ({ relativePath }: { relativePath: string }): string =>
    relativePath,
  useFileViewerStore: (
    selector: (state: typeof mockFileViewerState) => unknown,
  ): unknown => selector(mockFileViewerState),
}));

import { SelectionContextChips } from '../SelectionContextChips';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const selection: EditorSelectionContext = {
  id: 'selection-1',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  absolutePath: '/repo/example.ts',
  displayPath: 'example.ts',
  startLine: 1,
  startColumn: 1,
  endLine: 1,
  endColumn: 6,
  text: 'alpha',
  capturedDirty: false,
};

const secondSelection: EditorSelectionContext = {
  ...selection,
  id: 'selection-2',
  absolutePath: '/repo/second.ts',
  displayPath: 'second.ts',
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T): void => {
      resolvePromise?.(value);
    },
  };
}

describe('SelectionContextChips', () => {
  let host: HTMLDivElement;
  let root: Root;
  let latestFreshness: Record<string, SelectionFreshness>;

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    latestFreshness = {};
    mockReadFileContent.mockReset();
    mockFileViewerState.files = {};
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { readFileContent: mockReadFileContent },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    jest.useRealTimers();
  });

  function render(selections: readonly EditorSelectionContext[]): void {
    root.render(
      <SelectionContextChips
        selections={selections}
        onReveal={jest.fn()}
        onOpen={jest.fn()}
        onRemove={jest.fn()}
        onFreshnessChange={(freshness): void => {
          latestFreshness = freshness;
        }}
      />,
    );
  }

  it('shows each selection as a tile like the attachments: its code above its name', () => {
    jest.useFakeTimers();
    mockFileViewerState.files = {
      'example.ts': { preview: {}, content: 'alpha\n' },
    };
    const onRemove = jest.fn();
    act(() => {
      root.render(
        <SelectionContextChips
          selections={[selection]}
          onReveal={jest.fn()}
          onOpen={jest.fn()}
          onRemove={onRemove}
        />,
      );
    });
    const tile = host.querySelector('[data-attachment-kind="selection"]');
    expect(tile?.classList.contains('h-30')).toBe(true);
    expect(tile?.classList.contains('w-40')).toBe(true);
    expect(tile?.querySelector('.font-mono')?.textContent).toBe('alpha');
    expect(tile?.textContent).toContain('example.ts:1');
    // No box of its own: the tiles join the composer's attachment strip.
    expect(
      host
        .querySelector('[data-testid="selection-context-chips"]')
        ?.classList.contains('contents'),
    ).toBe(true);
    const remove = host.querySelector<HTMLButtonElement>(
      '[data-testid="selection-context-chip-remove"]',
    );
    expect(remove?.classList.contains('group-hover:opacity-100')).toBe(true);
    act(() => remove?.click());
    expect(onRemove).toHaveBeenCalledWith(selection.id);
  });

  it('explains the chip with a rich tooltip instead of a native title (CAN-2799)', () => {
    jest.useFakeTimers();
    mockFileViewerState.files = {
      'example.ts': { preview: {}, content: 'alpha\n' },
    };

    act(() => {
      render([selection]);
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });

    const chip = host.querySelector<HTMLElement>(
      '[data-testid="selection-context-chip"]',
    );
    expect(chip?.hasAttribute('title')).toBe(false);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      focusViaKeyboard(chip);
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'example.ts:1-1',
    );
  });

  it('defers live-buffer freshness parsing until the renderer is idle', () => {
    jest.useFakeTimers();
    mockFileViewerState.files = {
      'example.ts': {
        preview: {},
        content: `alpha\n${'trailing content\n'.repeat(10_000)}`,
      },
    };

    act(() => {
      render([selection]);
    });

    expect(latestFreshness[selection.id]).toBe('checking');
    expect(
      host.querySelector('[data-testid="selection-context-chip-checking"]')
        ?.textContent,
    ).toBe('checking');
    expect(mockReadFileContent).not.toHaveBeenCalled();

    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(latestFreshness[selection.id]).toBe('fresh');
    expect(
      host.querySelector('[data-testid="selection-context-chip-checking"]'),
    ).toBeNull();
  });

  it('drops cached live buffers when their selections are removed', () => {
    jest.useFakeTimers();
    mockFileViewerState.files = {
      'example.ts': { preview: {}, content: 'alpha' },
      'second.ts': { preview: {}, content: 'alpha' },
    };

    act(() => {
      render([selection, secondSelection]);
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(latestFreshness).toEqual({
      [selection.id]: 'fresh',
      [secondSelection.id]: 'fresh',
    });

    act(() => {
      render([secondSelection]);
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });

    act(() => {
      render([selection, secondSelection]);
    });
    expect(latestFreshness).toEqual({
      [selection.id]: 'checking',
      [secondSelection.id]: 'fresh',
    });
  });

  it('retries a cancelled disk check and reports unresolved freshness explicitly', async () => {
    const firstRead = deferred<{ kind: 'text'; content: string }>();
    const retryRead = deferred<{ kind: 'text'; content: string }>();
    mockReadFileContent
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(retryRead.promise);

    await act(async () => {
      render([selection]);
      await Promise.resolve();
    });
    expect(latestFreshness[selection.id]).toBe('checking');
    expect(mockReadFileContent).toHaveBeenCalledTimes(1);
    expect(
      host.querySelector('[data-testid="selection-context-chip-checking"]')
        ?.textContent,
    ).toBe('checking');
    expect(
      host.querySelector('[data-testid="selection-context-chip-stale"]'),
    ).toBeNull();

    await act(async () => {
      render([]);
      await Promise.resolve();
      render([selection]);
      await Promise.resolve();
    });
    expect(mockReadFileContent).toHaveBeenCalledTimes(2);
    expect(latestFreshness[selection.id]).toBe('checking');

    await act(async () => {
      firstRead.resolve({ kind: 'text', content: 'alpha' });
      await firstRead.promise;
    });
    expect(latestFreshness[selection.id]).toBe('checking');

    await act(async () => {
      retryRead.resolve({ kind: 'text', content: 'edited' });
      await retryRead.promise;
    });
    expect(latestFreshness[selection.id]).toBe('stale');
    expect(
      host.querySelector('[data-testid="selection-context-chip-checking"]'),
    ).toBeNull();
    expect(
      host.querySelector('[data-testid="selection-context-chip-stale"]')
        ?.textContent,
    ).toBe('stale');
  });
});

/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
  LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
  type LocalMemoryConsolidationStatus,
  type LocalMemoryDeleteRequest,
  type LocalMemoryDocument,
  type LocalMemoryFileSummary,
  type LocalMemoryReadRequest,
  type LocalMemoryRebuildResponse,
  type LocalMemoryScopeRequest,
  type LocalMemoryUpdateRequest,
} from '@canopy/desktop-shared/types/local-memory';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { MemoryExplorer } from '../MemoryExplorer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const DOCUMENT: LocalMemoryDocument = {
  fileKey: 'MEMORY.md',
  revision: 'original-revision',
  items: [
    {
      id: 'item-one',
      kind: 'paragraph',
      text: 'Original memory',
      children: [],
    },
  ],
};
const FILES: LocalMemoryFileSummary[] = [
  {
    fileKey: DOCUMENT.fileKey,
    kind: 'index',
    modifiedAt: '2026-09-10T10:00:00Z',
    sizeBytes: 16,
  },
];
const IDLE_STATUS: LocalMemoryConsolidationStatus = {
  pendingNotes: 0,
  running: false,
  rebuilding: false,
  lastRunAt: null,
  lastResult: null,
  lastReason: null,
  lastConsolidatedAt: null,
};

describe('MemoryExplorer', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalApi: PropertyDescriptor | undefined;
  let notifyChange: ((scope: LocalMemoryScopeRequest) => void) | undefined;
  const listFiles = jest.fn<
    Promise<LocalMemoryFileSummary[]>,
    [LocalMemoryScopeRequest]
  >();
  const readFile = jest.fn<
    Promise<LocalMemoryDocument>,
    [LocalMemoryReadRequest]
  >();
  const updateItem = jest.fn<
    Promise<LocalMemoryDocument>,
    [LocalMemoryUpdateRequest]
  >();
  const deleteItem = jest.fn<
    Promise<LocalMemoryDocument>,
    [LocalMemoryDeleteRequest]
  >();
  const openLink = jest.fn<Promise<void>, [{ url: string }]>();
  const watchMemory = jest.fn<Promise<void>, [LocalMemoryScopeRequest]>();
  const unwatchMemory = jest.fn<Promise<void>, [LocalMemoryScopeRequest]>();
  const getStatus = jest.fn<
    Promise<LocalMemoryConsolidationStatus>,
    [LocalMemoryScopeRequest]
  >();
  const consolidate = jest.fn<
    Promise<LocalMemoryConsolidationStatus>,
    [LocalMemoryScopeRequest]
  >();

  function statusLine(): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      '[data-testid="memory-consolidation-status"]',
    );
  }

  const rebuild = jest.fn<
    Promise<LocalMemoryRebuildResponse>,
    [LocalMemoryScopeRequest]
  >();

  function rebuildButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="memory-rebuild"]',
    );
  }

  function rebuildDialog(): HTMLElement | null {
    return document.querySelector<HTMLElement>(
      '[data-testid="memory-rebuild-dialog"]',
    );
  }

  function consolidateButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="memory-consolidate"]',
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    listFiles.mockResolvedValue(FILES);
    readFile.mockResolvedValue(DOCUMENT);
    watchMemory.mockResolvedValue(undefined);
    unwatchMemory.mockResolvedValue(undefined);
    getStatus.mockResolvedValue(IDLE_STATUS);
    consolidate.mockResolvedValue(IDLE_STATUS);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        browser: { openLink },
        listLocalMemoryFiles: listFiles,
        readLocalMemoryFile: readFile,
        updateLocalMemoryItem: updateItem,
        deleteLocalMemoryItem: deleteItem,
        watchLocalMemory: watchMemory,
        unwatchLocalMemory: unwatchMemory,
        getLocalMemoryConsolidationStatus: getStatus,
        consolidateLocalMemory: consolidate,
        rebuildLocalMemory: rebuild,
        onLocalMemoryChanged: (callback: typeof notifyChange): (() => void) => {
          notifyChange = callback;
          return (): void => {
            notifyChange = undefined;
          };
        },
      },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
  });

  it('reports nothing until its first load ends, then reveals only detected files', async () => {
    let release: ((files: LocalMemoryFileSummary[]) => void) | undefined;
    listFiles.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const onEmptyChange = jest.fn();
    act(() => {
      root.render(
        <MemoryExplorer
          scope="user"
          hideWhenEmpty
          onEmptyChange={onEmptyChange}
        />,
      );
    });
    // Loading proves nothing yet: a remounted explorer must not report its
    // initial empty list over the content an earlier one found.
    expect(onEmptyChange).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="memory-explorer-user"]'),
    ).toBeNull();
    await act(async () => {
      release?.(FILES);
      await Promise.resolve();
    });
    expect(onEmptyChange).toHaveBeenCalledTimes(1);
    expect(onEmptyChange).toHaveBeenLastCalledWith(false);
    expect(
      container.querySelector('[data-testid="memory-explorer-user"]'),
    ).not.toBeNull();
  });

  it('blocks only the memory list from session replay, keeping the search recorded', async () => {
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });

    const explorer = container.querySelector(
      '[data-testid="memory-explorer-user"]',
    );
    expect(explorer?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
      false,
    );
    expect(
      container
        .querySelector('[data-testid="memory-search"]')
        ?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
    const items = container.querySelector('[data-testid="memory-items"]');
    expect(items?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);
    expect(items?.textContent).toContain('Original memory');
  });

  it('wraps long memory text instead of scrolling the list sideways', async () => {
    // A long unbroken flag in a memory pushed the list into a sideways
    // scroll, and the two scrollbars met in a white square.
    listFiles.mockResolvedValue(FILES);
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    const items = container.querySelector('[data-testid="memory-items"]');
    expect(items?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['overflow-y-auto', 'overflow-x-hidden']),
    );
  });

  it('reveals a failed initial load so Retry remains available', async () => {
    listFiles.mockRejectedValueOnce(new Error('Cannot list memory'));
    const onEmptyChange = jest.fn();
    await act(async () => {
      root.render(
        <MemoryExplorer
          scope="user"
          hideWhenEmpty
          onEmptyChange={onEmptyChange}
        />,
      );
      await Promise.resolve();
    });
    expect(onEmptyChange).toHaveBeenLastCalledWith(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Retry',
    );
  });

  it('selects a linked memory without navigating the renderer', async () => {
    listFiles.mockResolvedValue([
      ...FILES,
      { ...FILES[0], fileKey: 'topics/travel.md', kind: 'topic' },
    ]);
    readFile.mockResolvedValueOnce({
      ...DOCUMENT,
      items: [{ ...DOCUMENT.items[0], text: '[Travel](topics/travel.md)' }],
    });
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    const anchor = container.querySelector<HTMLAnchorElement>('a');
    expect(anchor).not.toBeNull();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      anchor?.dispatchEvent(event);
      await Promise.resolve();
    });
    expect(event.defaultPrevented).toBe(true);
    expect(readFile).toHaveBeenLastCalledWith({
      scope: 'user',
      fileKey: 'topics/travel.md',
    });
  });

  it('routes web references through the app-link router and keeps unknown local links inert', async () => {
    readFile.mockResolvedValueOnce({
      ...DOCUMENT,
      items: [
        {
          ...DOCUMENT.items[0],
          text: '[Website](https://example.com) [Missing](topics/missing.md)',
        },
      ],
    });
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    const anchors = container.querySelectorAll('a');
    expect(anchors).toHaveLength(1);
    await act(async () => {
      anchors[0]?.click();
      await Promise.resolve();
    });
    expect(openLink).toHaveBeenCalledWith({ url: 'https://example.com' });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Missing');
  });

  it('keeps a read error visible when the concurrent file list refresh succeeds later', async () => {
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    let finishList: ((files: LocalMemoryFileSummary[]) => void) | undefined;
    listFiles.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishList = resolve;
        }),
    );
    readFile.mockRejectedValueOnce(new Error('File no longer readable'));
    await act(async () => {
      notifyChange?.({ scope: 'user' });
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't open this memory file",
    );
    await act(async () => {
      finishList?.(FILES);
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't open this memory file",
    );
  });

  it('keeps a draft visible if refresh removes the file being edited', async () => {
    await act(async () => {
      await Promise.resolve();
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    const edit = container.querySelector<HTMLButtonElement>(
      '[data-testid="memory-item-edit"]',
    );
    expect(edit).not.toBeNull();
    act(() => edit?.click());
    const textarea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="memory-item-draft"]',
    );
    expect(textarea).not.toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set?.call(textarea, 'Unsaved draft');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    listFiles.mockResolvedValue([]);
    readFile.mockRejectedValue(new Error('File no longer exists'));
    await act(async () => {
      await Promise.resolve();
      notifyChange?.({ scope: 'user' });
      await Promise.resolve();
    });
    const retainedDraft = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="memory-item-draft"]',
    );
    expect(retainedDraft?.value).toBe('Unsaved draft');
    expect(container.querySelector('[data-testid="memory-empty"]')).toBeNull();
    await act(async () => {
      await Promise.resolve();
      container
        .querySelector<HTMLButtonElement>('[data-testid="memory-item-cancel"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="memory-empty"]'),
    ).not.toBeNull();
  });

  it('searches every memory file and hides files without a match', async () => {
    const travel: LocalMemoryDocument = {
      fileKey: 'topics/travel.md',
      revision: 'travel-revision',
      items: [
        {
          id: 'travel-one',
          kind: 'paragraph',
          text: 'Prefer a window seat',
          children: [],
        },
      ],
    };
    listFiles.mockResolvedValue([
      ...FILES,
      { ...FILES[0], fileKey: travel.fileKey, kind: 'topic' },
    ]);
    readFile.mockImplementation((request) =>
      Promise.resolve(request.fileKey === travel.fileKey ? travel : DOCUMENT),
    );
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('window seat');
    const search = container.querySelector<HTMLInputElement>(
      '[data-testid="memory-search"]',
    );
    expect(search).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(search, 'window');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenLastCalledWith({
      scope: 'user',
      fileKey: travel.fileKey,
    });
    const files = container.querySelectorAll('[data-testid="memory-file"]');
    expect(files).toHaveLength(1);
    expect(files[0]?.getAttribute('data-file-key')).toBe(travel.fileKey);
    expect(container.textContent).toContain('Prefer a window seat');
    expect(container.textContent).not.toContain('Original memory');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(search, 'nothing matches');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      container.querySelectorAll('[data-testid="memory-file"]'),
    ).toHaveLength(0);
    expect(
      container.querySelector('[data-testid="memory-empty-search"]')
        ?.textContent,
    ).toBe('Try another search.');
  });

  async function typeSearch(value: string): Promise<void> {
    const search = container.querySelector<HTMLInputElement>(
      '[data-testid="memory-search"]',
    );
    expect(search).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(search, value);
      search?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
  }

  async function settleUntil(
    condition: () => boolean,
    maxWaitMs = 4_000,
  ): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (!condition() && Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(condition()).toBe(true);
  }

  it('keeps a global search under the parser cap and reads every file once', async () => {
    const many: LocalMemoryFileSummary[] = Array.from(
      { length: 20 },
      (_value, index) => ({
        ...FILES[0],
        fileKey: `topics/file-${String(index).padStart(2, '0')}.md`,
        kind: 'topic',
      }),
    );
    listFiles.mockResolvedValue([...FILES, ...many]);
    let inFlight = 0;
    let peak = 0;
    readFile.mockImplementation(
      (request) =>
        new Promise((resolve, reject) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          if (inFlight > 4) {
            inFlight -= 1;
            reject(new Error('Memory parser is busy. Try again.'));
            return;
          }
          setTimeout(() => {
            inFlight -= 1;
            resolve({
              ...DOCUMENT,
              fileKey: request.fileKey,
              items: [
                {
                  ...DOCUMENT.items[0],
                  text: `Shared phrase in ${request.fileKey}`,
                },
              ],
            });
          }, 5);
        }),
    );
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    await settleUntil(() => readFile.mock.calls.length === 1);
    await typeSearch('shared phrase');
    await settleUntil(
      () =>
        container.querySelectorAll('[data-testid="memory-file"]').length === 21,
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(readFile).toHaveBeenCalledTimes(21);
    const readKeys = readFile.mock.calls.map(([request]) => request.fileKey);
    expect(new Set(readKeys).size).toBe(21);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(container.textContent).not.toContain("Couldn't open this memory");
    expect(
      container.querySelector('[data-testid="memory-empty-search"]'),
    ).toBeNull();
  });

  it('shares the read pool across a refresh so no key is read twice at once', async () => {
    const many: LocalMemoryFileSummary[] = Array.from(
      { length: 8 },
      (_value, index) => ({
        ...FILES[0],
        fileKey: `topics/file-${index}.md`,
        kind: 'topic',
      }),
    );
    listFiles.mockResolvedValue([...FILES, ...many]);
    const pending: Array<{
      fileKey: string;
      resolve: (document: LocalMemoryDocument) => void;
    }> = [];
    const perKeyInFlight = new Map<string, number>();
    let inFlight = 0;
    let peak = 0;
    let doubleRequested = false;
    readFile.mockImplementation(
      (request) =>
        new Promise((resolve) => {
          const count = (perKeyInFlight.get(request.fileKey) ?? 0) + 1;
          if (count > 1) doubleRequested = true;
          perKeyInFlight.set(request.fileKey, count);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          pending.push({
            fileKey: request.fileKey,
            resolve: (document): void => {
              perKeyInFlight.set(request.fileKey, count - 1);
              inFlight -= 1;
              resolve(document);
            },
          });
        }),
    );
    const documentFor = (fileKey: string): LocalMemoryDocument => ({
      ...DOCUMENT,
      fileKey,
      items: [{ ...DOCUMENT.items[0], text: `Needle in ${fileKey}` }],
    });
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    // The default expansion reads the index; let it through.
    await settleUntil(() => pending.length === 1);
    await act(async () => {
      pending.shift()?.resolve(documentFor('MEMORY.md'));
      await Promise.resolve();
    });
    await typeSearch('needle');
    await settleUntil(() => pending.length === 4);
    expect(inFlight).toBe(4);
    // A change event lands while four reads are still outstanding.
    await act(async () => {
      notifyChange?.({ scope: 'user' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(inFlight).toBe(4);
    // Drain everything, in arrival order, until nothing is left in flight.
    await settleUntil(() => {
      const next = pending.shift();
      if (next) next.resolve(documentFor(next.fileKey));
      return next === undefined && inFlight === 0;
    });
    await settleUntil(
      () =>
        container.querySelectorAll('[data-testid="memory-file"]').length === 9,
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(doubleRequested).toBe(false);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it('keeps a file whose read failed visible in search results with Retry', async () => {
    listFiles.mockResolvedValue([
      ...FILES,
      { ...FILES[0], fileKey: 'topics/broken.md', kind: 'topic' },
    ]);
    readFile.mockImplementation((request) =>
      request.fileKey === 'topics/broken.md'
        ? Promise.reject(new Error('EACCES: permission denied'))
        : Promise.resolve({
            ...DOCUMENT,
            fileKey: request.fileKey,
            items: [{ ...DOCUMENT.items[0], text: 'Only in the index' }],
          }),
    );
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    await typeSearch('only in the index');
    await settleUntil(
      () =>
        container.querySelectorAll('[data-testid="memory-file"]').length === 2,
    );
    const broken = container.querySelector(
      '[data-file-key="topics/broken.md"]',
    );
    expect(broken).not.toBeNull();
    expect(broken?.parentElement?.hasAttribute('open')).toBe(true);
    const alert = broken?.parentElement?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't open this memory file");
    expect(alert?.querySelector('button')?.textContent).toBe('Retry');
    expect(
      container.querySelector('[data-testid="memory-empty-search"]'),
    ).toBeNull();
  });

  it('retries a busy parser rejection instead of caching it as a read error', async () => {
    listFiles.mockResolvedValue([
      ...FILES,
      { ...FILES[0], fileKey: 'topics/busy.md', kind: 'topic' },
    ]);
    let busyRejections = 0;
    readFile.mockImplementation((request) => {
      if (request.fileKey === 'topics/busy.md' && busyRejections < 2) {
        busyRejections += 1;
        return Promise.reject(new Error('Memory parser is busy. Try again.'));
      }
      return Promise.resolve({
        ...DOCUMENT,
        fileKey: request.fileKey,
        items: [
          {
            ...DOCUMENT.items[0],
            text:
              request.fileKey === 'topics/busy.md'
                ? 'Busy but fine'
                : 'Original memory',
          },
        ],
      });
    });
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    await typeSearch('busy but fine');
    // Queued/retrying files keep the search pending: no early empty state.
    expect(
      container.querySelector('[data-testid="memory-empty-search"]'),
    ).toBeNull();
    await settleUntil(
      () => container.textContent?.includes('Busy but fine') ?? false,
    );
    expect(busyRejections).toBe(2);
    expect(
      readFile.mock.calls.filter(
        ([request]) => request.fileKey === 'topics/busy.md',
      ),
    ).toHaveLength(3);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(
      container.querySelectorAll('[data-testid="memory-file"]'),
    ).toHaveLength(1);
  });

  it('surfaces the read error once busy retries are exhausted', async () => {
    listFiles.mockResolvedValue([
      { ...FILES[0], fileKey: 'topics/stuck.md', kind: 'topic' },
    ]);
    readFile.mockRejectedValue(new Error('Memory parser is busy. Try again.'));
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    await settleUntil(() => container.querySelector('[role="alert"]') !== null);
    expect(readFile).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't open this memory file",
    );
  });

  it('only pins open the heading being edited in its own file', async () => {
    const headed = (fileKey: string, text: string): LocalMemoryDocument => ({
      ...DOCUMENT,
      fileKey,
      items: [
        {
          id: '0:40',
          kind: 'heading',
          level: 2,
          text: `## ${text}`,
          children: [{ ...DOCUMENT.items[0], id: '10:40', text }],
        },
      ],
    });
    listFiles.mockResolvedValue([
      ...FILES,
      { ...FILES[0], fileKey: 'topics/other.md', kind: 'topic' },
    ]);
    readFile.mockImplementation((request) =>
      Promise.resolve(
        request.fileKey === 'MEMORY.md'
          ? headed('MEMORY.md', 'Alpha memory')
          : headed('topics/other.md', 'Beta memory'),
      ),
    );
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    // Open the second file so both same-id headings render.
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-file-key="topics/other.md"]')
        ?.click();
      await Promise.resolve();
    });
    await settleUntil(
      () =>
        container.querySelectorAll('[data-testid="memory-heading"]').length ===
        2,
    );
    const headingFor = (text: string): HTMLDetailsElement | null =>
      Array.from(
        container.querySelectorAll<HTMLDetailsElement>(
          '[data-testid="memory-heading"]',
        ),
      ).find((element) => element.textContent?.includes(text)) ?? null;
    act(() => {
      headingFor('Alpha memory')
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="memory-item"] [data-testid="memory-item-edit"]',
        )
        ?.click();
    });
    expect(
      container.querySelector('[data-testid="memory-item-draft"]'),
    ).not.toBeNull();
    const beta = headingFor('Beta memory');
    expect(beta?.open).toBe(true);
    act(() => {
      beta?.querySelector('summary')?.click();
    });
    expect(headingFor('Beta memory')?.open).toBe(false);
    const alpha = headingFor('Alpha memory');
    expect(alpha?.open).toBe(true);
    act(() => {
      alpha?.querySelector('summary')?.click();
    });
    expect(headingFor('Alpha memory')?.open).toBe(true);
  });

  it('hoists a leading level-1 heading into the file row', async () => {
    readFile.mockResolvedValue({
      ...DOCUMENT,
      items: [
        {
          id: 'title',
          kind: 'heading',
          level: 1,
          text: '# Personal preferences',
          children: [DOCUMENT.items[0]],
        },
      ],
    });
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    const row = container.querySelector('[data-testid="memory-file"]');
    expect(
      row?.querySelector('[data-testid="memory-row-title"]')?.textContent,
    ).toBe('Personal preferences');
    expect(
      container.querySelector('[data-testid="memory-heading"]'),
    ).toBeNull();
    expect(container.textContent).toContain('Original memory');
    expect(
      row
        ?.querySelector('[data-testid="memory-item-edit"]')
        ?.getAttribute('aria-label'),
    ).toBe('Edit title');
    expect(row?.querySelector('[data-testid="memory-item-delete"]')).toBeNull();
  });

  it.each([
    ['# Personal preferences ##', 'Personal preferences'],
    ['# #', 'MEMORY.md'],
    ['# ###', 'MEMORY.md'],
    ['#', 'MEMORY.md'],
    ['#   ', 'MEMORY.md'],
    ['Setext ##\n===', 'Setext ##'],
    ['# C#', 'C#'],
    ['# Issue #3005', 'Issue #3005'],
    ['# Title#', 'Title#'],
    ['# C# ##', 'C#'],
    ['# Title \\#', 'Title \\#'],
    ['#\tTabbed\t##  ', 'Tabbed'],
    ['# Title ##\u00a0', 'Title ##'],
    ['# Title ##\u2003', 'Title ##'],
    ['# \u00a0#', '#'],
    ['\u00a0# Setext ##\n===', '# Setext ##'],
  ])(
    'keeps the title of %s normalized through loading and editing',
    async (text, title) => {
      let release: ((document: LocalMemoryDocument) => void) | undefined;
      const loaded: LocalMemoryDocument = {
        ...DOCUMENT,
        items: [
          {
            id: 'title',
            kind: 'heading',
            level: 1,
            text,
            children: [DOCUMENT.items[0]],
          },
        ],
      };
      const summaryTitle =
        text.includes('===') || title === 'MEMORY.md' ? undefined : title;
      listFiles.mockResolvedValue([{ ...FILES[0], title: summaryTitle }]);
      readFile.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      await act(async () => {
        root.render(<MemoryExplorer scope="user" />);
        await Promise.resolve();
      });
      const rowTitle = (): string | null | undefined =>
        container.querySelector(
          '[data-testid="memory-file"] [data-testid="memory-row-title"]',
        )?.textContent;
      expect(rowTitle()).toBe(summaryTitle ?? 'MEMORY.md');
      await act(async () => {
        release?.(loaded);
        await Promise.resolve();
      });
      expect(rowTitle()).toBe(title);
      expect(
        container.querySelector('[data-testid="memory-heading"]'),
      ).toBeNull();
      expect(container.textContent).toContain('Original memory');
      act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="memory-item-edit"]')
          ?.click();
      });
      const draft = container.querySelector<HTMLTextAreaElement>(
        '[data-testid="memory-item-draft"]',
      );
      expect(draft?.value).toBe(text);
      const updated = { ...loaded, revision: 'updated-revision' };
      updateItem.mockResolvedValue(updated);
      readFile.mockResolvedValue(updated);
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="memory-item-save"]')
          ?.click();
        await Promise.resolve();
      });
      expect(updateItem).toHaveBeenCalledWith({
        scope: 'user',
        fileKey: 'MEMORY.md',
        itemId: 'title',
        revision: DOCUMENT.revision,
        text,
      });
      expect(rowTitle()).toBe(title);
      expect(container.textContent).toContain('Original memory');
      for (const [nextText, nextTitle] of [
        ['# Updated preferences ##', 'Updated preferences'],
        ['# Updated ##\u00a0', 'Updated ##'],
        ['# #', 'MEMORY.md'],
      ]) {
        act(() => {
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="memory-item-edit"]',
            )
            ?.click();
        });
        const nextDraft = container.querySelector<HTMLTextAreaElement>(
          '[data-testid="memory-item-draft"]',
        );
        act(() => {
          Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value',
          )?.set?.call(nextDraft, nextText);
          nextDraft?.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const nextDocument: LocalMemoryDocument = {
          ...loaded,
          revision: 'next-revision',
          items: [{ ...loaded.items[0], text: nextText }],
        };
        updateItem.mockResolvedValue(nextDocument);
        readFile.mockResolvedValue(nextDocument);
        await act(async () => {
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="memory-item-save"]',
            )
            ?.click();
          await Promise.resolve();
        });
        expect(updateItem).toHaveBeenLastCalledWith(
          expect.objectContaining({ text: nextText }),
        );
        expect(rowTitle()).toBe(nextTitle);
        expect(container.textContent).toContain('Original memory');
      }
    },
  );

  it('deletes an item from an inline confirm with its id and revision', async () => {
    deleteItem.mockResolvedValue({ ...DOCUMENT, items: [] });
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="memory-item-delete"]')
        ?.click();
    });
    const confirm = container.querySelector<HTMLButtonElement>(
      '[data-testid="memory-item-editor"] [data-testid="memory-item-save"]',
    );
    expect(confirm?.textContent).toBe('Delete?');
    expect(
      container.querySelector('[data-testid="memory-item-draft"]'),
    ).toBeNull();
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
    });
    expect(deleteItem).toHaveBeenCalledWith({
      scope: 'user',
      fileKey: 'MEMORY.md',
      itemId: 'item-one',
      revision: 'original-revision',
    });
    expect(
      container.querySelector('[data-testid="memory-item-editor"]'),
    ).toBeNull();
  });

  it('watches its scope while mounted and unwatches on unmount', async () => {
    await act(async () => {
      root.render(<MemoryExplorer scope="workspace" projectId="project-1" />);
      await Promise.resolve();
    });
    expect(watchMemory).toHaveBeenCalledWith({
      scope: 'workspace',
      workspaceId: 'project-1',
    });
    expect(unwatchMemory).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(unwatchMemory).toHaveBeenCalledWith({
      scope: 'workspace',
      workspaceId: 'project-1',
    });
    root = createRoot(container);
  });

  it('hides the status line when nothing is pending and shows pending notes with the last run', async () => {
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    expect(getStatus).toHaveBeenCalledWith({ scope: 'user' });
    expect(statusLine()).toBeNull();
    getStatus.mockResolvedValue({
      ...IDLE_STATUS,
      pendingNotes: 1,
      lastRunAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      lastResult: 'success',
      lastConsolidatedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    });
    await act(async () => {
      notifyChange?.({ scope: 'user' });
      await Promise.resolve();
    });
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(statusLine()?.textContent).toBe(
      '1 note waiting to be consolidated · Consolidated 2h agoConsolidate now',
    );
    expect(statusLine()?.getAttribute('data-state')).toBe('pending');
    getStatus.mockResolvedValue({ ...IDLE_STATUS, pendingNotes: 3 });
    await act(async () => {
      notifyChange?.({ scope: 'user' });
      await Promise.resolve();
    });
    expect(statusLine()?.textContent).toBe(
      '3 notes waiting to be consolidatedConsolidate now',
    );
  });

  it('shows a failed run as a destructive line and a blocked model verbatim', async () => {
    getStatus.mockResolvedValue({
      ...IDLE_STATUS,
      lastRunAt: '2026-09-10T10:00:00Z',
      lastResult: 'failed',
      lastReason: 'invalid-output',
    });
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    expect(statusLine()?.textContent).toBe(
      "Couldn't consolidate memories: the model returned unusable outputConsolidate now",
    );
    expect(statusLine()?.className).toContain('fg-destructive');
    expect(statusLine()?.getAttribute('data-state')).toBe('problem');
    getStatus.mockResolvedValue({
      ...IDLE_STATUS,
      pendingNotes: 2,
      lastRunAt: '2026-09-10T10:00:00Z',
      lastResult: 'failed',
      lastReason: LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
    });
    await act(async () => {
      notifyChange?.({ scope: 'user' });
      await Promise.resolve();
    });
    expect(statusLine()?.textContent).toBe(
      `${LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE}Consolidate now`,
    );
    getStatus.mockResolvedValue({
      ...IDLE_STATUS,
      pendingNotes: 2,
      lastRunAt: '2026-09-10T10:00:00Z',
      lastResult: 'skipped',
      lastReason: LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
    });
    await act(async () => {
      notifyChange?.({ scope: 'user' });
      await Promise.resolve();
    });
    expect(statusLine()?.textContent).toBe(
      `${LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE}Consolidate now`,
    );
    expect(statusLine()?.getAttribute('data-state')).toBe('problem');
    getStatus.mockResolvedValue({
      ...IDLE_STATUS,
      lastRunAt: '2026-09-10T10:00:00Z',
      lastResult: 'skipped',
      lastReason: 'clean',
    });
    await act(async () => {
      notifyChange?.({ scope: 'user' });
      await Promise.resolve();
    });
    expect(statusLine()).toBeNull();
  });

  it('shows a running consolidation and disables the action', async () => {
    getStatus.mockResolvedValue({
      ...IDLE_STATUS,
      pendingNotes: 2,
      running: true,
    });
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    expect(statusLine()?.textContent).toBe('Consolidating…Consolidate now');
    expect(statusLine()?.getAttribute('data-state')).toBe('running');
    expect(consolidateButton()?.disabled).toBe(true);
  });

  it('consolidates now through the IPC and refreshes with the returned status', async () => {
    getStatus.mockResolvedValue({ ...IDLE_STATUS, pendingNotes: 2 });
    let finish: ((status: LocalMemoryConsolidationStatus) => void) | undefined;
    consolidate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    expect(consolidateButton()?.disabled).toBe(false);
    await act(async () => {
      consolidateButton()?.click();
      await Promise.resolve();
    });
    expect(consolidate).toHaveBeenCalledWith({ scope: 'user' });
    expect(statusLine()?.textContent).toBe('Consolidating…Consolidate now');
    expect(consolidateButton()?.disabled).toBe(true);
    expect(listFiles).toHaveBeenCalledTimes(1);
    getStatus.mockResolvedValue({
      ...IDLE_STATUS,
      lastRunAt: '2026-09-10T10:00:00Z',
      lastResult: 'success',
      lastConsolidatedAt: '2026-09-10T10:00:00Z',
    });
    await act(async () => {
      finish?.({
        ...IDLE_STATUS,
        lastRunAt: '2026-09-10T10:00:00Z',
        lastResult: 'success',
        lastConsolidatedAt: '2026-09-10T10:00:00Z',
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(statusLine()).toBeNull();
    expect(listFiles).toHaveBeenCalledTimes(2);
  });

  it('asks before rebuilding and rebuilds the scope through the IPC', async () => {
    let finish: ((response: LocalMemoryRebuildResponse) => void) | undefined;
    rebuild.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      root.render(<MemoryExplorer scope="workspace" projectId="project-1" />);
      await Promise.resolve();
    });
    expect(rebuildDialog()).toBeNull();
    act(() => {
      rebuildButton()?.click();
    });
    expect(rebuildDialog()?.textContent).toContain(
      "This project's memories are rebuilt",
    );
    expect(rebuild).not.toHaveBeenCalled();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="memory-rebuild-confirm"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(rebuild).toHaveBeenCalledWith({
      scope: 'workspace',
      workspaceId: 'project-1',
    });
    expect(rebuildDialog()).toBeNull();
    expect(statusLine()?.textContent).toBe(
      'Rebuilding memories…Consolidate now',
    );
    expect(rebuildButton()?.disabled).toBe(true);
    await act(async () => {
      finish?.({
        rebuild: {
          status: 'completed',
          snapshotId: '2026-09-30T12-00-00-000Z-0123abcd',
          restoredInboxNotes: 3,
          restoredImports: 0,
          runs: 1,
        },
        status: IDLE_STATUS,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(statusLine()).toBeNull();
    expect(rebuildButton()?.disabled).toBe(false);
  });

  it('leaves memory alone when the rebuild is cancelled', async () => {
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    act(() => {
      rebuildButton()?.click();
    });
    expect(rebuildDialog()?.textContent).toContain('Your memories are rebuilt');
    act(() => {
      Array.from(
        rebuildDialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [],
      )
        .find((button) => button.textContent === 'Cancel')
        ?.click();
    });
    expect(rebuildDialog()).toBeNull();
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('explains a rebuild that stopped with notes still waiting', async () => {
    rebuild.mockResolvedValue({
      rebuild: {
        status: 'stopped',
        reason: 'no-progress',
        snapshotId: null,
        restoredInboxNotes: 5,
        restoredImports: 0,
        runs: 2,
      },
      status: { ...IDLE_STATUS, pendingNotes: 3 },
    });
    getStatus.mockResolvedValue({ ...IDLE_STATUS, pendingNotes: 3 });
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    act(() => {
      rebuildButton()?.click();
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="memory-rebuild-confirm"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(statusLine()?.textContent).toBe(
      "Couldn't finish rebuilding memories: a run left the same notes waitingConsolidate now",
    );
    expect(statusLine()?.getAttribute('data-state')).toBe('problem');
  });

  it('drops a rebuild problem once a newer run reports its status', async () => {
    const stoppedStatus: LocalMemoryConsolidationStatus = {
      ...IDLE_STATUS,
      pendingNotes: 3,
      lastRunAt: '2026-09-10T10:00:00.000Z',
      lastResult: 'success',
    };
    rebuild.mockResolvedValue({
      rebuild: {
        status: 'stopped',
        reason: 'no-progress',
        snapshotId: null,
        restoredInboxNotes: 5,
        restoredImports: 0,
        runs: 2,
      },
      status: stoppedStatus,
    });
    getStatus.mockResolvedValue(stoppedStatus);
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    act(() => {
      rebuildButton()?.click();
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="memory-rebuild-confirm"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(statusLine()?.getAttribute('data-state')).toBe('problem');

    // A later background run succeeds and consolidates everything.
    getStatus.mockResolvedValue({
      ...IDLE_STATUS,
      pendingNotes: 1,
      lastRunAt: '2026-09-10T11:00:00.000Z',
      lastResult: 'success',
      lastConsolidatedAt: '2026-09-10T11:00:00.000Z',
    });
    await act(async () => {
      notifyChange?.({ scope: 'user' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(statusLine()?.getAttribute('data-state')).toBe('pending');
    expect(statusLine()?.textContent).not.toContain(
      "Couldn't finish rebuilding memories",
    );
  });

  it('shows why a rebuild was skipped when the memory model is unavailable', async () => {
    rebuild.mockResolvedValue({
      rebuild: {
        status: 'skipped',
        reason: LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
        snapshotId: null,
        restoredInboxNotes: 0,
        restoredImports: 0,
        runs: 0,
      },
      status: IDLE_STATUS,
    });
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    act(() => {
      rebuildButton()?.click();
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="memory-rebuild-confirm"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(statusLine()?.textContent).toBe(
      `${LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE}Consolidate now`,
    );
    expect(statusLine()?.getAttribute('data-state')).toBe('problem');
  });

  it('shows a rebuild started elsewhere and blocks another one', async () => {
    getStatus.mockResolvedValue({
      ...IDLE_STATUS,
      pendingNotes: 4,
      running: true,
      rebuilding: true,
    });
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    expect(statusLine()?.textContent).toBe(
      'Rebuilding memories…Consolidate now',
    );
    expect(rebuildButton()?.disabled).toBe(true);
    expect(consolidateButton()?.disabled).toBe(true);
  });

  it('disables Consolidate now while an item is being edited', async () => {
    getStatus.mockResolvedValue({ ...IDLE_STATUS, pendingNotes: 1 });
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    expect(consolidateButton()?.disabled).toBe(false);
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="memory-item-edit"]')
        ?.click();
    });
    expect(consolidateButton()?.disabled).toBe(true);
  });

  it('cancels editing with Escape and keeps the saved text', async () => {
    await act(async () => {
      root.render(<MemoryExplorer scope="user" />);
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="memory-item-edit"]')
        ?.click();
    });
    const textarea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="memory-item-draft"]',
    );
    expect(textarea).not.toBeNull();
    act(() => {
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(
      container.querySelector('[data-testid="memory-item-draft"]'),
    ).toBeNull();
    expect(updateItem).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Original memory');
  });
});

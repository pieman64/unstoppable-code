/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  LocalMemoryClient,
  LocalMemoryFile,
  LocalMemoryFileDocument,
  LocalMemoryNotice,
  LocalMemoryScope,
  LocalMemoryStatus,
} from '@canopy/app-core/local-memory';
import { MEMORY_UNDO_WINDOW_MS, MemoryPanel } from '../MemoryPanel';
import { memoryRowId, type MemoryPanelScope } from '../memory-model';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const USER: MemoryPanelScope = {
  scope: { scope: 'user' },
  label: 'Everywhere',
  savedFor: 'Every project',
};
const PROJECT: MemoryPanelScope = {
  scope: { scope: 'workspace', workspaceId: 'project-1' },
  label: 'canopy',
  savedFor: 'canopy',
};

const TOPIC: LocalMemoryFile = {
  fileKey: 'topics/no-em-dashes.md',
  kind: 'topic',
  modifiedAt: new Date().toISOString(),
  sizeBytes: 40,
  title: 'No em dashes',
  excerpt: 'Never use em dashes in copy.',
  usageCount: 14,
};
const NOTE: LocalMemoryFile = {
  fileKey: 'inbox/20261023-ports.md',
  kind: 'inbox',
  modifiedAt: new Date(Date.now() - 60_000).toISOString(),
  sizeBytes: 40,
  title: 'Dev server ports',
  excerpt: 'Use 3008 when 3007 is taken.',
  source: { provider: 'claude', chatId: 'chat-7' },
};
const TOPIC_DOCUMENT: LocalMemoryFileDocument = {
  fileKey: TOPIC.fileKey,
  revision: 'rev-topic',
  markdown: '# No em dashes\n\nNever use em dashes in copy.\n',
  items: [
    {
      id: '0:14',
      kind: 'heading',
      level: 1,
      text: '# No em dashes',
      children: [
        {
          id: '16:44',
          kind: 'paragraph',
          text: 'Never use em dashes in copy.',
          children: [],
        },
      ],
    },
  ],
};
const NOTE_DOCUMENT: LocalMemoryFileDocument = {
  fileKey: NOTE.fileKey,
  revision: 'rev-note',
  markdown: '\nDev server ports\nUse 3008 when 3007 is taken.\n',
  items: [
    {
      id: '60:120',
      kind: 'paragraph',
      text: 'Dev server ports\nUse 3008 when 3007 is taken.',
      children: [],
    },
  ],
};

const STATUS: LocalMemoryStatus = {
  pendingNotes: 0,
  running: false,
  rebuilding: false,
  lastRunAt: null,
  lastResult: null,
  lastReason: null,
  lastConsolidatedAt: null,
};

/** Every `watch` listener the panel registered, as file changes call them. */
let listeners: Array<() => void> = [];
/** Every `watchChats` listener, as chat list changes call them. */
let chatListeners: Array<() => void> = [];

/** Mock functions kept apart from the client so assertions use plain functions. */
type FakeMocks = { [Key in keyof LocalMemoryClient]: jest.Mock };

function fakeMocks(): FakeMocks {
  const lists = new Map<string, LocalMemoryFile[]>([
    ['user', [TOPIC]],
    ['workspace', [NOTE]],
  ]);
  return {
    list: jest.fn((scope: LocalMemoryScope) =>
      Promise.resolve(lists.get(scope.scope) ?? []),
    ),
    read: jest.fn((scope: LocalMemoryScope, fileKey: string) =>
      Promise.resolve(
        fileKey === TOPIC.fileKey ? TOPIC_DOCUMENT : NOTE_DOCUMENT,
      ),
    ),
    updateFile: jest.fn(() => Promise.resolve(TOPIC_DOCUMENT)),
    deleteFile: jest.fn(() => Promise.resolve()),
    status: jest.fn(() => Promise.resolve(STATUS)),
    consolidate: jest.fn(() => Promise.resolve(STATUS)),
    rebuild: jest.fn(() =>
      Promise.resolve({ rebuild: { status: 'completed' }, status: STATUS }),
    ),
    watch: jest.fn((_scope: LocalMemoryScope, listener: () => void) => {
      listeners.push(listener);
      return (): void => undefined;
    }),
    lookupChats: jest.fn(() =>
      Promise.resolve(new Map([['chat-7', { title: 'Fix the tab crash' }]])),
    ),
    watchChats: jest.fn((listener: () => void) => {
      chatListeners.push(listener);
      return (): void => undefined;
    }),
    openChat: jest.fn(() => Promise.resolve({ ok: true })),
    openSettings: jest.fn(),
    openLink: jest.fn(),
  };
}

let container: HTMLDivElement;
let root: Root;
let mocks: FakeMocks;
let client: LocalMemoryClient;
let notices: LocalMemoryNotice[];

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

async function renderPanel(scopes = [USER, PROJECT]): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryPanel
        client={client}
        notify={(notice) => notices.push(notice)}
        scopes={scopes}
        showSettingsLink
      />,
    );
    await Promise.resolve();
  });
  await flush();
}

/** The refresh the panel registered with `watch`, as a file change would. */
function watchedRefresh(): void {
  for (const listener of listeners) listener();
}

function byTestId(testId: string): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
  );
}

function click(element: Element | undefined): void {
  if (!element) throw new Error('missing element');
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function type(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(
      input,
      value,
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  listeners = [];
  chatListeners = [];
  mocks = fakeMocks();
  client = mocks;
  notices = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

describe('MemoryPanel', () => {
  it('lists memories from every scope as rows with their source and scope', async () => {
    await renderPanel();
    const rows = byTestId('memory-row');
    expect(rows.map((row) => row.dataset.memoryId)).toEqual([
      memoryRowId(TOPIC.fileKey),
      memoryRowId(NOTE.fileKey),
    ]);
    expect(byTestId('memory-row-meta').map((meta) => meta.textContent)).toEqual(
      ['Everywhere', 'Fix the tab crash · canopy · Recent note'],
    );
    expect(byTestId('memory-row-excerpt')[0].textContent).toBe(
      'Never use em dashes in copy.',
    );
    expect(mocks.watch).toHaveBeenCalledTimes(2);
  });

  it('opens a memory with its source, scope, kind, time and usage', async () => {
    await renderPanel();
    click(byTestId('memory-row-open')[1]);
    await flush();
    expect(byTestId('memory-detail-title')[0].textContent).toBe(
      'Dev server ports',
    );
    expect(byTestId('memory-detail-body')[0].textContent).toContain(
      'Use 3008 when 3007 is taken.',
    );
    const facts = byTestId('memory-detail-facts')[0].textContent ?? '';
    expect(facts).toContain('SourceChat · Fix the tab crash');
    expect(facts).toContain('Saved forcanopy');
    expect(facts).toContain('KindRecent note');
    expect(facts).toMatch(/SavedToday at/);
    // Usage is unknown for this note, so it has no Used row.
    expect(facts).not.toContain('Used');
    click(byTestId('memory-detail-source')[0]);
    await flush();
    expect(mocks.openChat).toHaveBeenCalledWith('chat-7');
    click(byTestId('memory-detail-back')[0]);
    click(byTestId('memory-row-open')[0]);
    await flush();
    expect(byTestId('memory-detail-usage')[0].textContent).toBe('14 times');
    expect(byTestId('memory-detail-facts')[0].textContent).toContain(
      'Saved forEvery project',
    );
  });

  it('edits the title and body and saves at the revision it read', async () => {
    await renderPanel();
    click(byTestId('memory-row-open')[0]);
    await flush();
    click(byTestId('memory-detail-edit')[0]);
    await flush();
    const title = byTestId('memory-item-title')[0];
    const body = byTestId('memory-item-draft')[0];
    if (
      !(title instanceof HTMLInputElement) ||
      !(body instanceof HTMLTextAreaElement)
    )
      throw new Error('editor fields missing');
    expect(title.value).toBe('No em dashes');
    expect(body.value).toBe('Never use em dashes in copy.');
    type(title, '');
    expect(document.body.textContent).toContain('Add a title.');
    expect(byTestId('memory-item-save')[0]).toHaveProperty('disabled', true);
    type(title, 'No em dashes (copy)');
    type(body, 'Never in copy or comments.');
    click(byTestId('memory-item-save')[0]);
    await flush();
    expect(mocks.updateFile).toHaveBeenCalledWith(USER.scope, {
      fileKey: TOPIC.fileKey,
      revision: 'rev-topic',
      title: 'No em dashes (copy)',
      body: 'Never in copy or comments.',
    });
    expect(notices.map((notice) => notice.message)).toContain('Memory saved');
    expect(byTestId('memory-item-editor')).toHaveLength(0);
  });

  it('closes the editor without writing when nothing changed', async () => {
    await renderPanel();
    click(byTestId('memory-row-open')[0]);
    await flush();
    click(byTestId('memory-detail-edit')[0]);
    await flush();
    click(byTestId('memory-item-save')[0]);
    await flush();
    expect(mocks.updateFile).not.toHaveBeenCalled();
    expect(byTestId('memory-item-editor')).toHaveLength(0);
  });

  it('keeps the draft and explains a conflict when the file changed', async () => {
    mocks.updateFile.mockRejectedValueOnce(
      new Error('Memory changed since you opened it. Refresh before saving.'),
    );
    await renderPanel();
    click(byTestId('memory-row-open')[0]);
    await flush();
    click(byTestId('memory-detail-edit')[0]);
    await flush();
    const body = byTestId('memory-item-draft')[0];
    if (!(body instanceof HTMLTextAreaElement)) throw new Error('no body');
    type(body, 'Changed while the file changed.');
    click(byTestId('memory-item-save')[0]);
    await flush();
    expect(document.body.textContent).toContain(
      "Couldn't save because this memory changed.",
    );
    expect(byTestId('memory-item-editor')).toHaveLength(1);
  });

  it('deletes after the Undo window and brings a memory back with Undo', async () => {
    jest.useFakeTimers();
    await renderPanel();
    click(byTestId('memory-row-open')[0]);
    await flush();
    click(byTestId('memory-detail-delete')[0]);
    await flush();
    expect(byTestId('memory-row').map((row) => row.dataset.memoryId)).toEqual([
      memoryRowId(NOTE.fileKey),
    ]);
    const undo = notices.find((notice) => notice.action)?.action;
    expect(notices.at(-1)?.message).toBe('Deleted “No em dashes”');
    act(() => undo?.run());
    expect(byTestId('memory-row')).toHaveLength(2);
    act(() => {
      jest.advanceTimersByTime(MEMORY_UNDO_WINDOW_MS + 1);
    });
    expect(mocks.deleteFile).not.toHaveBeenCalled();

    const menu = document.querySelector<HTMLElement>(
      `[data-memory-id="${memoryRowId(NOTE.fileKey)}"] [data-testid="memory-row-menu"]`,
    );
    click(menu ?? undefined);
    const deleteItem = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes('Delete'));
    click(deleteItem);
    await flush();
    expect(byTestId('memory-row')).toHaveLength(1);
    act(() => {
      jest.advanceTimersByTime(MEMORY_UNDO_WINDOW_MS + 1);
    });
    await flush();
    expect(mocks.deleteFile).toHaveBeenCalledWith(PROJECT.scope, {
      fileKey: NOTE.fileKey,
      revision: 'rev-note',
    });
    // Undo after the window says the memory is gone instead of doing nothing.
    const lateUndo = notices.at(-1)?.action;
    act(() => lateUndo?.run());
    expect(notices.at(-1)).toMatchObject({
      message: '“Dev server ports” was already deleted.',
      tone: 'error',
    });
  });

  it('deletes a memory waiting for Undo at once when the panel closes', async () => {
    await renderPanel();
    click(byTestId('memory-row-open')[0]);
    await flush();
    click(byTestId('memory-detail-delete')[0]);
    await flush();
    act(() => root.unmount());
    root = createRoot(container);
    expect(mocks.deleteFile).toHaveBeenCalledWith(USER.scope, {
      fileKey: TOPIC.fileKey,
      revision: 'rev-topic',
    });
  });

  it('keeps the Undo window when the panel gets a new client', async () => {
    jest.useFakeTimers();
    await renderPanel();
    click(byTestId('memory-row-open')[0]);
    await flush();
    click(byTestId('memory-detail-delete')[0]);
    await flush();
    const undo = notices.find((notice) => notice.action)?.action;
    const next = fakeMocks();
    client = next;
    await renderPanel();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(next.deleteFile).not.toHaveBeenCalled();
    act(() => undo?.run());
    expect(byTestId('memory-row')).toHaveLength(2);
    act(() => {
      jest.advanceTimersByTime(MEMORY_UNDO_WINDOW_MS + 1);
    });
    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(next.deleteFile).not.toHaveBeenCalled();
  });

  it('shows a memory saved again under the name of one it deleted', async () => {
    jest.useFakeTimers();
    await renderPanel([USER]);
    click(byTestId('memory-row-open')[0]);
    await flush();
    click(byTestId('memory-detail-delete')[0]);
    await flush();
    act(() => {
      jest.advanceTimersByTime(MEMORY_UNDO_WINDOW_MS + 1);
    });
    await flush();
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
    // Rebuild writes topics/no-em-dashes.md again and the list refreshes.
    act(() => watchedRefresh());
    await flush();
    expect(byTestId('memory-row').map((row) => row.dataset.memoryId)).toEqual([
      memoryRowId(TOPIC.fileKey),
    ]);
  });

  it('shows the empty state, not a filter message, when the last memory waits for Undo', async () => {
    await renderPanel([USER]);
    click(byTestId('memory-row-open')[0]);
    await flush();
    click(byTestId('memory-detail-delete')[0]);
    await flush();
    expect(byTestId('memory-empty')).toHaveLength(1);
    expect(byTestId('memory-empty-filters')).toHaveLength(0);
  });

  it('keeps the open draft when an earlier memory finishes loading late', async () => {
    let releaseTopic: (document: LocalMemoryFileDocument) => void = () =>
      undefined;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise<LocalMemoryFileDocument>((resolve) => {
          releaseTopic = resolve;
        }),
    );
    await renderPanel();
    click(
      document.querySelector<HTMLElement>(
        `[data-memory-id="${memoryRowId(TOPIC.fileKey)}"] [data-testid="memory-row-menu"]`,
      ) ?? undefined,
    );
    click(
      Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).find((item) => item.textContent?.includes('Edit')),
    );
    await flush();
    click(byTestId('memory-detail-back')[0]);
    click(byTestId('memory-row-open')[1]);
    await flush();
    click(byTestId('memory-detail-edit')[0]);
    await flush();
    const body = byTestId('memory-item-draft')[0];
    if (!(body instanceof HTMLTextAreaElement)) throw new Error('no body');
    type(body, 'My draft for the ports note.');
    await act(async () => {
      releaseTopic(TOPIC_DOCUMENT);
      await Promise.resolve();
    });
    await flush();
    expect(byTestId('memory-item-title')).toHaveLength(0);
    expect(byTestId('memory-item-draft')[0]).toHaveProperty(
      'value',
      'My draft for the ports note.',
    );
  });

  it('keeps the draft when the memory being edited is removed elsewhere', async () => {
    await renderPanel();
    click(byTestId('memory-row-open')[0]);
    await flush();
    click(byTestId('memory-detail-edit')[0]);
    await flush();
    const body = byTestId('memory-item-draft')[0];
    if (!(body instanceof HTMLTextAreaElement)) throw new Error('no body');
    type(body, 'A draft worth keeping.');
    mocks.list.mockImplementation((scope: LocalMemoryScope) =>
      Promise.resolve(scope.scope === 'user' ? [] : [NOTE]),
    );
    act(() => watchedRefresh());
    await flush();
    expect(byTestId('memory-item-draft')[0]).toHaveProperty(
      'value',
      'A draft worth keeping.',
    );
    expect(byTestId('memory-item-removed')).toHaveLength(1);
    expect(byTestId('memory-item-save')[0]).toHaveProperty('disabled', true);
    click(byTestId('memory-item-cancel')[0]);
    await flush();
    expect(byTestId('memory-detail')).toHaveLength(0);
    expect(byTestId('memory-row').map((row) => row.dataset.memoryId)).toEqual([
      memoryRowId(NOTE.fileKey),
    ]);
  });

  it('shows a project name that arrives after the panel opens', async () => {
    await renderPanel([
      USER,
      { ...PROJECT, label: 'This project', savedFor: 'This project' },
    ]);
    await renderPanel();
    const note = document.querySelector(
      `[data-memory-id="${memoryRowId(NOTE.fileKey)}"]`,
    );
    expect(note?.textContent).toContain('canopy');
    expect(note?.textContent).not.toContain('This project');
  });

  it('keeps a deleted row hidden until a list without it arrives', async () => {
    jest.useFakeTimers();
    await renderPanel([USER]);
    click(byTestId('memory-row-open')[0]);
    await flush();
    click(byTestId('memory-detail-delete')[0]);
    await flush();
    let releaseList: (files: LocalMemoryFile[]) => void = () => undefined;
    mocks.list.mockImplementation(
      () =>
        new Promise<LocalMemoryFile[]>((resolve) => {
          releaseList = resolve;
        }),
    );
    act(() => {
      jest.advanceTimersByTime(MEMORY_UNDO_WINDOW_MS + 1);
    });
    await flush();
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
    // The delete finished but the refreshed list hasn't arrived yet.
    expect(byTestId('memory-row')).toHaveLength(0);
    await act(async () => {
      releaseList([]);
      await Promise.resolve();
    });
    await flush();
    expect(byTestId('memory-row')).toHaveLength(0);
  });

  it('keeps the editor when its file was the last memory, even when hiding while empty', async () => {
    await act(async () => {
      root.render(
        <MemoryPanel
          client={client}
          notify={(notice) => notices.push(notice)}
          scopes={[USER]}
          hideWhenEmpty
        />,
      );
      await Promise.resolve();
    });
    await flush();
    click(byTestId('memory-row-open')[0]);
    await flush();
    click(byTestId('memory-detail-edit')[0]);
    await flush();
    mocks.list.mockResolvedValue([]);
    act(() => watchedRefresh());
    await flush();
    expect(byTestId('memory-item-editor')).toHaveLength(1);
    expect(byTestId('memory-item-removed')).toHaveLength(1);
  });

  it('leaves the view alone when a save finishes after the user moved on', async () => {
    let releaseSave: (document: LocalMemoryFileDocument) => void = () =>
      undefined;
    mocks.updateFile.mockImplementationOnce(
      () =>
        new Promise<LocalMemoryFileDocument>((resolve) => {
          releaseSave = resolve;
        }),
    );
    await renderPanel();
    click(byTestId('memory-row-open')[0]);
    await flush();
    click(byTestId('memory-detail-edit')[0]);
    await flush();
    const body = byTestId('memory-item-draft')[0];
    if (!(body instanceof HTMLTextAreaElement)) throw new Error('no body');
    type(body, 'Changed copy rule.');
    click(byTestId('memory-item-save')[0]);
    await flush();
    click(byTestId('memory-detail-back')[0]);
    click(byTestId('memory-row-open')[1]);
    await flush();
    await act(async () => {
      releaseSave(TOPIC_DOCUMENT);
      await Promise.resolve();
    });
    await flush();
    expect(byTestId('memory-detail-title')[0].textContent).toBe(NOTE.title);
    expect(notices.map((notice) => notice.message)).toContain('Memory saved');
  });

  it('reports a delete that fails as the panel closes, and a late Undo says so', async () => {
    mocks.deleteFile.mockRejectedValueOnce(
      new Error('Memory changed since you opened it. Refresh before saving.'),
    );
    await renderPanel([USER]);
    click(byTestId('memory-row-open')[0]);
    await flush();
    click(byTestId('memory-detail-delete')[0]);
    await flush();
    const undo = notices.find((notice) => notice.action)?.action;
    act(() => root.unmount());
    root = createRoot(container);
    await flush();
    expect(notices.at(-1)).toMatchObject({
      message: 'Couldn’t delete “No em dashes”.'.replace('’', "'"),
      tone: 'error',
    });
    act(() => undo?.run());
    expect(notices.at(-1)?.message).toBe(
      "“No em dashes” wasn't deleted, so there's nothing to undo.",
    );
  });

  it('masks memory titles and project names and blocks memory text from replay', async () => {
    await renderPanel();
    const row = document.querySelector(
      `[data-memory-id="${memoryRowId(NOTE.fileKey)}"]`,
    );
    expect(
      row?.querySelector('[data-testid="memory-row-title"]')?.classList,
    ).toContain('ph-mask');
    expect(
      row?.querySelector('[data-testid="memory-row-meta"]')?.classList,
    ).toContain('ph-mask');
    expect(
      row?.querySelector('[data-testid="memory-row-excerpt"]')?.classList,
    ).toContain('ph-no-capture');
    click(byTestId('memory-filter-trigger')[0]);
    const menuLabels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"] span'),
    ).filter((span) => span.textContent === PROJECT.label);
    expect(menuLabels.length).toBeGreaterThan(0);
    expect(menuLabels.some((span) => span.classList.contains('ph-mask'))).toBe(
      true,
    );
  });

  it('deletes a memory waiting for Undo when the window unloads', async () => {
    await renderPanel([USER]);
    click(byTestId('memory-row-open')[0]);
    await flush();
    click(byTestId('memory-detail-delete')[0]);
    await flush();
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(mocks.deleteFile).toHaveBeenCalledWith(USER.scope, {
      fileKey: TOPIC.fileKey,
      revision: 'rev-topic',
    });
  });

  it('keeps file names out of row attributes', async () => {
    await renderPanel();
    for (const row of byTestId('memory-row'))
      for (const attribute of Array.from(row.attributes)) {
        expect(attribute.value).not.toContain('inbox/');
        expect(attribute.value).not.toContain('topics/');
      }
  });

  it('names the row menu without the memory title', async () => {
    await renderPanel([USER]);
    const menu = byTestId('memory-row-menu')[0];
    expect(menu.getAttribute('aria-label')).toBe('More actions');
  });

  it('reports a delete that fails after the panel closed', async () => {
    jest.useFakeTimers();
    let rejectDelete: (failure: Error) => void = () => undefined;
    mocks.deleteFile.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectDelete = reject;
        }),
    );
    await renderPanel([USER]);
    click(byTestId('memory-row-open')[0]);
    await flush();
    click(byTestId('memory-detail-delete')[0]);
    await flush();
    act(() => {
      jest.advanceTimersByTime(MEMORY_UNDO_WINDOW_MS + 1);
    });
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      rejectDelete(new Error('Memory changed since you opened it.'));
      await Promise.resolve();
    });
    await flush();
    expect(notices.at(-1)).toMatchObject({
      message: "Couldn't delete “No em dashes” because it changed.",
      tone: 'error',
    });
  });

  it('looks up source chats again when the chat list changes', async () => {
    mocks.lookupChats.mockResolvedValueOnce(new Map());
    await renderPanel();
    const note = (): Element | null =>
      document.querySelector(
        `[data-memory-id="${memoryRowId(NOTE.fileKey)}"] [data-testid="memory-row-meta"]`,
      );
    expect(note()?.textContent).not.toContain('Fix the tab crash');
    act(() => {
      for (const listener of chatListeners) listener();
    });
    await flush();
    expect(mocks.lookupChats).toHaveBeenCalledTimes(2);
    expect(note()?.textContent).toContain('Fix the tab crash');
  });

  it('keeps a draft when an older read for the same memory finishes late', async () => {
    let releaseFirst: (document: LocalMemoryFileDocument) => void = () =>
      undefined;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise<LocalMemoryFileDocument>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    await renderPanel([USER]);
    // Edit from the row menu: its read is still running.
    click(
      document.querySelector<HTMLElement>(
        `[data-memory-id="${memoryRowId(TOPIC.fileKey)}"] [data-testid="memory-row-menu"]`,
      ) ?? undefined,
    );
    click(
      Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).find((item) => item.textContent?.includes('Edit')),
    );
    await flush();
    // Edit again from the detail view, which already has the document.
    click(byTestId('memory-detail-edit')[0]);
    await flush();
    const body = byTestId('memory-item-draft')[0];
    if (!(body instanceof HTMLTextAreaElement)) throw new Error('no body');
    type(body, 'My unsaved draft');
    await act(async () => {
      releaseFirst(TOPIC_DOCUMENT);
      await Promise.resolve();
    });
    await flush();
    expect(byTestId('memory-item-draft')[0]).toHaveProperty(
      'value',
      'My unsaved draft',
    );
  });

  it("shows an older host's memory from its items and does not offer to edit it", async () => {
    const legacy: LocalMemoryFileDocument = {
      fileKey: TOPIC_DOCUMENT.fileKey,
      revision: TOPIC_DOCUMENT.revision,
      items: TOPIC_DOCUMENT.items,
    };
    mocks.read.mockResolvedValue(legacy);
    await renderPanel([USER]);
    click(byTestId('memory-row-open')[0]);
    await flush();
    expect(byTestId('memory-detail-body')[0].textContent).toContain(
      'Never use em dashes in copy.',
    );
    expect(byTestId('memory-detail-edit')[0]).toHaveProperty('disabled', true);
  });

  it('says when a search or filters match nothing and clears them', async () => {
    await renderPanel();
    const search = byTestId('memory-search')[0];
    if (!(search instanceof HTMLInputElement)) throw new Error('no search');
    type(search, 'nothing like this');
    // The search text stays out of the message, which session replay records.
    expect(byTestId('memory-empty-search')[0].textContent).toContain(
      'No memories match your search.',
    );
    expect(byTestId('memory-empty-search')[0].textContent).not.toContain(
      'nothing like this',
    );
    click(
      Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Clear search',
      ),
    );
    expect(byTestId('memory-row')).toHaveLength(2);
    click(byTestId('memory-filter-trigger')[0]);
    click(byTestId('memory-filter-kind-topic')[0]);
    click(byTestId('memory-filter-kind-inbox')[0]);
    expect(byTestId('memory-filter-count')[0].textContent).toBe('Index');
    expect(byTestId('memory-empty-filters')).toHaveLength(1);
  });

  it('reports emptiness and hides while empty for the activity rail', async () => {
    mocks.list.mockResolvedValue([]);
    const onEmptyChange = jest.fn();
    await act(async () => {
      root.render(
        <MemoryPanel
          client={client}
          notify={() => undefined}
          scopes={[USER]}
          hideWhenEmpty
          onEmptyChange={onEmptyChange}
        />,
      );
      await Promise.resolve();
    });
    await flush();
    expect(onEmptyChange).toHaveBeenLastCalledWith(true);
    expect(container.innerHTML).toBe('');
  });

  it('says when memories were last consolidated next to the waiting count', async () => {
    mocks.status.mockResolvedValue({
      ...STATUS,
      pendingNotes: 1,
      lastResult: 'success',
      lastConsolidatedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    await renderPanel([USER]);
    expect(byTestId('memory-consolidation-status')[0].textContent).toMatch(
      /1 note waiting to be consolidated · Consolidated \d+s ago/,
    );
  });

  it('runs rebuild and consolidation on the last scope', async () => {
    mocks.status.mockResolvedValue({
      pendingNotes: 2,
      running: false,
      rebuilding: false,
      lastRunAt: null,
      lastResult: null,
      lastReason: null,
      lastConsolidatedAt: null,
    });
    mocks.consolidate.mockResolvedValue({
      pendingNotes: 0,
      running: false,
      rebuilding: false,
      lastRunAt: 'now',
      lastResult: 'success',
      lastReason: null,
      lastConsolidatedAt: 'now',
    });
    await renderPanel();
    expect(byTestId('memory-consolidation-status')[0].textContent).toContain(
      '2 notes waiting to be consolidated',
    );
    click(byTestId('memory-consolidate')[0]);
    await flush();
    expect(mocks.consolidate).toHaveBeenCalledWith(PROJECT.scope);
    expect(mocks.status).toHaveBeenCalledWith(PROJECT.scope);
  });
});

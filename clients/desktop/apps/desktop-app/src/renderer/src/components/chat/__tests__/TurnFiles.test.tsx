/** @jest-environment jsdom */
import { act } from 'react';
import {
  ChatLookProvider,
  TurnFileChipView,
} from '@canopy/ui-shared/components';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import type {
  OpenTurnFileRequest,
  ShowFilesRendererResult,
} from '@canopy/desktop-shared/types';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { TurnFileChip, type TurnFileChipProps } from '../TurnFiles';
import { showFilesInRenderer } from '@/lib/show-files';
import { WorkspaceAccessContext } from '@/lib/workspace-access';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

let mockProjects: Array<{ id: string; name: string }> = [];
let mockClosingPath: string | undefined;
let mockSurface: 'main' | 'app-advisor' = 'app-advisor';
let mockChatListener: () => void = () => {};

it('a new approval wait supersedes stale file-opening state (CAN-5291)', () => {
  const html = renderToStaticMarkup(
    <TurnFileChipView
      filename="report.md"
      pending
      waiting
      opening
      status="Opening…"
      onOpen={() => {}}
    />,
  );
  expect(html).toContain('Waiting for approval');
  expect(html).toContain('aria-busy="false"');
  expect(html).not.toContain('Opening…');
});

jest.mock('@/lib/show-files', () => ({ showFilesInRenderer: jest.fn() }));
jest.mock('@/stores/chat/surface', () => ({
  detectChatStoreSurface: (): string => mockSurface,
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): unknown => ({
      worktreeChats: {
        'cowork-1/entry-1': {
          tabs: mockClosingPath
            ? [{ id: 'closing-file', kind: 'file', filePath: mockClosingPath }]
            : [],
        },
      },
      closingChatTabs: {
        'cowork-1/entry-1': new Set(mockClosingPath ? ['closing-file'] : []),
      },
    }),
    subscribe: jest.fn((listener: () => void) => {
      mockChatListener = listener;
      return jest.fn();
    }),
  },
}));
jest.mock('@/stores/browserStore', () => ({
  useBrowserStore: { subscribe: jest.fn(() => jest.fn()) },
}));
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: <T,>(
    selector: (state: { projects: typeof mockProjects }) => T,
  ): T => selector({ projects: mockProjects }),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

async function flush(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

it.each(['md', 'html'])(
  'opens an App Advisor %s deliverable in the explicitly selected workspace',
  async (extension) => {
    let closed: (requestId: string) => void = () => {};
    const dispose = jest.fn();
    const openWindow = jest
      .fn()
      .mockResolvedValue({ open: true, focused: true });
    const openTurnFile = jest
      .fn<Promise<ShowFilesRendererResult>, [OpenTurnFileRequest]>()
      .mockResolvedValue({
        opened: 1,
        failed: 0,
        files: [
          {
            path: `/project/report.${extension}`,
            ok: true,
            ...(extension === 'html'
              ? { browserId: 'browser-page' }
              : { tabId: 'file-tab' }),
          },
        ],
      });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        appAdvisor: {
          openTurnFile,
          openWindow,
          onTurnFileClosed: (listener: typeof closed) => {
            closed = listener;
            return dispose;
          },
        },
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await flush(() =>
      root.render(
        <TurnFileChip
          path={`/project/report.${extension}`}
          target={{ projectId: 'project', worktreeId: 'worktree' }}
          projectId="app-advisor"
          worktreeId="global"
          chatId="chat"
        />,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>(
      `[aria-label="Open report.${extension}"]`,
    );
    if (!button) throw new Error('Missing file tile');
    button.focus();
    await flush(() => button.click());

    expect(openTurnFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/project/report.${extension}`,
        target: { projectId: 'project', worktreeId: 'worktree' },
        origin: {
          projectId: 'app-advisor',
          worktreeId: 'global',
          chatTabId: 'chat',
        },
      }),
    );
    await flush(() => button.click());
    expect(openTurnFile).toHaveBeenLastCalledWith(
      expect.objectContaining(
        extension === 'html'
          ? { reuseBrowserId: 'browser-page' }
          : { path: `/project/report.${extension}` },
      ),
    );
    expect(showFilesInRenderer).not.toHaveBeenCalled();
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    await flush(() => closed('unrelated-viewer'));
    expect(openWindow).not.toHaveBeenCalled();
    const request: unknown = openTurnFile.mock.calls[0]?.[0];
    if (
      typeof request !== 'object' ||
      request === null ||
      !('focusReturnId' in request) ||
      typeof request.focusReturnId !== 'string'
    )
      throw new Error('Missing cross-window focus return identity');
    const focusReturnId = request.focusReturnId;
    await flush(() => closed(focusReturnId));
    expect(openWindow).toHaveBeenCalledWith({ focus: true });
    expect(document.activeElement).toBe(button);
    expect(dispose).toHaveBeenCalled();
    other.remove();
    await flush(() => root.unmount());
    container.remove();
  },
);

it('marks an in-window file tile open as explicit user intent', async () => {
  // A pending browser handoff backgrounds agent presentation; a click on a
  // file tile is the user's own choice and must still open in front.
  jest.mocked(showFilesInRenderer).mockResolvedValue({
    opened: 1,
    failed: 0,
    files: [{ path: '/advisor/report.md', ok: true, tabId: 'file-tab' }],
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await flush(() =>
    root.render(
      <TurnFileChip
        path="/advisor/report.md"
        projectId="app-advisor"
        worktreeId="global"
        chatId="chat"
      />,
    ),
  );
  const button = container.querySelector<HTMLButtonElement>(
    '[aria-label="Open report.md"]',
  );
  if (!button) throw new Error('Missing file tile');
  await flush(() => button.click());

  expect(showFilesInRenderer).toHaveBeenCalledWith(
    expect.objectContaining({ intent: 'user' }),
    'app-advisor',
    expect.anything(),
  );
  await flush(() => root.unmount());
  container.remove();
});

describe('reveal and saved location', () => {
  const CSV = '/Users/priya/Vendor Spend Q3/vendor-spend-cleaned.csv';
  let showInFinder: jest.Mock;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let look: 'classic' | 'clean' = 'classic';

  beforeEach(() => {
    mockClosingPath = undefined;
    mockSurface = 'app-advisor';
    look = 'classic';
    mockProjects = [
      { id: 'cowork-1', name: 'Vendor Spend Q3' },
      { id: 'project', name: 'Advisor target' },
    ];
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    showInFinder = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { showInFinder },
    });
    jest.mocked(showFilesInRenderer).mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await flush(() => root.unmount());
    container.remove();
  });

  async function renderChips(
    chips: Array<Partial<TurnFileChipProps>>,
    readOnly = false,
  ): Promise<void> {
    const content = (
      <ChatLookProvider value={look}>
        {chips.map((chip, index) => (
          <TurnFileChip
            key={index}
            path={CSV}
            absolutePath={CSV}
            projectId="cowork-1"
            worktreeId="entry-1"
            chatId="chat"
            {...chip}
          />
        ))}
      </ChatLookProvider>
    );
    await flush(() =>
      root.render(
        readOnly ? (
          <WorkspaceAccessContext.Provider
            value={{
              mode: 'read-only',
              reason: 'shared-container',
              containerType: 'COWORK_WORK_ENTRY',
              runAllowed: false,
            }}
          >
            {content}
          </WorkspaceAccessContext.Provider>
        ) : (
          content
        ),
      ),
    );
  }

  const reveals = (): HTMLButtonElement[] =>
    Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="turn-file-chip-reveal"]',
      ),
    );

  it('waits for the same file to finish closing before reopening an updated chip', async () => {
    mockSurface = 'main';
    await renderChips([{ change: 'updated' }]);
    mockClosingPath = CSV;
    jest.mocked(showFilesInRenderer).mockResolvedValue({
      opened: 1,
      failed: 0,
      files: [{ path: CSV, ok: true, tabId: 'reopened-file' }],
    });
    await flush(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="turn-file-chip-open"]')
        ?.click(),
    );
    expect(showFilesInRenderer).not.toHaveBeenCalled();
    await flush(() => {
      mockClosingPath = undefined;
      mockChatListener();
    });
    expect(showFilesInRenderer).toHaveBeenCalledTimes(1);
  });

  it.each(['classic', 'clean'] as const)(
    'reveals the completed file in its owning workspace without previewing it (%s)',
    async (chatLook) => {
      look = chatLook;
      await renderChips([{}]);
      const chip = container.querySelector('[data-testid="turn-file-chip"]');
      expect(chip?.tagName).toBe('DIV');
      expect(chip?.querySelector('button button')).toBeNull();
      expect(container.querySelector('[title]')).toBeNull();
      const [reveal] = reveals();
      expect(reveal?.getAttribute('aria-label')).toBe(
        'Show vendor-spend-cleaned.csv in Finder',
      );
      expect(reveal?.className).toContain('focus-ring');
      await flush(() => reveal?.click());
      expect(showInFinder).toHaveBeenCalledWith({
        absolutePath: CSV,
        projectId: 'cowork-1',
        worktreeId: 'entry-1',
      });
      expect(showFilesInRenderer).not.toHaveBeenCalled();
    },
  );

  it('describes both controls with the readable project location', async () => {
    await renderChips([{}, { path: '/elsewhere/vendor-spend-cleaned.csv' }]);
    const opens = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="turn-file-chip-open"]',
      ),
    );
    const ids = opens.map((open) => open.getAttribute('aria-describedby'));
    expect(new Set(ids).size).toBe(2);
    const revealButtons = reveals();
    opens.forEach((open: HTMLButtonElement, index: number): void => {
      const id = ids[index];
      if (!id) throw new Error('Missing location description');
      expect(document.getElementById(id)?.textContent).toBe(
        'Saved in Vendor Spend Q3',
      );
      expect(open.getAttribute('aria-label')).toBe(
        'Open vendor-spend-cleaned.csv',
      );
      expect(revealButtons[index]?.getAttribute('aria-describedby')).toBe(id);
    });
  });

  it('masks the project location in replay while leaving both controls unmasked', async () => {
    await renderChips([{}]);
    const location = container.querySelector(
      '[data-testid="turn-file-chip-location"]',
    );
    expect(location?.classList.contains(REPLAY_MASK_CLASS)).toBe(true);
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).forEach(
      (button: HTMLButtonElement): void => {
        expect(button.classList.contains(REPLAY_MASK_CLASS)).toBe(false);
      },
    );
  });

  it('names an explicit target project, not the current chat project', async () => {
    await renderChips([
      { target: { projectId: 'project', worktreeId: 'worktree' } },
    ]);
    expect(
      container.querySelector('[data-testid="turn-file-chip-location"]')
        ?.textContent,
    ).toBe('Saved in Advisor target');
    await flush(() => reveals()[0]?.click());
    expect(showInFinder).toHaveBeenCalledWith({
      absolutePath: CSV,
      projectId: 'project',
      worktreeId: 'worktree',
    });
  });

  it('falls back to a readable location when project metadata is missing', async () => {
    mockProjects = [];
    await renderChips([{}]);
    expect(
      container.querySelector('[data-testid="turn-file-chip-location"]')
        ?.textContent,
    ).toBe('Saved in project folder');
  });

  it('omits reveal when the native action is unavailable', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {},
    });
    await renderChips([{}]);
    expect(reveals()).toHaveLength(0);
    expect(
      container.querySelector('[data-testid="turn-file-chip-open"]'),
    ).not.toBeNull();
  });

  it('omits reveal in a window controlling another computer', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        showInFinder,
        remoteControl: {
          getContext: () => ({ mode: 'remote', deviceId: 'other-computer' }),
        },
      },
    });
    await renderChips([{}]);
    expect(reveals()).toHaveLength(0);
  });

  it('never offers reveal or a saved location for a pending file', async () => {
    await renderChips([{ pending: true }]);
    expect(reveals()).toHaveLength(0);
    expect(container.textContent).not.toContain('Saved in');
    expect(container.textContent).toContain('Creating…');
    expect(
      container
        .querySelector('[data-testid="turn-file-chip-open"]')
        ?.getAttribute('aria-label'),
    ).toBe('Creating vendor-spend-cleaned.csv');
  });

  it.each([undefined, 'updated'] as const)(
    'says a %s pending file waits for approval, not busy or openable (CAN-5291)',
    async (change) => {
      await renderChips([
        { pending: true, waiting: true, ...(change ? { change } : {}) },
      ]);
      expect(reveals()).toHaveLength(0);
      expect(
        container.querySelector('[data-testid="turn-file-chip-status"]')
          ?.textContent,
      ).toBe('Waiting for approval');
      expect(container.textContent).not.toMatch(/Creating…|Updating…/);
      const open = container.querySelector(
        '[data-testid="turn-file-chip-open"]',
      );
      expect(open?.getAttribute('aria-label')).toBe(
        'vendor-spend-cleaned.csv, waiting for approval',
      );
      expect(open?.getAttribute('aria-busy')).toBe('false');
      expect(open?.getAttribute('aria-disabled')).toBe('true');
    },
  );

  it.each<[string, Partial<TurnFileChipProps>, boolean, boolean]>([
    ['no absolute path', { absolutePath: undefined }, false, false],
    ['a relative path', { absolutePath: 'outputs/a.csv' }, false, false],
    ['an incomplete scope', { worktreeId: '' }, false, false],
    [
      'an incomplete explicit target',
      { target: { projectId: 'project', worktreeId: '' } },
      false,
      false,
    ],
    ['a read-only chat scope', {}, true, false],
    [
      'a read-only chat with an editable explicit target',
      { target: { projectId: 'project', worktreeId: 'worktree' } },
      true,
      true,
    ],
    [
      'an editable chat with a read-only target',
      {
        target: {
          projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          worktreeId: 'container',
        },
      },
      false,
      false,
    ],
  ])('reveal availability with %s', async (_, chip, readOnly, expected) => {
    await renderChips([chip], readOnly);
    expect(reveals()).toHaveLength(expected ? 1 : 0);
  });

  it('reports a failed reveal accessibly, keeps preview usable, and clears on retry', async () => {
    showInFinder
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValueOnce(undefined);
    await renderChips([{}]);
    await flush(() => reveals()[0]?.click());
    const open = container.querySelector<HTMLButtonElement>(
      '[data-testid="turn-file-chip-open"]',
    );
    const status = container.querySelector(
      '[data-testid="turn-file-chip-status"]',
    );
    expect(status?.textContent).toBe(
      "Couldn't show this file. It may have been moved or deleted.",
    );
    expect(status?.getAttribute('role')).toBe('status');
    expect(reveals()[0]?.getAttribute('aria-describedby')).toContain(
      status?.id,
    );
    expect(open?.getAttribute('aria-describedby')).toContain(status?.id);
    expect(open?.getAttribute('aria-disabled')).toBe('false');
    expect(
      container.querySelector('[data-testid="turn-file-chip-location"]')
        ?.textContent,
    ).toBe('Saved in Vendor Spend Q3');
    await flush(() => reveals()[0]?.click());
    expect(showInFinder).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('[data-testid="turn-file-chip-status"]'),
    ).toBeNull();
  });
});

it.each(['classic', 'clean'] as const)(
  'draws a %s created-file row to fit the changes card',
  async (look) => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await flush(() =>
      root.render(
        <ChatLookProvider value={look}>
          <TurnFileChip
            path="/project/site/index.html"
            projectId="project"
            worktreeId="worktree"
            chatId="chat"
            pending
          />
        </ChatLookProvider>,
      ),
    );
    const row = container.querySelector<HTMLElement>(
      '[data-testid="turn-file-chip"]',
    );
    expect(row).toBeInstanceOf(HTMLElement);
    const classes = row?.className.split(/\s+/) ?? [];
    if (look === 'clean') {
      // One row of the card, like its changed files: no box of its own, the
      // full width of the card's 4px-inset list, 8px corners nested in the
      // card's 12px ones and 8px side padding.
      expect(classes).not.toContain('border');
      expect(classes).toEqual(
        expect.arrayContaining([
          'w-full',
          'rounded-[calc(var(--radius-xl)-5px)]',
          'px-2',
          'hover:bg-subtle',
        ]),
      );
      expect(row?.textContent).toBe('index.htmlCreating…');
    } else {
      expect(classes).toContain('border');
    }
    await flush(() => root.unmount());
    container.remove();
  },
);

/** @jest-environment jsdom */
import { act, type ReactNode } from 'react';
import {
  ChatMessageLinkActionsProvider,
  useChatMessageContextMenu,
} from '@canopy/ui-shared';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { openAppLinkInWorktreeBrowser } from '@/stores/browserEventSubscription';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMessageItem } from '../ChatMessageItem';
import { TranscriptViewer } from '../TranscriptViewer';
import type { DisplayMessage } from '../types';
import { useChatMessageLinkActions } from '../chat-message-link-actions';
import { ChatLookProvider } from '@canopy/ui-shared/components/chat-look';

jest.mock('@/lib/terminal-instances', () => ({
  getOrCreateInstance: jest.fn(),
  peekInstance: jest.fn(() => undefined),
  TERMINAL_BG_COLOR: '#0b0c10',
}));

jest.mock('@/stores/browserEventSubscription', () => ({
  ...jest.requireActual<object>('@/stores/browserEventSubscription'),
  openAppLinkInWorktreeBrowser: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('@xterm/xterm', () => ({ Terminal: jest.fn() }));
jest.mock('@xterm/addon-fit', () => ({ FitAddon: jest.fn() }));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function LiveParent({ children }: { children: ReactNode }): ReactNode {
  const { targetProps, menu } = useChatMessageContextMenu({
    messageId: 'outer-workflow-message',
  });
  return (
    <div {...targetProps}>
      {children}
      {menu}
    </div>
  );
}

function LinkHost({
  target,
  children,
}: {
  target: { projectId: string; worktreeId: string } | null;
  children: ReactNode;
}): ReactNode {
  const actions = useChatMessageLinkActions(target);
  return (
    <ChatMessageLinkActionsProvider value={actions}>
      {children}
    </ChatMessageLinkActionsProvider>
  );
}

describe('desktop chat message context menu (CAN-4277)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let clipboardWrites: string[];
  let originalClipboard: PropertyDescriptor | undefined;
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeAll(() => {
    globalThis.ResizeObserver = ResizeObserverStub;
  });

  afterAll(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    clipboardWrites = [];
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string): Promise<void> => {
          clipboardWrites.push(text);
          return Promise.resolve();
        },
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.getSelection()?.removeAllRanges();
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  function render(message: DisplayMessage): void {
    act(() =>
      root.render(
        <ChatLookProvider value="classic">
          <ChatMessageItem message={message} chatPendingQuestions={[]} />
        </ChatLookProvider>,
      ),
    );
  }

  function openMenuOn(target: Element | null): void {
    if (!target) throw new Error('missing menu target');
    act(() => {
      target.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 24,
        }),
      );
    });
  }

  function menus(): NodeListOf<Element> {
    return document.querySelectorAll(
      '[data-testid="chat-message-context-menu"]',
    );
  }

  async function choose(testId: string): Promise<void> {
    const item = document.querySelector(`[data-testid="${testId}"]`);
    if (!(item instanceof HTMLButtonElement)) throw new Error(`no ${testId}`);
    expect(item.disabled).toBe(false);
    await act(async () => {
      item.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function menuItem(testId: string): HTMLButtonElement {
    const item = document.querySelector(`[data-testid="${testId}"]`);
    if (!(item instanceof HTMLButtonElement)) throw new Error(`no ${testId}`);
    return item;
  }

  function menuLabels(): Array<string | null> {
    return Array.from(
      document.querySelectorAll(
        '[data-testid="chat-message-context-menu"] [role="menuitem"]',
      ),
    ).map((item) => item.textContent);
  }

  /** Selects `node`'s rendered text and returns what the menu should copy. */
  function select(node: Node | null): string {
    if (!node) throw new Error('missing selection target');
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return selection?.toString() ?? '';
  }

  /** Without a selection the menu holds one disabled Copy selection (CAN-4870). */
  async function expectOnlyDisabledSelectionCopy(): Promise<void> {
    expect(menuLabels()).toEqual(['Copy selection']);
    const item = menuItem('chat-message-copy-selection');
    expect(item.disabled).toBe(true);
    await act(async () => {
      item.click();
      await Promise.resolve();
    });
    expect(clipboardWrites).toEqual([]);
  }

  it('renders no menu markup while closed', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ChatMessageItem
          message={{
            id: 'a1',
            role: 'assistant',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Hello' }],
          }}
          chatPendingQuestions={[]}
        />
      </ChatLookProvider>,
    );
    expect(html).not.toContain('chat-message-context-menu');
  });

  it.each([false, true])(
    'keeps read-only transcripts outside live menus (nested: %s)',
    async (nested) => {
      const lines = [
        JSON.stringify({
          type: 'canopy_user_prompt',
          provider: 'claude',
          original_text: 'Read-only user message',
          user_message_id: 'run-user',
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'run-assistant',
          parent_tool_use_id: null,
          message: {
            id: 'run-reply',
            role: 'assistant',
            content: [{ type: 'text', text: 'Read-only assistant message' }],
          },
        }),
      ];
      const viewer = (
        <TranscriptViewer
          transcriptKey="read-only-run"
          lines={lines}
          emptyMessage="No messages"
          closeOpenTurnAtEnd
        />
      );
      await act(async () => {
        root.render(nested ? <LiveParent>{viewer}</LiveParent> : viewer);
        await Promise.resolve();
      });
      for (const role of ['user', 'assistant']) {
        const row = container.querySelector(`[data-role="${role}"]`);
        expect(row?.textContent).toContain(`Read-only ${role} message`);
        expect(row?.getAttribute('tabindex')).toBeNull();
        openMenuOn(row);
        expect(menus()).toHaveLength(0);
      }
    },
  );

  it('copies only the selection inside a user bubble', async () => {
    render({
      id: 'u1',
      role: 'user',
      timestamp: 1,
      blocks: [
        { type: 'text', text: 'Look at **this**' },
        {
          type: 'file_references',
          references: [
            { displayPath: 'src/app.ts', absolutePath: '/repo/src/app.ts' },
          ],
        },
      ],
    });
    const row = container.querySelector('[data-chat-message-id="u1"]');
    // One menu owner per user row: the bubble, not ChatMessageItem too.
    openMenuOn(row);
    expect(menus()).toHaveLength(1);
    await expectOnlyDisabledSelectionCopy();

    const expected = select(row?.querySelector('strong') ?? null);
    expect(expected).toBe('this');
    openMenuOn(row);
    await choose('chat-message-copy-selection');
    expect(clipboardWrites).toEqual([expected]);
  });

  it('copies only the selection inside an assistant reply', async () => {
    render({
      id: 'a1',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        { type: 'text', text: 'First  ' },
        {
          type: 'tool_use',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          input: 'echo secret-output',
        },
        { type: 'thinking', text: 'private thoughts' },
        { type: 'text', text: '- second' },
      ],
    });
    const row = container.querySelector('[data-chat-message-id="a1"]');
    openMenuOn(row);
    expect(menus()).toHaveLength(1);
    await expectOnlyDisabledSelectionCopy();

    const expected = select(row?.querySelector('li') ?? null);
    expect(expected).toBe('second');
    openMenuOn(row);
    await choose('chat-message-copy-selection');
    expect(clipboardWrites).toEqual([expected]);
  });

  it('adds a Tab stop only to rows with text to copy', () => {
    render({
      id: 'tools-only',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          input: 'echo hi',
        },
      ],
    });
    const toolsOnly = container.querySelector(
      '[data-chat-message-id="tools-only"]',
    );
    expect(toolsOnly?.hasAttribute('tabindex')).toBe(false);
    // A selection inside the row can still be copied through the menu.
    openMenuOn(toolsOnly);
    expect(menus()).toHaveLength(1);

    render({
      id: 'with-text',
      role: 'assistant',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'Answer' }],
    });
    expect(
      container
        .querySelector('[data-chat-message-id="with-text"]')
        ?.getAttribute('tabindex'),
    ).toBe('0');
  });

  it('gives presentation-only system info blocks no menu', () => {
    render({
      id: 's1',
      role: 'system',
      timestamp: 1,
      blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 2 }],
    });
    openMenuOn(container.firstElementChild ?? container);
    expect(menus()).toHaveLength(0);
  });

  it('copies a selection in genuine system text through the regular message layout', async () => {
    render({
      id: 'system-text',
      role: 'system',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'System **notice**' }],
    });
    const row = container.querySelector('[data-chat-message-id="system-text"]');
    const expected = select(row?.querySelector('strong') ?? null);
    openMenuOn(row);
    await choose('chat-message-copy-selection');
    expect(clipboardWrites).toEqual([expected]);
    expect(expected).toBe('notice');
  });

  it('copies a selection in a visible async question rather than excluding its alternate layout', async () => {
    render({
      id: 'question',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        {
          type: 'text',
          text: 'Which **scope**?',
          asyncQuestion: {
            requestId: 'question-request',
            questions: [{ title: 'Which scope?', options: null }],
          },
        },
      ],
    });
    expect(container.textContent).toContain('Which scope?');
    const paragraph =
      container.querySelector('p') ?? container.firstElementChild;
    openMenuOn(paragraph);
    expect(menus()).toHaveLength(1);
    await expectOnlyDisabledSelectionCopy();

    const expected = select(paragraph);
    openMenuOn(paragraph);
    await choose('chat-message-copy-selection');
    expect(clipboardWrites).toEqual([expected]);
  });

  it('opens on textless user messages with only a disabled selection copy', async () => {
    render({ id: 'empty-user', role: 'user', timestamp: 1, blocks: [] });
    openMenuOn(container.querySelector('[data-role="user"]'));
    expect(menus()).toHaveLength(1);
    await expectOnlyDisabledSelectionCopy();
  });

  describe('link actions (CAN-2632)', () => {
    const LINK = 'https://example.com/docs?x=1#frag';
    const openExternal = jest.fn<Promise<void>, [{ url: string }]>();
    const linkMessage: DisplayMessage = {
      id: 'link-msg',
      role: 'assistant',
      timestamp: 1,
      blocks: [{ type: 'text', text: `Read [the docs](${LINK}).` }],
    };

    beforeEach(() => {
      openExternal.mockReset();
      openExternal.mockResolvedValue(undefined);
      jest.mocked(openAppLinkInWorktreeBrowser).mockClear();
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { browser: { openExternal } },
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(window, 'api');
    });

    function renderLink(
      target: { projectId: string; worktreeId: string } | null,
    ): HTMLAnchorElement {
      act(() =>
        root.render(
          <ChatLookProvider value="classic">
            <LinkHost target={target}>
              <ChatMessageItem
                message={linkMessage}
                chatPendingQuestions={[]}
              />
            </LinkHost>
          </ChatLookProvider>,
        ),
      );
      const anchor = container.querySelector(`a[href="${LINK}"]`);
      if (!(anchor instanceof HTMLAnchorElement)) throw new Error('no link');
      return anchor;
    }

    function labels(): Array<string | null> {
      return Array.from(
        document.querySelectorAll(
          '[data-testid="chat-message-context-menu"] [role="menuitem"]',
        ),
      ).map((item) => item.textContent);
    }

    it('opens a Code chat link in the message worktree or the external browser', async () => {
      const anchor = renderLink({
        projectId: 'project-b',
        worktreeId: 'worktree-b',
      });
      openMenuOn(anchor);
      expect(labels()).toEqual([
        'Copy link',
        'Open in browser',
        'Open in external browser',
        'Copy selection',
      ]);
      await choose('chat-message-copy-link');
      expect(clipboardWrites).toEqual([LINK]);

      openMenuOn(anchor);
      await choose('chat-message-open-link-in-browser');
      expect(openAppLinkInWorktreeBrowser).toHaveBeenCalledWith(
        'project-b',
        'worktree-b',
        LINK,
      );
      expect(openExternal).not.toHaveBeenCalled();

      openMenuOn(anchor);
      await choose('chat-message-open-link-external');
      expect(openExternal).toHaveBeenCalledWith({ url: LINK });
    });

    it('offers only the external browser for an App Advisor chat', () => {
      openMenuOn(
        renderLink({
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: APP_ADVISOR_WORKTREE_ID,
        }),
      );
      expect(labels()).toEqual([
        'Copy link',
        'Open in external browser',
        'Copy selection',
      ]);
      expect(
        document.querySelector(
          '[data-testid="chat-message-open-link-in-browser"]',
        ),
      ).toBeNull();
    });

    it('offers no open actions in a window that shows another computer', () => {
      // Both browser channels are blocked over remote control, so neither
      // open action could reach a browser on either computer.
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          browser: { openExternal },
          remoteControl: {
            getContext: () => ({
              mode: 'remote',
              deviceId: 'device-1',
              name: 'Studio',
              platform: 'darwin',
            }),
          },
        },
      });
      openMenuOn(
        renderLink({ projectId: 'project-b', worktreeId: 'worktree-b' }),
      );
      expect(labels()[0]).toBe('Copy link');
      expect(
        document.querySelector(
          '[data-testid="chat-message-open-link-in-browser"]',
        ),
      ).toBeNull();
      expect(
        document.querySelector(
          '[data-testid="chat-message-open-link-external"]',
        ),
      ).toBeNull();
    });
  });
});

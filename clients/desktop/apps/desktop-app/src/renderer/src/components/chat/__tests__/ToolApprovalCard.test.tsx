/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  ToolApprovalCard,
  type ToolApprovalCardHandle,
} from '../ToolApprovalCard';

const respondToApprovalMock = jest.fn();
let mockIsMac = true;

jest.mock('@/lib/keyboardShortcuts', () => ({
  isMacPlatform: (): boolean => mockIsMac,
}));

jest.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: unknown) => unknown): unknown =>
    selector({
      respondToApproval: respondToApprovalMock,
    }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function makePending(
  overrides?: Partial<ApprovalRequestEvent>,
): ApprovalRequestEvent {
  return {
    requestId: 'req-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    provider: 'claude',
    title: 'Run command',
    details: { kind: 'command', command: 'rm -rf build' },
    suggestedTarget: { kind: 'command', pattern: 'rm -rf *' },
    ...overrides,
  };
}

function click(el: Element | null | undefined): void {
  el?.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true }),
  );
}

const LONG_COMMAND_LINES = Array.from(
  { length: 40 },
  (_, i) => `echo "line ${i + 1}"`,
);
/** A multi-line inline script: far past the card's preview line budget. */
const LONG_COMMAND = `bash -c '${LONG_COMMAND_LINES.join('\n')}'`;

function menuItemLabels(menu: Element | null): string[] {
  return Array.from(
    menu?.querySelectorAll('button[role="menuitem"]') ?? [],
  ).map((btn) => btn.textContent ?? '');
}

/**
 * Each row's leading slot: `icon` when it draws a glyph, `empty` when it
 * continues a run of rows sharing that icon, `missing` without a slot.
 */
function menuIconSlots(menu: Element | null): string[] {
  return Array.from(
    menu?.querySelectorAll('button[role="menuitem"]') ?? [],
  ).map((row) => {
    const slot = row.firstElementChild;
    if (slot?.getAttribute('aria-hidden') !== 'true') return 'missing';
    return slot.querySelector('svg') ? 'icon' : 'empty';
  });
}

describe('ToolApprovalCard', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    respondToApprovalMock.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders command details in a code block', () => {
    act(() => {
      root.render(createElement(ToolApprovalCard, { pending: makePending() }));
    });

    expect(
      container.querySelector('[data-testid="tool-approval-card"]'),
    ).not.toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('rm -rf build');
  });

  it('renders a Skill name in the tool details chip', () => {
    act(() => {
      root.render(
        createElement(ToolApprovalCard, {
          pending: makePending({
            title: 'Claude wants to use skill ud-linear:linear-agent-implement',
            details: {
              kind: 'tool',
              toolName: 'ud-linear:linear-agent-implement',
            },
            suggestedTarget: { kind: 'tool', toolName: 'Skill' },
          }),
        }),
      );
    });

    expect(container.querySelector('code')?.textContent).toBe(
      'ud-linear:linear-agent-implement',
    );
    expect(container.textContent).toContain(
      'Claude wants to use skill ud-linear:linear-agent-implement',
    );
  });

  it('lists the files to upload with their sizes, where they go, and the page they are on', () => {
    const pending = makePending({
      title: 'Upload 2 files to upload.example?',
      details: {
        kind: 'browser-upload',
        origin: 'https://upload.example',
        topOrigin: 'https://app.example',
        files: [
          { displayPath: 'exports/report.csv', sizeBytes: 2048 },
          { displayPath: 'notes.txt', sizeBytes: 0 },
        ],
      },
      suggestedTarget: {
        kind: 'browser-upload',
        origin: 'https://upload.example',
      },
    });
    act(() => {
      root.render(createElement(ToolApprovalCard, { pending }));
    });

    const details = container.querySelector(
      '[data-testid="tool-approval-upload-details"]',
    );
    expect(
      Array.from(details?.querySelectorAll('li') ?? []).map(
        (item) => item.textContent,
      ),
    ).toEqual(['exports/report.csv2KB', 'notes.txt0B']);
    expect(details?.textContent).toContain('To https://upload.example');
    expect(details?.textContent).toContain('on https://app.example');

    act(() => {
      click(container.querySelector('[aria-label="More allow options"]'));
    });
    const menu = document.querySelector(
      '[data-testid="tool-approval-allow-menu"]',
    );
    expect(menu?.textContent).toContain('https://upload.example');
    const chatItem = Array.from(
      menu?.querySelectorAll('button[role="menuitem"]') ?? [],
    ).find((button) => button.textContent?.includes('Allow for this chat'));
    act(() => {
      click(chatItem);
    });
    expect(respondToApprovalMock).toHaveBeenCalledWith('req-1', {
      behavior: 'allow',
      scope: 'session',
      target: { kind: 'browser-upload', origin: 'https://upload.example' },
    });
  });

  it('asks the user to choose files or decline, with the agent purpose quoted and no rule options', async () => {
    const pending = makePending({
      title: 'Choose a file for upload.example',
      details: {
        kind: 'browser-file-request',
        origin: 'https://upload.example',
        topOrigin: 'https://app.example',
        purpose: 'Your résumé for the application',
        multiple: false,
      },
    });
    act(() => {
      root.render(createElement(ToolApprovalCard, { pending }));
    });

    const details = container.querySelector(
      '[data-testid="tool-approval-file-request-details"]',
    );
    expect(details?.textContent).toContain('“Your résumé for the application”');
    expect(details?.textContent).toContain('For https://upload.example');
    expect(details?.textContent).toContain('on https://app.example');
    expect(
      container.querySelector('[aria-label="More allow options"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="tool-approval-allow"]'),
    ).toBeNull();
    const choose = container.querySelector(
      '[data-testid="tool-approval-choose-files"]',
    );
    expect(choose?.textContent).toBe('Choose file…');
    // Settle the first response before the second: one is in flight at once.
    await act(async () => {
      click(choose);
      await Promise.resolve();
    });
    expect(respondToApprovalMock).toHaveBeenLastCalledWith('req-1', {
      behavior: 'allow',
      scope: 'once',
    });
    const decline = container.querySelector(
      '[data-testid="tool-approval-decline-files"]',
    );
    expect(decline?.textContent).toBe('Decline');
    act(() => {
      click(decline);
    });
    expect(respondToApprovalMock).toHaveBeenLastCalledWith('req-1', {
      behavior: 'deny',
      scope: 'once',
    });
  });

  it('names several files when the input takes several', () => {
    act(() => {
      root.render(
        createElement(ToolApprovalCard, {
          pending: makePending({
            details: {
              kind: 'browser-file-request',
              origin: 'https://upload.example',
              multiple: true,
            },
          }),
        }),
      );
    });
    expect(
      container.querySelector('[data-testid="tool-approval-choose-files"]')
        ?.textContent,
    ).toBe('Choose files…');
  });

  it('omits the page when the files go to the page itself', () => {
    act(() => {
      root.render(
        createElement(ToolApprovalCard, {
          pending: makePending({
            details: {
              kind: 'browser-upload',
              origin: 'https://upload.example',
              topOrigin: 'https://upload.example',
              files: [{ displayPath: 'report.csv', sizeBytes: 8 }],
            },
          }),
        }),
      );
    });
    const details = container.querySelector(
      '[data-testid="tool-approval-upload-details"]',
    );
    expect(details?.textContent).toContain('To https://upload.example');
    expect(details?.textContent).not.toContain(' on ');
  });

  it('Allow once dispatches respondToApproval with scope once and no target', () => {
    act(() => {
      root.render(createElement(ToolApprovalCard, { pending: makePending() }));
    });

    act(() => {
      click(container.querySelector('[data-testid="tool-approval-allow"]'));
    });

    expect(respondToApprovalMock).toHaveBeenCalledWith('req-1', {
      behavior: 'allow',
      scope: 'once',
    });
  });

  it('records the card title and actions but blocks the tool input (CAN-3119)', () => {
    const pending = makePending({
      description: 'Remove the build output',
      details: { kind: 'command', command: 'rm -rf build', cwd: '/repo' },
    });
    act(() => {
      root.render(createElement(ToolApprovalCard, { pending }));
    });
    const card = container.querySelector('[data-testid="tool-approval-card"]');
    expect(card?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    const title = Array.from(card?.querySelectorAll('div') ?? []).find(
      (element) => element.textContent === 'Run command',
    );
    expect(title).toBeDefined();
    expect(title?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(
      container
        .querySelector('[data-testid="tool-approval-allow"]')
        ?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
    const command = container.querySelector(
      '[data-testid="tool-approval-content-preview"]',
    );
    expect(command?.textContent).toBe('rm -rf build');
    expect(command?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).not.toBeNull();
    const description = Array.from(card?.querySelectorAll('div') ?? []).find(
      (element) => element.textContent === 'Remove the build output',
    );
    expect(description?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
      true,
    );
  });

  it.each([
    ['tool-approval-allow-menu', 'More allow options'],
    ['tool-approval-deny-menu', 'More deny options'],
  ])(
    'records the %s it portals to the document body but blocks its rule target (CAN-3119)',
    (menuTestId, openLabel) => {
      const pending = makePending();
      act(() => {
        root.render(createElement(ToolApprovalCard, { pending }));
      });
      act(() => {
        click(container.querySelector(`[aria-label="${openLabel}"]`));
      });
      const menu = document.querySelector(`[data-testid="${menuTestId}"]`);
      expect(menu).not.toBeNull();
      expect(container.contains(menu)).toBe(false);
      expect(menu?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
      const target = document.querySelector(
        `[data-testid="${menuTestId}-target"]`,
      );
      expect(target?.textContent).toBe('rm -rf *');
      const targetBlock = target?.querySelector(
        `.${POSTHOG_REPLAY_BLOCK_CLASS}`,
      );
      expect(targetBlock?.textContent).toBe('rm -rf *');
      for (const item of Array.from(
        menu?.querySelectorAll('button[role="menuitem"]') ?? [],
      )) {
        expect(item.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
      }
    },
  );

  it('"Always in this project" passes scope project and the suggested target', () => {
    const pending = makePending();
    act(() => {
      root.render(createElement(ToolApprovalCard, { pending }));
    });

    act(() => {
      click(container.querySelector('[aria-label="More allow options"]'));
    });

    const menu = document.querySelector(
      '[data-testid="tool-approval-allow-menu"]',
    );
    expect(menu).not.toBeNull();
    const projectItem = Array.from(
      menu?.querySelectorAll('button[role="menuitem"]') ?? [],
    ).find((btn) => btn.textContent?.includes('Always in this project'));
    expect(projectItem).toBeDefined();

    act(() => {
      click(projectItem);
    });

    expect(respondToApprovalMock).toHaveBeenCalledWith('req-1', {
      behavior: 'allow',
      scope: 'project',
      target: pending.suggestedTarget,
    });
  });

  it.each([
    {
      menuLabel: 'Allow for this chat',
      menuTestId: 'tool-approval-allow-menu',
      openLabel: 'More allow options',
      expected: { behavior: 'allow', scope: 'session' },
    },
    {
      menuLabel: 'Always everywhere',
      menuTestId: 'tool-approval-allow-menu',
      openLabel: 'More allow options',
      expected: { behavior: 'allow', scope: 'global' },
    },
    {
      menuLabel: 'Never in this project',
      menuTestId: 'tool-approval-deny-menu',
      openLabel: 'More deny options',
      expected: { behavior: 'deny', scope: 'project' },
    },
    {
      menuLabel: 'Never everywhere',
      menuTestId: 'tool-approval-deny-menu',
      openLabel: 'More deny options',
      expected: { behavior: 'deny', scope: 'global' },
    },
  ])('$menuLabel dispatches the matching decision metadata', (scenario) => {
    const pending = makePending();
    act(() => {
      root.render(createElement(ToolApprovalCard, { pending }));
    });

    act(() => {
      click(container.querySelector(`[aria-label="${scenario.openLabel}"]`));
    });

    const menu = document.querySelector(
      `[data-testid="${scenario.menuTestId}"]`,
    );
    const menuItem = Array.from(
      menu?.querySelectorAll('button[role="menuitem"]') ?? [],
    ).find((button) => button.textContent?.includes(scenario.menuLabel));
    expect(menuItem).toBeDefined();

    act(() => {
      click(menuItem);
    });

    expect(respondToApprovalMock).toHaveBeenCalledWith('req-1', {
      ...scenario.expected,
      target: pending.suggestedTarget,
    });
  });

  it('does not render persistent allow scopes when suggestedTarget is absent', () => {
    act(() => {
      root.render(
        createElement(ToolApprovalCard, {
          pending: makePending({ suggestedTarget: undefined }),
        }),
      );
    });

    act(() => {
      click(container.querySelector('[aria-label="More allow options"]'));
    });

    const menu = document.querySelector(
      '[data-testid="tool-approval-allow-menu"]',
    );
    expect(menu?.querySelectorAll('button[role="menuitem"]').length).toBe(0);
  });

  it('deny-with-reason passes message on the deny decision', () => {
    act(() => {
      root.render(createElement(ToolApprovalCard, { pending: makePending() }));
    });

    act(() => {
      click(
        Array.from(container.querySelectorAll('button')).find(
          (btn) => btn.textContent === 'Add a reason',
        ),
      );
    });

    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();

    act(() => {
      const input = textarea as HTMLTextAreaElement;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'Not safe to run right now');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    act(() => {
      click(container.querySelector('[data-testid="tool-approval-deny"]'));
    });

    expect(respondToApprovalMock).toHaveBeenCalledWith('req-1', {
      behavior: 'deny',
      scope: 'once',
      message: 'Not safe to run right now',
    });
  });

  it('Deny and stop passes stopTurn true', () => {
    act(() => {
      root.render(createElement(ToolApprovalCard, { pending: makePending() }));
    });

    act(() => {
      click(container.querySelector('[aria-label="More deny options"]'));
    });

    const menu = document.querySelector(
      '[data-testid="tool-approval-deny-menu"]',
    );
    const stopItem = Array.from(
      menu?.querySelectorAll('button[role="menuitem"]') ?? [],
    ).find((btn) => btn.textContent === 'Deny and stop');
    expect(stopItem).toBeDefined();

    act(() => {
      click(stopItem);
    });

    expect(respondToApprovalMock).toHaveBeenCalledWith('req-1', {
      behavior: 'deny',
      scope: 'once',
      stopTurn: true,
    });
  });

  it('a short command renders the whole command with no view-full trigger', () => {
    act(() => {
      root.render(createElement(ToolApprovalCard, { pending: makePending() }));
    });

    expect(
      container.querySelector('[data-testid="tool-approval-content-preview"]')
        ?.textContent,
    ).toBe('rm -rf build');
    expect(
      container.querySelector(
        '[data-testid="tool-approval-content-view-full"]',
      ),
    ).toBeNull();
  });

  it('a long command renders a truncated preview and opens the full text in a modal', () => {
    act(() => {
      root.render(
        createElement(ToolApprovalCard, {
          pending: makePending({
            details: { kind: 'command', command: LONG_COMMAND },
            suggestedTarget: { kind: 'command', pattern: LONG_COMMAND },
          }),
        }),
      );
    });

    const preview = container.querySelector(
      '[data-testid="tool-approval-content-preview"]',
    );
    expect(preview?.textContent).toContain('line 1');
    expect(preview?.textContent).not.toContain('line 40');

    const viewFull = container.querySelector(
      '[data-testid="tool-approval-content-view-full"]',
    );
    expect(viewFull).not.toBeNull();
    act(() => {
      click(viewFull);
    });

    const modal = document.querySelector(
      '[data-testid="tool-approval-content-modal"]',
    );
    expect(modal).not.toBeNull();
    const body = modal?.querySelector(
      '[data-testid="tool-approval-content-modal-body"]',
    );
    expect(body?.textContent).toBe(LONG_COMMAND);
    // Session replay records the dialog frame but not the full command.
    expect(modal?.classList.contains('ph-no-capture')).toBe(false);
    expect(body?.classList.contains('ph-no-capture')).toBe(true);
  });

  it('allow menu shows the rule target once in its header and keeps option rows to their labels', () => {
    act(() => {
      root.render(createElement(ToolApprovalCard, { pending: makePending() }));
    });
    act(() => {
      click(container.querySelector('[aria-label="More allow options"]'));
    });

    const menu = document.querySelector(
      '[data-testid="tool-approval-allow-menu"]',
    );
    expect(
      menu?.querySelector('[data-testid="tool-approval-allow-menu-target"]')
        ?.textContent,
    ).toBe('rm -rf *');
    expect(menuItemLabels(menu)).toEqual([
      'Allow for this chat',
      'Always in this project',
      'Always everywhere',
    ]);
    expect(
      menu?.querySelector('[data-testid="tool-approval-allow-menu-view-full"]'),
    ).toBeNull();
  });

  it('deny menu shows the rule target once in its header and keeps option rows to their labels', () => {
    act(() => {
      root.render(createElement(ToolApprovalCard, { pending: makePending() }));
    });
    act(() => {
      click(container.querySelector('[aria-label="More deny options"]'));
    });

    const menu = document.querySelector(
      '[data-testid="tool-approval-deny-menu"]',
    );
    expect(
      menu?.querySelector('[data-testid="tool-approval-deny-menu-target"]')
        ?.textContent,
    ).toBe('rm -rf *');
    expect(menuItemLabels(menu)).toEqual([
      'Never in this project',
      'Never everywhere',
      'Deny and stop',
    ]);
  });

  it('gives every menu row an icon slot, shown once per run of variants', () => {
    act(() => {
      root.render(createElement(ToolApprovalCard, { pending: makePending() }));
    });
    act(() => {
      click(container.querySelector('[aria-label="More allow options"]'));
    });
    expect(
      menuIconSlots(
        document.querySelector('[data-testid="tool-approval-allow-menu"]'),
      ),
    ).toEqual(['icon', 'empty', 'empty']);

    act(() => {
      click(container.querySelector('[aria-label="More deny options"]'));
    });
    expect(
      menuIconSlots(
        document.querySelector('[data-testid="tool-approval-deny-menu"]'),
      ),
    ).toEqual(['icon', 'empty', 'empty']);
  });

  it('a long rule target is truncated in the menu header with a view-full action that opens the modal', () => {
    act(() => {
      root.render(
        createElement(ToolApprovalCard, {
          pending: makePending({
            details: { kind: 'command', command: LONG_COMMAND },
            suggestedTarget: { kind: 'command', pattern: LONG_COMMAND },
          }),
        }),
      );
    });
    act(() => {
      click(container.querySelector('[aria-label="More allow options"]'));
    });

    const menu = document.querySelector(
      '[data-testid="tool-approval-allow-menu"]',
    );
    const header = menu?.querySelector(
      '[data-testid="tool-approval-allow-menu-target"]',
    );
    expect(header?.textContent).toContain('bash -c');
    expect(header?.textContent).not.toContain('line 40');
    // Option rows never repeat the target, however large it is; the only
    // addition is the header's view-full row.
    expect(menuItemLabels(menu)).toEqual([
      'View full',
      'Allow for this chat',
      'Always in this project',
      'Always everywhere',
    ]);

    const viewFull = menu?.querySelector(
      '[data-testid="tool-approval-allow-menu-view-full"]',
    );
    expect(viewFull).not.toBeNull();
    act(() => {
      click(viewFull);
    });

    const modal = document.querySelector(
      '[data-testid="tool-approval-content-modal"]',
    );
    expect(
      modal?.querySelector('[data-testid="tool-approval-content-modal-body"]')
        ?.textContent,
    ).toBe(LONG_COMMAND);
    // Opening the modal dismisses the menu so the two overlays never stack.
    expect(
      document.querySelector('[data-testid="tool-approval-allow-menu"]'),
    ).toBeNull();
  });

  it('restores focus to the card when the trigger that opened the modal is removed', () => {
    const longPending = makePending({
      details: { kind: 'command', command: LONG_COMMAND },
      suggestedTarget: { kind: 'command', pattern: LONG_COMMAND },
    });
    act(() => {
      root.render(
        createElement(ToolApprovalCard, {
          pending: longPending,
        }),
      );
    });

    const card = container.querySelector('[data-testid="tool-approval-card"]');
    const viewFull = container.querySelector(
      '[data-testid="tool-approval-content-view-full"]',
    );
    act(() => {
      (viewFull as HTMLElement).focus();
      click(viewFull);
    });
    expect(
      document.querySelector('[data-testid="tool-approval-content-modal"]'),
    ).not.toBeNull();

    // The request details can update while the dialog is open. Switching to a
    // short command removes the view-full control without removing the card.
    act(() => {
      root.render(
        createElement(ToolApprovalCard, {
          pending: makePending(),
        }),
      );
    });
    expect(viewFull?.isConnected).toBe(false);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(
      document.querySelector('[data-testid="tool-approval-content-modal"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it('a press on "Allow once" while the allow menu is open still resolves the prompt in one click', () => {
    act(() => {
      root.render(createElement(ToolApprovalCard, { pending: makePending() }));
    });
    act(() => {
      click(container.querySelector('[aria-label="More allow options"]'));
    });
    expect(
      document.querySelector('[data-testid="tool-approval-allow-menu"]'),
    ).not.toBeNull();

    // A real click is a pointerdown followed by a click. The shared menu
    // treats an outside pointerdown as "dismiss and swallow the click"; the
    // Allow/Deny cluster is inside the menu's press boundary, so the click
    // must still reach the button.
    const allowOnce = container.querySelector(
      '[data-testid="tool-approval-allow"]',
    );
    act(() => {
      allowOnce?.dispatchEvent(
        new Event('pointerdown', { bubbles: true, cancelable: true }),
      );
    });
    act(() => {
      click(allowOnce);
    });

    expect(respondToApprovalMock).toHaveBeenCalledWith('req-1', {
      behavior: 'allow',
      scope: 'once',
    });
  });

  describe('file-write requests (CAN-5165)', () => {
    const ABSOLUTE_PATH =
      '/private/var/folders/xy/abcdefghijklmnop/T/canopy-worktrees/lizard/src/components/very/deeply/nested/Widget.tsx';
    const RELATIVE_PATH = 'src/components/very/deeply/nested/Widget.tsx';

    function fileWritePending(
      details: Extract<ApprovalRequestEvent['details'], { kind: 'file-write' }>,
      overrides?: Partial<ApprovalRequestEvent>,
    ): ApprovalRequestEvent {
      return makePending({
        title: 'Edit file',
        details,
        suggestedTarget: { kind: 'file-write', path: ABSOLUTE_PATH },
        ...overrides,
      });
    }

    function renderCard(pending: ApprovalRequestEvent): void {
      act(() => {
        root.render(createElement(ToolApprovalCard, { pending }));
      });
    }

    function query(testId: string): HTMLElement | null {
      return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    }

    it('shows the relative target on one line and the proposed edit, without the absolute path', () => {
      renderCard(
        fileWritePending({
          kind: 'file-write',
          path: ABSOLUTE_PATH,
          displayPath: RELATIVE_PATH,
          change: {
            kind: 'edit',
            oldText: 'const a = 1;',
            newText: 'const a = 2;',
          },
        }),
      );

      const target = query('tool-approval-file-target');
      expect(target?.textContent).toBe(RELATIVE_PATH);
      const label = query('tool-approval-file-target-label');
      expect(label?.classList.contains('truncate')).toBe(true);
      expect(label?.classList.contains('whitespace-nowrap')).toBe(true);
      expect(label?.className).not.toMatch(/break-(all|words)/);
      expect(label?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).not.toBeNull();

      const card = query('tool-approval-card');
      expect(card?.textContent).not.toContain(ABSOLUTE_PATH);
      expect(card?.textContent).toContain('Edit file');
      const preview = query('approval-file-change-preview');
      expect(preview?.textContent).toContain('const a = 1;');
      expect(preview?.textContent).toContain('const a = 2;');
      expect(preview?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
        true,
      );
      // The previous path-only preview and its view-full trigger are gone.
      expect(query('tool-approval-content-preview')).toBeNull();
    });

    it('discloses the full path from a keyboard-reachable control', () => {
      renderCard(
        fileWritePending({
          kind: 'file-write',
          path: ABSOLUTE_PATH,
          displayPath: RELATIVE_PATH,
          change: { kind: 'write', content: 'x' },
        }),
      );
      const target = query('tool-approval-file-target');
      expect(target?.tagName).toBe('BUTTON');
      expect(target?.getAttribute('aria-expanded')).toBe('false');
      expect(query('tool-approval-file-target-full')).toBeNull();

      act(() => {
        target?.focus();
        click(target);
      });

      expect(target?.getAttribute('aria-expanded')).toBe('true');
      const full = query('tool-approval-file-target-full');
      expect(full?.textContent).toBe(ABSOLUTE_PATH);
      expect(target?.getAttribute('aria-controls')).toBe(full?.id);
      expect(full?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).not.toBeNull();
    });

    it('shows a legacy path-only request on one line with the full path disclosure', () => {
      renderCard(fileWritePending({ kind: 'file-write', path: ABSOLUTE_PATH }));
      expect(query('tool-approval-file-target')?.textContent).toBe(
        ABSOLUTE_PATH,
      );
      expect(query('approval-file-change-preview')).toBeNull();
      expect(query('tool-approval-content-view-full')).toBeNull();
      act(() => {
        click(query('tool-approval-file-target'));
      });
      expect(query('tool-approval-file-target-full')?.textContent).toBe(
        ABSOLUTE_PATH,
      );
    });

    it('renders no target block when the request has no path', () => {
      renderCard(
        fileWritePending({ kind: 'file-write', reason: 'Needs write access' }),
      );
      expect(query('tool-approval-file-target')).toBeNull();
      expect(query('tool-approval-card')?.textContent).toContain(
        'Needs write access',
      );
    });

    it('opens the available change in the modal with a persistent warning and no further expansion', () => {
      const content = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join(
        '\n',
      );
      renderCard(
        fileWritePending({
          kind: 'file-write',
          path: ABSOLUTE_PATH,
          displayPath: RELATIVE_PATH,
          change: { kind: 'write', content, truncated: true },
        }),
      );
      expect(query('approval-file-change-source-truncated')).not.toBeNull();
      const expand = query('approval-file-change-expand');
      expect(expand?.textContent).toBe('View available change');
      expect(query('approval-file-change-preview')?.textContent).not.toContain(
        'row 30',
      );

      act(() => {
        expand?.focus();
        click(expand);
      });

      const modal = query('tool-approval-content-modal');
      expect(modal?.textContent).toContain('Available change');
      const body = query('tool-approval-content-modal-body');
      expect(body?.textContent).toContain('row 30');
      expect(
        body?.querySelector(
          '[data-testid="approval-file-change-source-truncated"]',
        ),
      ).not.toBeNull();
      expect(
        body?.querySelector('[data-testid="approval-file-change-expand"]'),
      ).toBeNull();
      expect(body?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).not.toBeNull();
      const subtitle = query('tool-approval-content-modal-subtitle');
      expect(subtitle?.textContent).toBe(ABSOLUTE_PATH);
      expect(subtitle?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
        true,
      );
      expect(modal?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);

      act(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(query('tool-approval-content-modal')).toBeNull();
      expect(document.activeElement).toBe(expand);
    });

    it('names the full change when only the compact display was shortened', () => {
      const content = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join(
        '\n',
      );
      renderCard(
        fileWritePending({
          kind: 'file-write',
          path: ABSOLUTE_PATH,
          change: { kind: 'write', content },
        }),
      );
      expect(query('approval-file-change-source-truncated')).toBeNull();
      const expand = query('approval-file-change-expand');
      expect(expand?.textContent).toBe('View full change');
      act(() => {
        click(expand);
      });
      expect(query('tool-approval-content-modal')?.textContent).toContain(
        'Full change',
      );
    });

    it('escapes hostile-looking code and paths inside the modal portal', () => {
      const hostile = '<img src=x onerror="alert(1)">';
      renderCard(
        fileWritePending({
          kind: 'file-write',
          path: `/repo/${hostile}`,
          change: { kind: 'write', content: `${hostile}\n${'x'.repeat(201)}` },
        }),
      );
      act(() => click(query('approval-file-change-expand')));
      const modal = query('tool-approval-content-modal');
      expect(modal?.querySelector('img')).toBeNull();
      expect(query('tool-approval-content-modal-body')?.textContent).toContain(
        hostile,
      );
      expect(
        query('tool-approval-content-modal-subtitle')?.textContent,
      ).toContain(hostile);
    });

    it('closes the modal when the card switches to another request', () => {
      const content = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join(
        '\n',
      );
      renderCard(
        fileWritePending({
          kind: 'file-write',
          path: ABSOLUTE_PATH,
          change: { kind: 'write', content },
        }),
      );
      act(() => {
        click(query('approval-file-change-expand'));
      });
      expect(query('tool-approval-content-modal')).not.toBeNull();

      renderCard(
        fileWritePending(
          {
            kind: 'file-write',
            path: ABSOLUTE_PATH,
            change: { kind: 'write', content: 'other' },
          },
          { requestId: 'req-2' },
        ),
      );
      expect(query('tool-approval-content-modal')).toBeNull();
      act(() => {
        click(query('tool-approval-allow'));
      });
      expect(respondToApprovalMock).toHaveBeenCalledWith('req-2', {
        behavior: 'allow',
        scope: 'once',
      });
    });
  });

  it('opening the deny menu closes the allow menu', () => {
    act(() => {
      root.render(createElement(ToolApprovalCard, { pending: makePending() }));
    });
    act(() => {
      click(container.querySelector('[aria-label="More allow options"]'));
    });
    act(() => {
      click(container.querySelector('[aria-label="More deny options"]'));
    });

    expect(
      document.querySelector('[data-testid="tool-approval-allow-menu"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="tool-approval-deny-menu"]'),
    ).not.toBeNull();
  });
  describe('keyboard focus and reason field (CAN-4997)', () => {
    function reasonToggle(): HTMLButtonElement | null {
      return container.querySelector(
        '[data-testid="tool-approval-reason-toggle"]',
      );
    }

    function reasonField(): HTMLTextAreaElement | null {
      return container.querySelector('[data-testid="tool-approval-reason"]');
    }

    function typeReason(text: string): void {
      act(() => {
        const input = reasonField() as HTMLTextAreaElement;
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value',
        )?.set;
        setter?.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }

    function pressInReason(init: KeyboardEventInit): void {
      act(() => {
        reasonField()?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
      });
    }

    function openReason(pending = makePending()): void {
      act(() => {
        root.render(createElement(ToolApprovalCard, { pending }));
      });
      act(() => {
        reasonToggle()?.focus();
        click(reasonToggle());
      });
    }

    afterEach(() => {
      mockIsMac = true;
    });

    it('names the card group by its title and description', () => {
      act(() => {
        root.render(
          createElement(ToolApprovalCard, {
            pending: makePending({ description: 'Cleans the build folder' }),
          }),
        );
      });
      const card = container.querySelector(
        '[data-testid="tool-approval-card"]',
      );
      expect(card?.getAttribute('role')).toBe('group');
      const titleId = card?.getAttribute('aria-labelledby') ?? '';
      const descriptionId = card?.getAttribute('aria-describedby') ?? '';
      expect(document.getElementById(titleId)?.textContent).toBe('Run command');
      expect(document.getElementById(descriptionId)?.textContent).toBe(
        'Cleans the build folder',
      );

      act(() => {
        root.render(
          createElement(ToolApprovalCard, { pending: makePending() }),
        );
      });
      expect(card?.hasAttribute('aria-describedby')).toBe(false);
    });

    it('never takes focus on its own without a host handle', () => {
      act(() => {
        root.render(
          createElement(ToolApprovalCard, { pending: makePending() }),
        );
      });
      expect(document.activeElement).toBe(document.body);
    });

    it('focuses Allow once, or Choose file… for a browser file request', () => {
      const handle: { current: ToolApprovalCardHandle | null } = {
        current: null,
      };
      act(() => {
        root.render(
          createElement(ToolApprovalCard, {
            pending: makePending(),
            focusHandleRef: handle,
          }),
        );
      });
      act(() => handle.current?.focusPrimaryAction());
      expect(
        (document.activeElement as HTMLElement | null)?.dataset.testid,
      ).toBe('tool-approval-allow');

      act(() => {
        root.render(
          createElement(ToolApprovalCard, {
            pending: makePending({
              requestId: 'req-2',
              details: {
                kind: 'browser-file-request',
                origin: 'https://upload.example',
                multiple: false,
              },
              suggestedTarget: undefined,
            }),
            focusHandleRef: handle,
          }),
        );
      });
      act(() => handle.current?.focusPrimaryAction());
      expect(
        (document.activeElement as HTMLElement | null)?.dataset.testid,
      ).toBe('tool-approval-choose-files');
    });

    it('falls back to the labelled card when its primary action is disabled', () => {
      const handle: { current: ToolApprovalCardHandle | null } = {
        current: null,
      };
      act(() =>
        root.render(
          createElement(ToolApprovalCard, {
            pending: makePending(),
            focusHandleRef: handle,
          }),
        ),
      );
      const primary = container.querySelector<HTMLButtonElement>(
        '[data-testid="tool-approval-allow"]',
      );
      if (!primary) throw new Error('Missing primary action');
      primary.disabled = true;
      act(() => handle.current?.focusPrimaryAction());
      expect(document.activeElement).toBe(
        container.querySelector('[data-testid="tool-approval-card"]'),
      );
      primary.disabled = false;
    });

    it('opens a labelled reason field with focus and returns focus to the toggle on close', () => {
      openReason();
      const toggle = reasonToggle();
      const field = reasonField();
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      expect(toggle?.getAttribute('aria-controls')).toBe(field?.id);
      expect(document.activeElement).toBe(field);
      expect(
        container.querySelector(`label[for="${field?.id ?? ''}"]`)?.textContent,
      ).toBe('Reason for denying');

      act(() => {
        click(toggle);
      });
      expect(reasonField()).toBeNull();
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(toggle?.hasAttribute('aria-controls')).toBe(false);
      expect(document.activeElement).toBe(toggle);
    });

    it('does not carry a reason over to another request', () => {
      openReason();
      typeReason('Not now');
      act(() => {
        root.render(
          createElement(ToolApprovalCard, {
            pending: makePending({ requestId: 'req-2' }),
          }),
        );
      });
      expect(reasonField()).toBeNull();
      act(() => {
        click(reasonToggle());
      });
      expect(reasonField()?.value).toBe('');
    });

    it('Cmd+Enter on macOS denies once with the reason and stops at the field', () => {
      // Document-level shortcuts (the composer's send and Escape handling)
      // never see the handled chord.
      const documentKeydown = jest.fn();
      document.addEventListener('keydown', documentKeydown);
      openReason();
      typeReason('Not safe to run right now');
      pressInReason({ metaKey: true });
      expect(respondToApprovalMock).toHaveBeenCalledTimes(1);
      expect(respondToApprovalMock).toHaveBeenCalledWith('req-1', {
        behavior: 'deny',
        scope: 'once',
        message: 'Not safe to run right now',
      });
      expect(documentKeydown).not.toHaveBeenCalled();
      document.removeEventListener('keydown', documentKeydown);
    });

    it('Ctrl+Enter submits elsewhere, and the other platform modifier does not', () => {
      mockIsMac = false;
      openReason();
      typeReason('No');
      pressInReason({ metaKey: true });
      expect(respondToApprovalMock).not.toHaveBeenCalled();
      pressInReason({ ctrlKey: true });
      expect(respondToApprovalMock).toHaveBeenCalledTimes(1);
      expect(respondToApprovalMock).toHaveBeenCalledWith('req-1', {
        behavior: 'deny',
        scope: 'once',
        message: 'No',
      });
    });

    it('plain Enter, IME Enter, key repeat, and extra modifiers never submit', () => {
      openReason();
      typeReason('Not now');
      pressInReason({});
      pressInReason({ metaKey: true, isComposing: true });
      pressInReason({ metaKey: true, repeat: true });
      pressInReason({ metaKey: true, shiftKey: true });
      pressInReason({ metaKey: true, altKey: true });
      pressInReason({ metaKey: true, ctrlKey: true });
      expect(respondToApprovalMock).not.toHaveBeenCalled();
    });

    it('sends one response while one is in flight, and allows a retry after a failure', async () => {
      // The chat store resolves without removing the request when main
      // rejects the response; the card stays for a retry.
      let settleFirst: () => void = () => undefined;
      respondToApprovalMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            settleFirst = resolve;
          }),
      );
      openReason();
      typeReason('Not now');
      pressInReason({ metaKey: true });
      pressInReason({ metaKey: true });
      act(() => {
        click(container.querySelector('[data-testid="tool-approval-deny"]'));
      });
      expect(respondToApprovalMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        settleFirst();
        await Promise.resolve();
      });
      expect(reasonField()).not.toBeNull();
      expect(document.activeElement).toBe(reasonField());
      pressInReason({ metaKey: true });
      expect(respondToApprovalMock).toHaveBeenCalledTimes(2);
    });
  });
});

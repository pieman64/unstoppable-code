/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ToolApprovalCard } from '../ToolApprovalCard';

const respondToApprovalMock = jest.fn();

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

  it('asks the user to choose files or decline, with the agent purpose quoted and no rule options', () => {
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
    act(() => {
      click(choose);
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
      click(
        container.querySelector('[aria-label="More allow options"]') as Element,
      );
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
      click(
        container.querySelector('[aria-label="More deny options"]') as Element,
      );
    });

    const menu = document.querySelector(
      '[data-testid="tool-approval-deny-menu"]',
    );
    const stopItem = Array.from(
      menu?.querySelectorAll('button[role="menuitem"]') ?? [],
    ).find((btn) => btn.textContent === 'Deny and stop');
    expect(stopItem).toBeDefined();

    act(() => {
      click(stopItem as Element);
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
});

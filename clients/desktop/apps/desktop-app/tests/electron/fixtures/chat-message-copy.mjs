import { expect } from '@playwright/test';
import { seedWorktreeChat } from '../seeders/index.mjs';

export const COPY_CHAT_ID = 'can-4277-copy';
export const COPY_PAUSED_CHAT_ID = 'can-4704-paused';
export const COPY_PROMPT = 'Please **copy** this 🌲';
export const COPY_REPLY = '# Result\n\nFirst **block**\n\n- second';
export const COPY_PLAIN = 'Result\n\nFirst block\n\n- second';
export const COPY_QUESTION_CHAT_ID = 'can-4277-question';
export const COPY_LINK_CHAT_ID = 'can-2632-link';
export const COPY_LINK_URL = 'http://canopy-e2e.invalid/p?x=1#frag';

export function copyMessages() {
  return [
    {
      id: 'copy-user',
      role: 'user',
      timestamp: 1,
      blocks: [{ type: 'text', text: COPY_PROMPT }],
    },
    {
      id: 'copy-assistant',
      role: 'assistant',
      timestamp: 2,
      blocks: [
        { type: 'text', text: '# Result\n\nFirst **block**' },
        {
          type: 'tool_use',
          toolUseId: 'copy-tool',
          toolName: 'Bash',
          input: '{"command":"echo hidden"}',
        },
        {
          type: 'tool_result',
          toolUseId: 'copy-tool',
          toolName: 'Bash',
          output: 'hidden tool output',
          isError: false,
        },
        { type: 'thinking', text: 'hidden reasoning' },
        { type: 'text', text: '- second' },
      ],
    },
    {
      id: 'copy-timer',
      role: 'system',
      timestamp: 3,
      blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 3 }],
    },
  ];
}

export function seedCopyChat({ userDataDir, history = false, paused = false }) {
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [
      ...(paused
        ? [
            {
              id: COPY_PAUSED_CHAT_ID,
              title: 'Paused reply',
              messages: [
                {
                  id: 'paused-user',
                  role: 'user',
                  timestamp: 30,
                  blocks: [{ type: 'text', text: 'Pause this reply' }],
                },
                {
                  id: 'paused-assistant',
                  role: 'assistant',
                  timestamp: 31,
                  blocks: [{ type: 'text', text: 'Partial reply' }],
                },
                {
                  id: 'paused-timer',
                  role: 'system',
                  timestamp: 32,
                  blocks: [
                    {
                      type: 'turn_timer',
                      startedAt: 30,
                      pausedAt: 32,
                      completedAt: null,
                    },
                  ],
                },
              ],
            },
          ]
        : []),
      {
        id: COPY_CHAT_ID,
        title: 'Message copy',
        messages: [
          ...copyMessages(),
          ...(history
            ? [
                {
                  id: 'copy-user-2',
                  role: 'user',
                  timestamp: 10,
                  blocks: [{ type: 'text', text: 'Another reply' }],
                },
                {
                  id: 'copy-assistant-2',
                  role: 'assistant',
                  timestamp: 11,
                  blocks: [{ type: 'text', text: 'Second **answer**' }],
                },
                {
                  id: 'copy-timer-2',
                  role: 'system',
                  timestamp: 12,
                  blocks: [
                    { type: 'turn_timer', startedAt: 10, completedAt: 12 },
                  ],
                },
              ]
            : []),
        ],
      },
      {
        id: COPY_QUESTION_CHAT_ID,
        title: 'Visible question',
        messages: [
          {
            id: 'question-user',
            role: 'user',
            timestamp: 4,
            blocks: [{ type: 'text', text: 'Ask about scope' }],
          },
          {
            id: 'question-visible',
            role: 'assistant',
            timestamp: 5,
            blocks: [
              {
                type: 'text',
                text: 'Which **scope**?',
                asyncQuestion: {
                  requestId: 'untracked-question',
                  questions: [{ title: 'Which scope?', options: null }],
                },
              },
            ],
          },
          {
            id: 'question-timer',
            role: 'system',
            timestamp: 6,
            blocks: [{ type: 'turn_timer', startedAt: 4, completedAt: 6 }],
          },
        ],
      },
      {
        id: COPY_LINK_CHAT_ID,
        title: 'Message link',
        messages: [
          {
            id: 'link-user',
            role: 'user',
            timestamp: 7,
            blocks: [{ type: 'text', text: 'Share the guide' }],
          },
          {
            id: 'link-assistant',
            role: 'assistant',
            timestamp: 8,
            blocks: [
              {
                type: 'text',
                text: `Read [the guide](${COPY_LINK_URL}) first.`,
              },
            ],
          },
          {
            id: 'link-timer',
            role: 'system',
            timestamp: 9,
            blocks: [{ type: 'turn_timer', startedAt: 7, completedAt: 9 }],
          },
        ],
      },
    ],
    activeTabId: COPY_CHAT_ID,
  });
}

/** Real Chromium input and actual clipboard reads, shared by desktop/Portal. */
export async function assertCopyActions(
  page,
  row,
  { markdown, plain, readClipboard },
) {
  await row.evaluate((element) =>
    element.ownerDocument.getSelection()?.removeAllRanges(),
  );
  await row.click({ button: 'right' });
  await expect(page.getByTestId('chat-message-context-menu')).toBeVisible();
  await expect(page.getByTestId('chat-message-copy-selection')).toHaveCount(0);
  await page.getByTestId('chat-message-copy-markdown').click();
  await expect.poll(readClipboard).toBe(markdown);
  await expectMenuCopied(page);
  await row.click({ button: 'right' });
  await page.getByTestId('chat-message-copy-plain').click();
  await expect.poll(readClipboard).toBe(plain);
  await expectMenuCopied(page);

  // Snapshot survives focus movement and explicit live-selection clearing.
  const selected = await row.evaluate((element) => {
    const text = element.querySelector('p') ?? element;
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(text);
    const selection = element.ownerDocument.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const rect = range.getBoundingClientRect();
    return {
      text: selection.toString(),
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    };
  });
  expect(selected.text.length).toBeGreaterThan(0);
  await page.mouse.click(selected.x, selected.y, { button: 'right' });
  await expect(page.getByTestId('chat-message-copy-selection')).toBeEnabled();
  await row.evaluate((element) =>
    element.ownerDocument.getSelection()?.removeAllRanges(),
  );
  await page.getByTestId('chat-message-copy-selection').click();
  await expect.poll(readClipboard).toBe(selected.text);
  await expectMenuCopied(page);
}

/**
 * CAN-4704: a menu copy shows and announces `Copied` where the menu was,
 * without taking focus. Assert right after one copy; the next press
 * dismisses it.
 */
export async function expectMenuCopied(page) {
  const status = page.getByTestId('chat-message-copied');
  await expect(status).toBeVisible();
  await expect(status).toContainText('Copied');
  await expect(status.getByRole('status')).toHaveText('Copied');
  await expect(page.getByTestId('chat-message-copy-failed')).toHaveCount(0);
  expect(
    await status.evaluate((element) =>
      element.contains(element.ownerDocument.activeElement),
    ),
  ).toBe(false);
}

/**
 * CAN-4704: a finished reply's Copy is visible at rest, reached with Tab from
 * the focusable control before it, and copies the reply's Markdown on Enter
 * and on Space with a `Copied` check, name and announcement.
 */
export async function assertVisibleReplyCopy(
  page,
  copy,
  { markdown, readClipboard, writeClipboard },
) {
  await page.mouse.move(1, 1);
  await expect(copy).toBeVisible();
  await expect(copy).toHaveAttribute('aria-label', 'Copy message');
  // toBeVisible ignores opacity, so check the button and every ancestor.
  expect(
    await copy.evaluate((element) => {
      const view = element.ownerDocument.defaultView;
      for (let node = element; node; node = node.parentElement) {
        if (view.getComputedStyle(node).opacity !== '1') return false;
      }
      return true;
    }),
  ).toBe(true);

  // Focus the existing control that precedes Copy in the tab order.
  const focusedPrevious = await copy.evaluate((element) => {
    const doc = element.ownerDocument;
    const focusable = Array.from(
      doc.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]',
      ),
    ).filter(
      (candidate) =>
        candidate.tabIndex >= 0 && candidate.getClientRects().length > 0,
    );
    const previous = focusable[focusable.indexOf(element) - 1];
    if (!previous) return false;
    previous.focus();
    return doc.activeElement === previous;
  });
  expect(focusedPrevious).toBe(true);
  await page.keyboard.press('Tab');
  await expect(copy).toBeFocused();

  // The status sits beside the button's tooltip wrapper.
  const status = copy.locator(
    'xpath=../following-sibling::*[@role="status"][1]',
  );
  await writeClipboard('reply copy sentinel');
  await page.keyboard.press('Enter');
  await expect.poll(readClipboard).toBe(markdown);
  await expect(copy).toHaveAttribute('aria-label', 'Copied');
  await expect(status).toHaveText('Copied');
  await expect(copy).toBeFocused();
  await expect(copy).toHaveAttribute('aria-label', 'Copy message', {
    timeout: 5_000,
  });
  await expect(status).toHaveText('');

  await writeClipboard('reply copy sentinel');
  await page.keyboard.press('Space');
  await expect.poll(readClipboard).toBe(markdown);
  await expect(copy).toHaveAttribute('aria-label', 'Copied');
}

/** Keyboard-only approach from an adjacent focus target, no locator.focus(). */
export async function assertKeyboardAndNestedEditable(page, row) {
  await row.evaluate((element) => {
    const before = element.ownerDocument.createElement('button');
    before.dataset.testid = 'copy-keyboard-start';
    before.textContent = 'Before message';
    element.before(before);
    before.focus();
  });
  await page.keyboard.press('Tab');
  await expect(row).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByTestId('chat-message-copy-plain')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('chat-message-copy-markdown')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(row).toBeFocused();
  await row.evaluate((element) => {
    const input = element.ownerDocument.createElement('input');
    input.dataset.testid = 'copy-nested-editable';
    input.value = 'Nested editable positive control';
    element.append(input);
  });
  await page.getByTestId('copy-nested-editable').click({ button: 'right' });
  await expect(page.getByTestId('chat-message-context-menu')).toHaveCount(0);
  await page
    .getByTestId('copy-nested-editable')
    .evaluate((element) => element.remove());
  await page
    .getByTestId('copy-keyboard-start')
    .evaluate((element) => element.remove());
}

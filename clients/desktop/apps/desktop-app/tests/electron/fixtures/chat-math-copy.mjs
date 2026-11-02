import { expect } from '@playwright/test';
import { seedWorktreeChat } from '../seeders/index.mjs';
import { expectMenuCopied } from './chat-message-copy.mjs';

export const MATH_COPY_CHAT_ID = 'can-5012-math-copy';
export const MATH_COPY_SINGLE_DOLLAR_TEXT = 'The bound is $n$ edges.';
export const MATH_COPY_INLINE_TEXT = String.raw`Inline \(R(3,3) = 6\) and $\binom{n}{2}$ together.`;
export const MATH_COPY_LITERAL_TEXT =
  'It costs $5 or $10, and $HOME and $PATH stay text. Code: `$x$`.';
export const MATH_COPY_REPLY_TEXT = [
  MATH_COPY_SINGLE_DOLLAR_TEXT,
  MATH_COPY_INLINE_TEXT,
  MATH_COPY_LITERAL_TEXT,
].join('\n\n');

export const MATH_COPY_SINGLE_DOLLAR_MESSAGE_ID = 'math-copy-single-dollar';
export const MATH_COPY_INLINE_MESSAGE_ID = 'math-copy-inline';
export const MATH_COPY_LITERAL_MESSAGE_ID = 'math-copy-literal';

const SINGLE_DOLLAR_SOURCE = '$n$';
const DISPLAYED_INLINE_SOURCE = String.raw`\(R(3,3) = 6\)`;
const BINOMIAL_SOURCE = String.raw`$\binom{n}{2}$`;

export function mathCopyMessages() {
  return [
    {
      id: 'math-copy-user',
      role: 'user',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'Please copy the rendered math.' }],
    },
    {
      id: MATH_COPY_SINGLE_DOLLAR_MESSAGE_ID,
      role: 'assistant',
      timestamp: 2,
      blocks: [{ type: 'text', text: MATH_COPY_SINGLE_DOLLAR_TEXT }],
    },
    {
      id: MATH_COPY_INLINE_MESSAGE_ID,
      role: 'assistant',
      timestamp: 3,
      blocks: [{ type: 'text', text: MATH_COPY_INLINE_TEXT }],
    },
    {
      id: MATH_COPY_LITERAL_MESSAGE_ID,
      role: 'assistant',
      timestamp: 4,
      blocks: [{ type: 'text', text: MATH_COPY_LITERAL_TEXT }],
    },
    {
      id: 'math-copy-timer',
      role: 'system',
      timestamp: 5,
      blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 5 }],
    },
  ];
}

export function seedMathCopyChat({ userDataDir }) {
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [
      {
        id: MATH_COPY_CHAT_ID,
        title: 'Math copy coverage',
        messages: mathCopyMessages(),
      },
    ],
    activeTabId: MATH_COPY_CHAT_ID,
  });
}

export async function assertMathRendering({
  singleDollarRow,
  inlineRow,
  literalRow,
}) {
  await expect(singleDollarRow.locator('.katex')).toHaveCount(1);
  await expect(inlineRow.locator('.katex')).toHaveCount(2);
  await expect(literalRow.locator('.katex')).toHaveCount(0);
  await expect(literalRow.locator('code')).toHaveText('$x$');

  const singleDollar = singleDollarRow.locator(
    '.canopy-markdown-math-container',
  );
  await expect(singleDollar).toHaveAttribute(
    'data-math-source',
    SINGLE_DOLLAR_SOURCE,
  );
  const inlineMath = inlineRow.locator('.canopy-markdown-math-container');
  await expect(inlineMath).toHaveCount(2);
  await expect(inlineMath.nth(0)).toHaveAttribute(
    'data-math-source',
    DISPLAYED_INLINE_SOURCE,
  );
  await expect(inlineMath.nth(1)).toHaveAttribute(
    'data-math-source',
    BINOMIAL_SOURCE,
  );
}

/** Selects the message paragraph with a DOM Range and returns its bounds. */
export async function selectRowText(row) {
  await row.scrollIntoViewIfNeeded();
  return row.evaluate((element) => {
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
}

/** Starts within visible KaTeX output and selects through the message end. */
export async function selectFormulaThroughMessageEnd(row, source) {
  await row.scrollIntoViewIfNeeded();
  return row.evaluate((element, formulaSource) => {
    const formula = Array.from(
      element.querySelectorAll('.canopy-markdown-math-container'),
    ).find(
      (candidate) =>
        candidate.getAttribute('data-math-source') === formulaSource,
    );
    if (!formula)
      throw new Error(`Could not find math source ${formulaSource}`);

    const rendered = formula.querySelector('.katex-html') ?? formula;
    const doc = element.ownerDocument;
    const walker = doc.createTreeWalker(rendered, 4);
    const start = walker.nextNode();
    if (!start) throw new Error('Rendered formula has no selectable text');

    const text = element.querySelector('p') ?? element;
    const range = doc.createRange();
    range.setStart(start, 0);
    range.setEnd(text, text.childNodes.length);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return {
      text: selection.toString(),
      startsInsideFormula: formula.contains(range.startContainer),
    };
  }, source);
}

function copyShortcut() {
  return process.platform === 'darwin' ? 'Meta+C' : 'Control+C';
}

/** Exercise native selection copy, menu copy, and explicit reply copy. */
export async function assertMathClipboardActions(
  page,
  { singleDollarRow, inlineRow, replyCopy, readClipboard, writeClipboard },
) {
  await writeClipboard('native math copy sentinel');
  const wholeMessage = await selectRowText(inlineRow);
  expect(wholeMessage.text.length).toBeGreaterThan(0);
  await page.keyboard.press(copyShortcut());
  await expect.poll(readClipboard).toBe(MATH_COPY_INLINE_TEXT);

  await writeClipboard('partial math copy sentinel');
  const partialFormula = await selectFormulaThroughMessageEnd(
    inlineRow,
    BINOMIAL_SOURCE,
  );
  expect(partialFormula.startsInsideFormula).toBe(true);
  await page.keyboard.press(copyShortcut());
  await expect.poll(readClipboard).toBe(`${BINOMIAL_SOURCE} together.`);

  await writeClipboard('context math copy sentinel');
  const firstMessage = await selectRowText(singleDollarRow);
  expect(firstMessage.text.length).toBeGreaterThan(0);
  await page.mouse.click(firstMessage.x, firstMessage.y, { button: 'right' });
  const menu = page.getByTestId('chat-message-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['Copy selection']);
  const copySelection = page.getByTestId('chat-message-copy-selection');
  await expect(copySelection).toBeEnabled();
  await copySelection.click();
  await expect.poll(readClipboard).toBe(MATH_COPY_SINGLE_DOLLAR_TEXT);
  await expectMenuCopied(page);

  // A selection in a rendered formula must not change the explicit reply Copy
  // action's payload: it copies this turn's Markdown, not the selected range.
  await writeClipboard('explicit reply copy sentinel');
  const selectedFormula = await selectFormulaThroughMessageEnd(
    inlineRow,
    BINOMIAL_SOURCE,
  );
  expect(selectedFormula.startsInsideFormula).toBe(true);
  await page.mouse.move(1, 1);
  await expect(replyCopy).toBeVisible();
  await expect(replyCopy).toHaveAttribute('aria-label', 'Copy message');
  const formulaStillSelected = await inlineRow.evaluate((element) => {
    const selection = element.ownerDocument.getSelection();
    if (!selection?.rangeCount) return false;
    const start = selection.getRangeAt(0).startContainer;
    return Array.from(
      element.querySelectorAll('.canopy-markdown-math-container'),
    ).some((formula) => formula.contains(start));
  });
  expect(formulaStillSelected).toBe(true);
  await replyCopy.click();
  await expect.poll(readClipboard).toBe(MATH_COPY_REPLY_TEXT);
}

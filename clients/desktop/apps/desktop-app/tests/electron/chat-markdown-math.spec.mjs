import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { setUiScale } from './uiScale.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';

import { edgeMarkdown } from './fixtures/chat-width-edges.mjs';
import {
  assertMathClipboardActions,
  assertMathRendering,
  MATH_COPY_CHAT_ID,
  MATH_COPY_INLINE_MESSAGE_ID,
  MATH_COPY_LITERAL_MESSAGE_ID,
  MATH_COPY_SINGLE_DOLLAR_MESSAGE_ID,
  seedMathCopyChat,
} from './fixtures/chat-math-copy.mjs';
import { DEFAULT_MOCK_BASE_URL, registerScenario } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

/** Chooses a row from a drawn diagram's "More diagram actions" menu. */
async function chooseDiagramAction(window, diagram, name) {
  await diagram
    .getByRole('button', { name: 'More diagram actions', exact: true })
    .click();
  await window
    .getByRole('menu', { name: 'Diagram actions' })
    .getByRole('menuitem', { name, exact: true })
    .click();
}
/**
 * The main window's toast for a diagram export result, even when the diagram
 * is in a pulled-out window. It is dismissed unless the caller keeps it to use
 * its action.
 */
async function expectToast(window, message, { keep = false } = {}) {
  const toast = window
    .getByTestId('toast-live-region')
    .getByTestId('toast-stack-card')
    .filter({ hasText: message });
  await expect(toast).toBeVisible();
  if (keep) return toast;
  await toast.getByRole('button', { name: /^Dismiss/ }).click();
  await expect(toast).toHaveCount(0);
  return toast;
}
/** The toolbar control whose glyph shows the success checkmark. */
const confirmedControl = (diagram) =>
  diagram.locator('button:has([data-confirmed])');
const CHAT_ID = 'markdown-math-coverage';

const MARKDOWN_WITH_MATH = [
  '# Transcript math coverage',
  '',
  String.raw`Inline math: \(\alpha + \beta = \gamma\).`,
  '',
  String.raw`\[`,
  String.raw`\text{output tokens/joule} =`,
  String.raw`\frac{\text{aggregate output tokens/second across all users}}`,
  String.raw`{\text{average system watts}}`,
  String.raw`\]`,
  '',
  '$$',
  String.raw`E = mc^2`,
  '$$',
  '',
  '``` Math',
  String.raw`\sum_{i=1}^{n} i = \frac{n(n+1)}{2}`,
  '```',
  '',
  '```latex',
  String.raw`\begin{bmatrix} 1 & 0 \\ 0 & 1 \end{bmatrix}`,
  '```',
  '',
  'Inline code stays literal: `\\(literal_inline\\)`.',
  '',
  '```text',
  String.raw`\[literal_fenced_block\]`,
  '```',
  '',
  String.raw`Malformed math remains readable: \[\notacommand\]`,
].join('\n');

test('chat transcript renders TeX math while preserving code literals', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-markdown-math-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Markdown Math Coverage',
        blocks: [{ type: 'text', text: MARKDOWN_WITH_MATH }],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    await expect(chatPanel).toBeVisible({ timeout: 30_000 });
    await expect(
      chatPanel.getByRole('heading', { name: 'Transcript math coverage' }),
    ).toBeVisible();

    // Wide chats keep the transcript and composer on the same readable column.
    await window.setViewportSize({ width: 1800, height: 1000 });
    const transcript = chatPanel.getByTestId('chat-message-list-content');
    const composer = chatPanel.locator('[data-chat-composer-root]');
    await expect
      .poll(() => transcript.evaluate((element) => element.clientWidth))
      .toBe(736);
    const composerContentWidth = () =>
      composer.evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          element.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight)
        );
      });
    await expect.poll(composerContentWidth).toBe(736);
    await window.setViewportSize({ width: 1000, height: 800 });
    await expect
      .poll(() => transcript.evaluate((element) => element.clientWidth))
      .toBeLessThan(736);
    await expect.poll(composerContentWidth).toBeLessThan(736);

    await expect(chatPanel.locator('.katex')).toHaveCount(5);
    await expect(chatPanel.locator('.katex-display')).toHaveCount(4);
    await expect(
      chatPanel.locator('code').getByText('\\(literal_inline\\)'),
    ).toBeVisible();
    await expect(
      chatPanel
        .locator('pre code')
        .getByText('\\[literal_fenced_block\\]', { exact: true }),
    ).toBeVisible();
    await expect(
      chatPanel.getByText('\\notacommand', { exact: false }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('chat transcript copies rendered inline math as its original TeX source', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-math-copy-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedMathCopyChat({ userDataDir });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${MATH_COPY_CHAT_ID}"]`,
    );
    await expect(chatPanel).toBeVisible({ timeout: 30_000 });
    const singleDollarRow = chatPanel.locator(
      `[data-chat-message-id="${MATH_COPY_SINGLE_DOLLAR_MESSAGE_ID}"]`,
    );
    const inlineRow = chatPanel.locator(
      `[data-chat-message-id="${MATH_COPY_INLINE_MESSAGE_ID}"]`,
    );
    const literalRow = chatPanel.locator(
      `[data-chat-message-id="${MATH_COPY_LITERAL_MESSAGE_ID}"]`,
    );
    await expect(singleDollarRow).toBeVisible();
    await expect(inlineRow).toBeVisible();
    await expect(literalRow).toBeVisible();
    await assertMathRendering({ singleDollarRow, inlineRow, literalRow });

    const readClipboard = () =>
      electronApp.evaluate(({ clipboard }) => clipboard.readText());
    const writeClipboard = (text) =>
      electronApp.evaluate(
        ({ clipboard }, value) => clipboard.writeText(value),
        text,
      );
    await assertMathClipboardActions(window, {
      singleDollarRow,
      inlineRow,
      replyCopy: chatPanel.getByTestId('turn-copy-message').first(),
      readClipboard,
      writeClipboard,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Display can turn off dollar-sign math and the choice persists (CAN-5124)', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-dollar-math-setting-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedMathCopyChat({ userDataDir });

  const openChat = async (window) => {
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const chatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${MATH_COPY_CHAT_ID}"]`,
    );
    await expect(chatPanel).toBeVisible({ timeout: 30_000 });
    return {
      app,
      singleDollarRow: chatPanel.locator(
        `[data-chat-message-id="${MATH_COPY_SINGLE_DOLLAR_MESSAGE_ID}"]`,
      ),
      inlineRow: chatPanel.locator(
        `[data-chat-message-id="${MATH_COPY_INLINE_MESSAGE_ID}"]`,
      ),
    };
  };

  let { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const { app, singleDollarRow, inlineRow } = await openChat(window);
    await expect(singleDollarRow.locator('.katex')).toHaveCount(1);

    await app.openSettings();
    await app.openSettingsSection('display');
    const off = window.getByTestId('single-dollar-math-off');
    await off.click();
    await expect(off).toHaveAttribute('aria-pressed', 'true');
    await app.closeSettings();

    // `$n$` stays text; the `\\(...\\)` formula still renders.
    await expect(singleDollarRow.locator('.katex')).toHaveCount(0);
    await expect(singleDollarRow).toContainText('$n$');
    await expect(inlineRow.locator('.katex')).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  }

  ({ electronApp } = await launchCanopy({ userDataDir }));
  try {
    const window = await electronApp.firstWindow();
    const { singleDollarRow, inlineRow } = await openChat(window);
    await expect(inlineRow.locator('.katex')).toHaveCount(1);
    await expect(singleDollarRow.locator('.katex')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const file of [false, true]) {
  test(`Mermaid literal placeholders render in ${file ? 'file preview' : 'chat'} without changing source`, async () => {
    const { seedMarkdownMermaid, MERMAID_PLACEHOLDER_SOURCE } =
      await import('./seeders/seedMarkdownMermaid.mjs');
    const markdown = `# Literal placeholders\n\n\`\`\`mermaid\n${MERMAID_PLACEHOLDER_SOURCE}\n\`\`\``;
    const userDataDir = seedMarkdownMermaid({ file, markdown });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      const panel = window.getByTestId(
        file ? 'panel-content-file-diff' : 'panel-content-chat',
      );
      await expect(
        panel.getByRole('heading', { name: 'Literal placeholders' }),
      ).toBeVisible();
      const diagram = panel.getByTestId('markdown-mermaid');
      const image = diagram.getByRole('img', {
        name: 'Sequence diagram: Literal placeholders',
      });
      await expect(image).toBeVisible();
      await expect(image.locator('svg')).toContainText('vis_<uuid>');
      await chooseDiagramAction(window, diagram, 'Show diagram text');
      await expect(diagram.locator('pre')).toHaveText(
        MERMAID_PLACEHOLDER_SOURCE,
      );
      await chooseDiagramAction(window, diagram, 'Copy diagram text');
      await expect(confirmedControl(diagram)).toHaveAttribute(
        'data-testid',
        'mermaid-more-actions',
      );
      await expectToast(window, 'Diagram text copied.');
      await expect
        .poll(() =>
          electronApp.evaluate(({ clipboard }) => clipboard.readText()),
        )
        .toBe(MERMAID_PLACEHOLDER_SOURCE);
      await diagram
        .getByRole('button', { name: 'Show diagram', exact: true })
        .click();
      await expect(image).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test(`Mermaid diagrams render in ${file ? 'file preview' : 'chat'} with source recovery`, async () => {
    const { seedMarkdownMermaid, MERMAID_SOURCE } =
      await import('./seeders/seedMarkdownMermaid.mjs');
    const userDataDir = seedMarkdownMermaid({ file });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      const panel = window.getByTestId(
        file ? 'panel-content-file-diff' : 'panel-content-chat',
      );
      await expect(
        panel.getByRole('heading', { name: 'Diagram preview' }),
      ).toBeVisible();
      const diagrams = panel.getByTestId('markdown-mermaid');
      const flowName = 'Flow diagram: Diagram preview';
      await expect(diagrams.getByRole('img')).toHaveCount(2);
      await expect(diagrams).toHaveCount(3);
      await expect(
        diagrams.nth(0).getByRole('img', { name: flowName }),
      ).toBeVisible();
      await expect(
        diagrams
          .nth(1)
          .getByRole('img', { name: 'Sequence diagram: Diagram preview' }),
      ).toBeVisible();
      await chooseDiagramAction(window, diagrams.first(), 'Show diagram text');
      await expect(diagrams.first().locator('pre')).toHaveText(MERMAID_SOURCE);
      await chooseDiagramAction(window, diagrams.first(), 'Copy diagram text');
      await expectToast(window, 'Diagram text copied.');
      const copied = await electronApp.evaluate(({ clipboard }) =>
        clipboard.readText(),
      );
      expect(copied).toBe(MERMAID_SOURCE);
      await diagrams
        .first()
        .getByRole('button', { name: 'Show diagram', exact: true })
        .click();
      await expect(
        diagrams.first().getByRole('img', { name: flowName }),
      ).toBeVisible();
      await expect(diagrams.nth(2).getByRole('status')).toHaveText(
        "This diagram couldn't be drawn.",
      );
      await expect(diagrams.nth(2).locator('pre')).toBeHidden();
      await expect(
        diagrams.nth(2).getByRole('button', { name: /image|picture/i }),
      ).toHaveCount(0);
      await diagrams
        .nth(2)
        .getByRole('button', { name: 'Show diagram text', exact: true })
        .click();
      await expect(diagrams.nth(2).locator('pre')).toHaveText(
        'this is not a diagram',
      );
      await expect(
        panel
          .locator('pre')
          .filter({ hasText: 'flowchart LR; keep this as code' }),
      ).toBeVisible();
      if (file) {
        const previousStyle = await window.evaluate(() =>
          document.documentElement.getAttribute('style'),
        );
        try {
          await window.evaluate(() => {
            document.documentElement.style.setProperty(
              '--line-base',
              'rgba(0, 0, 0, 0.5)',
            );
            document.documentElement.style.setProperty(
              '--bg-secondary',
              '#ffffff',
            );
          });
          await expect
            .poll(async () =>
              diagrams
                .first()
                .locator('svg .node rect')
                .first()
                .evaluate((node) => getComputedStyle(node).stroke),
            )
            .toMatch(/^rgb\(12[78], 12[78], 12[78]\)$/);
        } finally {
          await window.evaluate((style) => {
            if (style === null)
              document.documentElement.removeAttribute('style');
            else document.documentElement.setAttribute('style', style);
          }, previousStyle);
        }
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('Mermaid renderer clipboard permission permits one PNG and HTML write', async () => {
  const { seedMarkdownMermaid } =
    await import('./seeders/seedMarkdownMermaid.mjs');
  const userDataDir = seedMarkdownMermaid({ file: false });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(() => {
      const button = document.createElement('button');
      button.textContent = 'Test diagram clipboard permission';
      button.onclick = () => {
        const png = new Promise((resolve) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 2;
          canvas.getContext('2d').fillRect(0, 0, 2, 2);
          canvas.toBlob(resolve, 'image/png');
        });
        void navigator.clipboard
          .write([
            new ClipboardItem({
              'image/png': png,
              'text/html': Promise.resolve(
                new Blob(['<b>Diagram permission</b>'], { type: 'text/html' }),
              ),
            }),
          ])
          .then(
            () => {
              button.textContent = 'Diagram clipboard granted';
            },
            (error) => {
              button.textContent = 'Diagram clipboard refused: ' + error.name;
            },
          );
      };
      document.body.append(button);
    });
    await window
      .getByRole('button', { name: 'Test diagram clipboard permission' })
      .click();
    await expect(
      window.getByRole('button', {
        name: 'Diagram clipboard granted',
        exact: true,
      }),
    ).toBeVisible();
    const readback = await electronApp.evaluate(({ clipboard }) => ({
      empty: clipboard.readImage().isEmpty(),
      html: clipboard.readHTML(),
    }));
    expect(readback.empty).toBe(false);
    expect(readback.html).toContain('Diagram permission');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Mermaid images copy from a pulled-out chat panel', async () => {
  const { seedMarkdownMermaid } =
    await import('./seeders/seedMarkdownMermaid.mjs');
  const userDataDir = seedMarkdownMermaid();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(
      window.getByTestId('markdown-mermaid').first().getByRole('img'),
    ).toBeVisible();
    const opened = electronApp.waitForEvent('window');
    await window.getByTestId('panel-group-menu-group-chat').click();
    await window.getByTestId('panel-group-pop-out-group-chat').click();
    const auxiliary = await opened;
    const diagram = auxiliary.getByTestId('markdown-mermaid').first();
    await expect(diagram.getByRole('img')).toBeVisible();
    await diagram.getByTestId('mermaid-copy-image').click();
    await expect(confirmedControl(diagram)).toHaveAttribute(
      'data-testid',
      'mermaid-copy-image',
    );
    await expectToast(window, 'Image copied.');
    const copied = await electronApp.evaluate(({ clipboard }) => ({
      empty: clipboard.readImage().isEmpty(),
      html: clipboard.readHTML(),
    }));
    expect(copied.empty).toBe(false);
    expect(copied.html).toContain('data:image/svg+xml;base64,');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Mermaid image exports wait for the current theme render', async () => {
  const { seedMarkdownMermaid } =
    await import('./seeders/seedMarkdownMermaid.mjs');
  const userDataDir = seedMarkdownMermaid();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const diagram = window
      .getByTestId('panel-content-chat')
      .getByTestId('markdown-mermaid')
      .first();
    await expect(diagram.getByRole('img')).toBeVisible();
    // Hold the renderer at its real font-readiness boundary after changing theme.
    await window.evaluate(() => {
      let release;
      const waiting = new Promise((resolve) => (release = resolve));
      Object.defineProperty(document.fonts, 'ready', {
        configurable: true,
        get() {
          document.documentElement.dataset.can5040ThemeWaiting = 'true';
          return waiting;
        },
      });
      window.__can5040ReleaseThemeRender = () => {
        Reflect.deleteProperty(document.fonts, 'ready');
        release();
      };
      document.documentElement.classList.toggle('dark');
    });
    await expect(window.locator('html')).toHaveAttribute(
      'data-can5040-theme-waiting',
      'true',
    );
    await expect(diagram.getByRole('img')).toBeVisible();
    await expect(diagram.getByTestId('mermaid-copy-image')).toBeDisabled();
    await expect(diagram.getByTestId('mermaid-save-png')).toBeDisabled();
    await diagram.getByTestId('mermaid-more-actions').click();
    await expect(
      window.getByRole('menuitem', { name: 'Save as SVG…', exact: true }),
    ).toBeDisabled();
    await window.keyboard.press('Escape');
    await window.evaluate(() => window.__can5040ReleaseThemeRender());
    await expect(diagram.getByTestId('mermaid-copy-image')).toBeEnabled();
    await expect(diagram.getByTestId('mermaid-save-png')).toBeEnabled();
    await diagram.getByTestId('mermaid-copy-image').click();
    await expectToast(window, 'Image copied.');
    expect(
      await electronApp.evaluate(({ clipboard }) =>
        clipboard.readImage().isEmpty(),
      ),
    ).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const file of [false, true]) {
  test(`Mermaid diagrams export pictures in ${file ? 'file preview beside the document' : 'chat'}`, async () => {
    const { seedMarkdownMermaid, mermaidDocumentPath } =
      await import('./seeders/seedMarkdownMermaid.mjs');
    const userDataDir = seedMarkdownMermaid({ file });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      const panel = window.getByTestId(
        file ? 'panel-content-file-diff' : 'panel-content-chat',
      );
      const diagram = panel.getByTestId('markdown-mermaid').first();
      await expect(
        diagram.getByRole('img', { name: 'Flow diagram: Diagram preview' }),
      ).toBeVisible();
      const copyImage = diagram.getByRole('button', {
        name: 'Copy image',
        exact: true,
      });
      await copyImage.click();
      await expectToast(window, 'Image copied.');
      const clipboard = await electronApp.evaluate(({ clipboard }) => ({
        png: Array.from(clipboard.readImage().toPNG()),
        html: clipboard.readHTML(),
      }));
      const copiedPng = Buffer.from(clipboard.png);
      expect(copiedPng.subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(copiedPng.readUInt32BE(16)).toBeGreaterThan(16);
      expect(copiedPng.readUInt32BE(20)).toBeGreaterThan(16);
      const embedded = /data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/.exec(
        clipboard.html,
      );
      expect(embedded).not.toBeNull();
      expect(
        Buffer.from(embedded?.[1] ?? '', 'base64').toString('utf8'),
      ).toMatch(/>Write<\/tspan>[^]*> Markdown<\/tspan>/);

      if (file) {
        // Start the normal watcher before saving; discovery must not depend on reopening or refreshing.
        await panel.getByTestId('file-tab-tree-toggle').click();
        const tree = window.getByTestId('file-tab-tree');
        await expect(tree).toBeVisible();
        const directory = path.dirname(mermaidDocumentPath(userDataDir));
        const pngSignature = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        await diagram
          .getByRole('button', { name: 'Save as picture…', exact: true })
          .click();
        await expect(confirmedControl(diagram)).toHaveAttribute(
          'data-testid',
          'mermaid-save-png',
        );
        await expectToast(window, 'Saved DIAGRAM-diagram-preview.png.');
        await expect(
          tree.getByText('DIAGRAM-diagram-preview.png', { exact: true }),
        ).toBeVisible();
        const png = readFileSync(
          path.join(directory, 'DIAGRAM-diagram-preview.png'),
        );
        expect(png.subarray(0, 8).equals(pngSignature)).toBe(true);
        expect(png.readUInt32BE(16)).toBeGreaterThan(0);
        expect(png.readUInt32BE(20)).toBeGreaterThan(0);

        // A second save never overwrites: it takes the next free name.
        await diagram
          .getByRole('button', { name: 'Save as picture…', exact: true })
          .click();
        await expectToast(window, 'Saved DIAGRAM-diagram-preview-2.png.');
        expect(
          readFileSync(path.join(directory, 'DIAGRAM-diagram-preview.png')),
        ).toEqual(png);

        // The keyboard context menu offers the same picture actions.
        await diagram.locator('[aria-label="Diagram scroll area"]').focus();
        await window.keyboard.press('Shift+F10');
        const menu = window.getByTestId('mermaid-context-menu');
        await expect(menu.getByRole('menuitem')).toHaveText([
          'Copy image',
          'Save as picture…',
          'Save as SVG…',
          'Copy diagram text',
        ]);
        await menu
          .getByRole('menuitem', { name: 'Save as SVG…', exact: true })
          .click();
        const savedSvgToast = await expectToast(
          window,
          'Saved DIAGRAM-diagram-preview.svg.',
          { keep: true },
        );
        const savedSvg = readFileSync(
          path.join(directory, 'DIAGRAM-diagram-preview.svg'),
          'utf8',
        );
        expect(savedSvg).toMatch(
          /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/,
        );
        // Mermaid splits labels into one tspan per word.
        expect(savedSvg).toMatch(/>Write<\/tspan>[^]*> Markdown<\/tspan>/);
        expect(savedSvg).toMatch(/<rect [^>]*fill="#[0-9a-f]{6}"/);
        expect(savedSvg).not.toMatch(/<script|onload=|javascript:/i);

        await expect(
          tree.getByText('DIAGRAM-diagram-preview.svg', { exact: true }),
        ).toBeVisible();
        await panel.getByTestId('file-tab-tree-toggle').click();

        await savedSvgToast
          .getByRole('button', { name: 'Open', exact: true })
          .click();
        await expect(
          window.getByText('DIAGRAM-diagram-preview.svg').first(),
        ).toBeVisible();
      } else {
        // Observe Electron's actual download lifecycle and isolate its destination.
        const downloadPath = path.join(userDataDir, 'diagram-preview.png');
        await electronApp.evaluate(({ BrowserWindow }, destination) => {
          globalThis.__can5040Download = null;
          BrowserWindow.getAllWindows()[0].webContents.session.once(
            'will-download',
            (_event, item) => {
              item.setSavePath(destination);
              item.once('done', (_done, state) => {
                globalThis.__can5040Download = {
                  state,
                  filename: item.getFilename(),
                  path: item.getSavePath(),
                };
              });
            },
          );
        }, downloadPath);
        await diagram
          .getByRole('button', { name: 'Save as picture…', exact: true })
          .click();
        await expect
          .poll(() => electronApp.evaluate(() => globalThis.__can5040Download))
          .toEqual({
            state: 'completed',
            filename: 'diagram-preview.png',
            path: downloadPath,
          });
        await expectToast(window, 'Download started.');
        await expect
          .poll(() => {
            try {
              return readFileSync(downloadPath).subarray(0, 8).toString('hex');
            } catch {
              return '';
            }
          })
          .toBe('89504e470d0a1a0a');
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('Mermaid supports diagram families and keeps unsafe input as source', async () => {
  const { seedMarkdownMermaid } =
    await import('./seeders/seedMarkdownMermaid.mjs');
  const allowed = [
    'sequenceDiagram\nT-->>A: <uuid> <img> <svg> <script> <iframe>',
    'sequenceDiagram\nT-->>A: #60;img src=https://mermaid-tracker.invalid/pixel#62;',
    'classDiagram\nAnimal <|-- Duck',
    'classDiagram\nAnimal <|-- Duck',
    'stateDiagram-v2\n[*] --> Ready\nReady --> Done',
    'erDiagram\nPERSON ||--o{ ORDER : places',
    'gantt\ntitle A plan\ndateFormat YYYY-MM-DD\nTask :2026-09-14, 1d',
  ];
  const rejected = [
    '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B',
    'flowchart LR\nA@{ img: "https://mermaid-tracker.invalid/pixel" }',
    'flowchart LR\nA@{ "img": "https://mermaid-tracker.invalid/pixel" }',
    'flowchart LR\nA@{ "\\x69mg": "https://mermaid-tracker.invalid/pixel" }',
    'flowchart LR\nA-->B\n%% \\41\nclick A "https://mermaid-tracker.invalid/pixel"',
    'sequenceDiagram\nlink Alice: Dashboard @ https://mermaid-tracker.invalid',
    'sequenceDiagram\nlinks Alice: {"Dashboard": "https://mermaid-tracker.invalid"}',
    'sequenceDiagram\nparticipant Alice\ndetails Alice: mermaid-sequence-details\nAlice->>Bob: Review',
    'flowchart LR\nA["<img src=https://mermaid-tracker.invalid onerror=alert(1)>"]',
    'flowchart LR\nclassDef bad fill:url(https://mermaid-tracker.invalid)',
    'stateDiagram-v2\u2028classDef x mask-image:image-set("https://mermaid-tracker.invalid/pixel")\u2028[*] --> A:::x',
    'sequenceDiagram\nrect u\\72l(https://mermaid-tracker.invalid/pixel)\nAlice->>Bob: Review\nend',
    'gantt\ntitle Hidden request\ndateFormat YYYY-MM-DD\ntodayMarker stroke:u\\72l(https://mermaid-tracker.invalid/pixel)\nTask :2026-09-14, 1d',
  ];
  const markdown = [
    '# Diagram families',
    ...[...allowed, ...rejected].map(
      (source) => `\n\`\`\`mermaid\n${source}\n\`\`\`\n`,
    ),
  ].join('\n');
  const userDataDir = seedMarkdownMermaid({ file: true, markdown });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const remoteRequests = [];
    window.on('request', (request) => {
      if (request.url().includes('mermaid-tracker.invalid'))
        remoteRequests.push(request.url());
    });
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await window.evaluate(() => {
      const details = document.createElement('div');
      details.id = 'mermaid-sequence-details';
      details.textContent = JSON.stringify({
        properties: {
          icon: 'https://mermaid-tracker.invalid/pixel',
        },
      });
      document.body.append(details);
    });
    const panel = window.getByTestId('panel-content-file-diff');
    const diagrams = panel.getByTestId('markdown-mermaid');
    await expect(diagrams).toHaveCount(allowed.length + rejected.length);
    const familyNames = [
      'Sequence diagram',
      'Sequence diagram',
      'Class diagram',
      'Class diagram',
      'State diagram',
      'Entity relationship diagram',
      'Gantt chart',
    ].map((family) => `${family}: Diagram families`);
    for (let index = 0; index < allowed.length; index += 1) {
      await diagrams.nth(index).scrollIntoViewIfNeeded();
      const image = diagrams
        .nth(index)
        .getByRole('img', { name: familyNames[index], exact: true });
      await expect(image).toBeVisible();
      await expect(image.locator('svg')).toHaveCount(1);
    }
    await expect(diagrams.nth(0).getByRole('img').locator('svg')).toContainText(
      '<uuid> <img> <svg> <script> <iframe>',
    );
    await expect(diagrams.nth(1).getByRole('img').locator('svg')).toContainText(
      '<img src=https://mermaid-tracker.invalid/pixel>',
    );
    const svgIds = await diagrams
      .getByRole('img')
      .locator('svg[id], svg [id]')
      .evaluateAll((nodes) => nodes.map((node) => node.id));
    expect(new Set(svgIds).size).toBe(svgIds.length);
    for (let index = 0; index < rejected.length; index += 1) {
      const diagram = diagrams.nth(allowed.length + index);
      await diagram.scrollIntoViewIfNeeded();
      await expect(diagram.locator('pre')).toHaveText(rejected[index]);
      await expect(diagram.getByRole('img')).toHaveCount(0);
    }
    expect(remoteRequests).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Mermaid preserves authored accessibility metadata', async () => {
  const { seedMarkdownMermaid } =
    await import('./seeders/seedMarkdownMermaid.mjs');
  const markdown = [
    '# Accessible diagram',
    '',
    '```mermaid',
    'flowchart LR',
    'accTitle: Release workflow',
    'accDescr: Code moves from review to production.',
    'Review --> Production',
    '```',
  ].join('\n');
  const userDataDir = seedMarkdownMermaid({ file: true, markdown });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.getByTestId('panel-content-file-diff');
    const image = panel.getByRole('img', { name: 'Release workflow' });
    await expect(image).toBeVisible();
    await expect(image).toHaveAccessibleDescription(
      'Code moves from review to production.',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/** Computed paint of the shape behind a drawn flowchart node. */
function nodePaint(diagram, nodeId, property = 'fill') {
  return diagram
    .locator(`g.node[id*="flowchart-${nodeId}-"]`)
    .locator('rect, polygon, path')
    .first()
    .evaluate((shape, name) => getComputedStyle(shape)[name], property);
}
/** The single drawn flowchart edge whose id names both endpoints. */
async function edgePaint(diagram, edgeId, property) {
  const edge = diagram.locator(`path[id*="L_${edgeId}"]`);
  await expect(edge).toHaveCount(1);
  return edge.evaluate((path, name) => getComputedStyle(path)[name], property);
}

test('Created files opens the exact journey brief as a highlighted diagram', async () => {
  const { seedCreatedFiles, openCreatedFiles, CREATED_FILES_TURN } =
    await import('./createdFilesFixture.mjs');
  const { JOURNEY_BRIEF_DIAGRAM } =
    await import('./seeders/seedMarkdownMermaid.mjs');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-mermaid-brief-'),
  );
  const fixture = seedCreatedFiles(userDataDir, true, {
    fileNames: ['review-brief.md'],
  });
  writeFileSync(
    path.join(fixture.root, 'outputs', 'review-brief.md'),
    `# Current checkout flow\n\n\`\`\`mermaid\n${JOURNEY_BRIEF_DIAGRAM}\n\`\`\``,
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const chat = await openCreatedFiles(window, fixture);
    const summary = chat.locator(
      `[data-testid="turn-files"][data-turn-id="${CREATED_FILES_TURN}"]`,
    );
    await summary
      .getByRole('button', { name: 'Open review-brief.md', exact: true })
      .click();
    const viewer = window.getByTestId('file-viewer');
    await expect(
      viewer.getByRole('heading', { name: 'Current checkout flow' }),
    ).toBeVisible();
    const diagram = viewer.getByTestId('markdown-mermaid');
    await expect(diagram.getByRole('img')).toBeVisible();
    for (const node of ['Promo', 'Billing', 'Review']) {
      expect(await nodePaint(diagram, node)).toBe('rgb(253, 226, 226)');
    }
    expect(await nodePaint(diagram, 'Cart')).not.toBe('rgb(253, 226, 226)');
    await expect(diagram.getByRole('status')).toHaveCount(0);
    await chooseDiagramAction(window, diagram, 'Copy diagram text');
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(JOURNEY_BRIEF_DIAGRAM);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const file of [false, true]) {
  test(`styled Mermaid diagrams draw their highlighting in ${file ? 'file preview' : 'chat'}`, async () => {
    const {
      seedMarkdownMermaid,
      JOURNEY_BRIEF_DIAGRAM,
      PARTIALLY_STYLED_DIAGRAM,
      REMOVED_STYLING_DIAGRAM,
      MULTILINE_LABEL_DIAGRAM,
      DASHED_LINK_DIAGRAM,
    } = await import('./seeders/seedMarkdownMermaid.mjs');
    const markdown = [
      '# Checkout review',
      '',
      ...[
        JOURNEY_BRIEF_DIAGRAM,
        PARTIALLY_STYLED_DIAGRAM,
        REMOVED_STYLING_DIAGRAM,
        MULTILINE_LABEL_DIAGRAM,
        DASHED_LINK_DIAGRAM,
      ].flatMap((source) => ['```mermaid', source, '```', '']),
    ].join('\n');
    const userDataDir = seedMarkdownMermaid({ file, markdown });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      const panel = window.getByTestId(
        file ? 'panel-content-file-diff' : 'panel-content-chat',
      );
      const diagrams = panel.getByTestId('markdown-mermaid');
      const brief = diagrams.nth(0);
      // Chat opens at its end; diagrams draw once they near the viewport.
      await brief.scrollIntoViewIfNeeded();
      await expect(brief.getByRole('img')).toBeVisible();
      for (const node of ['Promo', 'Billing', 'Review']) {
        expect(await nodePaint(brief, node)).toBe('rgb(253, 226, 226)');
        expect(await nodePaint(brief, node, 'stroke')).toBe('rgb(217, 83, 79)');
      }
      expect(await nodePaint(brief, 'Cart')).not.toBe('rgb(253, 226, 226)');
      await expect(brief.getByRole('status')).toHaveCount(0);

      const partial = diagrams.nth(1);
      await expect(partial.getByRole('img')).toBeVisible();
      await expect(partial.getByRole('status')).toHaveText(
        "Some highlighting couldn't be shown here.",
      );
      expect(await nodePaint(partial, 'A')).toBe('rgb(255, 153, 255)');
      expect(
        await partial
          .locator('path[id*="L_B_C"]')
          .first()
          .evaluate((edge) => getComputedStyle(edge).stroke),
      ).toBe('rgb(217, 83, 79)');
      await chooseDiagramAction(window, partial, 'Copy diagram text');
      await expect
        .poll(() =>
          electronApp.evaluate(({ clipboard }) => clipboard.readText()),
        )
        .toBe(PARTIALLY_STYLED_DIAGRAM);

      expect(await nodePaint(partial, 'D', 'opacity')).toBe('1');
      await expect(partial.getByRole('img').locator('svg')).toContainText(
        '100%% done',
      );

      const removed = diagrams.nth(2);
      await expect(removed.getByRole('img')).toBeVisible();
      await expect(removed.getByRole('status')).toHaveText(
        "Some highlighting couldn't be shown here.",
      );
      const multiline = diagrams.nth(3);
      await expect(multiline.getByRole('img')).toBeVisible();
      await expect(multiline.getByRole('img').locator('svg')).toContainText(
        /style A\s*font-size:20px/,
      );
      await expect(multiline.getByRole('img').locator('svg')).toContainText(
        /style B\s*font-size:25px/,
      );
      await expect(multiline.getByRole('img').locator('svg')).toContainText(
        /style C\s*font-size:30px/,
      );
      await expect(multiline.getByRole('img').locator('svg')).toContainText(
        /style D\s*font-size:35px/,
      );
      await expect(multiline.getByRole('img').locator('svg')).toContainText(
        'style guide',
      );
      await expect(multiline.getByRole('status')).toHaveCount(0);
      expect(await nodePaint(multiline, 'B')).toBe('rgb(253, 226, 226)');

      // CAN-5295: the comma-spelled dash pattern draws without a removal note.
      const dashed = diagrams.nth(4);
      await dashed.scrollIntoViewIfNeeded();
      await expect(dashed.getByRole('img')).toBeVisible();
      await expect
        .poll(() => edgePaint(dashed, 'Refund_Manager', 'strokeDasharray'))
        .toBe('5px, 5px');
      await expect
        .poll(() => edgePaint(dashed, 'Refund_Manager', 'stroke'))
        .toBe('rgb(107, 114, 128)');
      // Mermaid draws its solid edges with a zero-length dash pattern.
      await expect
        .poll(() => edgePaint(dashed, 'Ticket_Triage', 'strokeDasharray'))
        .toBe('0px');
      await expect(dashed.getByRole('status')).toHaveCount(0);
      await chooseDiagramAction(window, dashed, 'Copy diagram text');
      await expect
        .poll(() =>
          electronApp.evaluate(({ clipboard }) => clipboard.readText()),
        )
        .toBe(DASHED_LINK_DIAGRAM);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('hostile Mermaid styling stays collapsed and requests nothing', async () => {
  const { seedMarkdownMermaid, HOSTILE_STYLED_SOURCES } =
    await import('./seeders/seedMarkdownMermaid.mjs');
  const markdown = [
    '# Hostile styling',
    '',
    ...HOSTILE_STYLED_SOURCES.flatMap((source) => [
      '```mermaid',
      source,
      '```',
      '',
    ]),
  ].join('\n');
  const userDataDir = seedMarkdownMermaid({ markdown });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const requests = [];
    window.on('request', (request) => {
      if (request.url().includes('mermaid-tracker.invalid'))
        requests.push(request.url());
    });
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.getByTestId('panel-content-chat');
    const diagrams = panel.getByTestId('markdown-mermaid');
    await expect(diagrams).toHaveCount(HOSTILE_STYLED_SOURCES.length);
    for (const [index, source] of HOSTILE_STYLED_SOURCES.entries()) {
      const diagram = diagrams.nth(index);
      await expect(diagram.getByRole('status')).toHaveText(
        "This diagram uses features that can't be drawn here.",
      );
      await expect(diagram.getByRole('img')).toHaveCount(0);
      await expect(diagram.locator('pre')).toBeHidden();
      const disclosure = diagram.getByRole('button', {
        name: 'Show diagram text',
        exact: true,
      });
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
      await disclosure.focus();
      await window.keyboard.press('Enter');
      await expect(diagram.locator('pre')).toHaveText(source);
      await expect(
        diagram.getByRole('button', { name: 'Hide diagram text', exact: true }),
      ).toHaveAttribute('aria-expanded', 'true');
    }
    expect(requests).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('chat search ignores generated Mermaid labels and finds authored prose', async () => {
  const { seedMarkdownMermaid } =
    await import('./seeders/seedMarkdownMermaid.mjs');
  const markdown = [
    '# Search boundary',
    '',
    'Show diagram text appears in authored prose.',
    '',
    '```mermaid',
    'flowchart LR',
    'A[Diagram label]',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    'click A "https://example.invalid"',
    '```',
  ].join('\n');
  const userDataDir = seedMarkdownMermaid({ markdown });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const chatPanel = window.getByTestId('panel-content-chat');
    await expect(
      chatPanel.getByRole('img', { name: 'Flow diagram: Search boundary' }),
    ).toBeVisible();

    await window.keyboard.press('ControlOrMeta+f');
    // CAN-3048: the chord opens the shared floating find bar in chat mode.
    const searchBar = window.getByTestId('surface-find-bar');
    await expect(searchBar).toBeVisible();
    await expect(searchBar).toHaveAttribute('data-find-mode', 'chat');
    await searchBar.getByRole('textbox').fill('Show diagram text');

    await expect(searchBar.getByText('1 of 1', { exact: true })).toBeVisible();

    await searchBar
      .getByRole('textbox')
      .fill("This diagram uses features that can't be drawn here");
    await expect(searchBar.getByText('0 of 0', { exact: true })).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('rich content fits first and only indivisible formulas scroll at narrow widths and larger scales', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-rich-width-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const markdown = [
    '## Adaptive content',
    '',
    '| ID | Name | Department | Status | Score |',
    '| --- | --- | --- | --- | --- |',
    '| 1 | Alex Morgan | Marketing | Active | 87 |',
    '| 2 | Jamie Chen | Engineering | Active | 94 |',
    '',
    '| Name | Description |',
    '| --- | --- |',
    '| Worker | A description with ordinary words that should wrap naturally within the available space without forcing equally sized columns. |',
    '',
    '| DeploymentIdentifier | DestinationRegion | RunningInstanceCount | LastCheckpointTime | RequestedMemoryBytes | OperationStatus |',
    '| --- | --- | --- | --- | --- | --- |',
    '| processingWorkerAlpha | europeWestProduction | 128 | 20260914T153000Z | 8589934592 | ReadyForDeployment |',
    '',
    '```typescript',
    'function configure() {',
    '    const path = "' + 'deployment/'.repeat(35) + '";',
    '    return path;',
    '}',
    '```',
    '',
    '$$',
    Array.from({ length: 24 }, (_, i) => `x_{${i + 1}}`).join(' + ') + ' = y',
    '$$',
    '',
    '$$',
    String.raw`\underbrace{\text{` +
      'indivisible'.repeat(30) +
      String.raw`}}_{\text{one term}}`,
    '$$',
    '',
    String.raw`Inline math stays inline: \(x + y\) within this sentence.`,
  ].join('\n');
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Adaptive content',
        blocks: [
          { type: 'text', text: markdown },
          {
            type: 'image',
            path: 'chat-wide.png',
            alt: 'Wide image',
            dataUrl:
              'data:image/png;base64,' +
              readFileSync(
                path.resolve(
                  'apps/desktop-app/tests/electron/fixtures/chat-wide.png',
                ),
              ).toString('base64'),
          },
          {
            type: 'thinking',
            text: 'Reviewing the long configuration path. '.repeat(12),
          },
          {
            type: 'tool_use',
            toolUseId: 'adaptive-tool',
            toolName: 'Bash',
            input: JSON.stringify({ command: 'deployment/'.repeat(35) }),
          },
          {
            type: 'tool_result',
            toolUseId: 'adaptive-tool',
            toolName: 'Bash',
            output: 'deployment/'.repeat(35),
            isError: false,
          },
        ],
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const content = window.getByTestId('chat-message-list-content');
    await expect(content.locator('.katex')).toHaveCount(3);
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await content.getByRole('button', { name: /^Thought/ }).click();
    const tool = content.locator(
      '[data-testid="chat-tool-call"][data-tool-name="Bash"]',
    );
    await tool.locator('button[aria-expanded]').first().click();
    for (const width of [1800, 1000]) {
      await window.setViewportSize({ width, height: 1100 });
      for (const scale of [100, 125, 150]) {
        await setUiScale(window, scale);
        for (const block of [
          ...(width === 1800
            ? await content.locator('table').all()
            : [content.locator('table').nth(1)]),
          content.getByRole('group', { name: 'Formula' }).first(),
          ...(await tool.locator('pre').all()),
        ]) {
          await expect
            .configure({ soft: true })
            .poll(
              () =>
                block.evaluate((element) =>
                  Math.max(
                    element.scrollWidth - element.clientWidth,
                    element.getBoundingClientRect().width -
                      element.parentElement.clientWidth,
                  ),
                ),
              { timeout: 1500 },
            )
            .toBeLessThanOrEqual(1);
        }
        for (const region of await content
          .getByRole('group', { name: 'Table' })
          .all()) {
          expect(
            await region.evaluate(
              (element) =>
                element.clientWidth - element.parentElement.clientWidth,
            ),
          ).toBeLessThanOrEqual(1);
        }
        if (width === 1000 && scale === 150) {
          const denseTable = content
            .getByRole('group', { name: 'Table' })
            .nth(2);
          await denseTable.focus();
          await denseTable.press('ArrowRight');
          await expect
            .poll(() => denseTable.evaluate((element) => element.scrollLeft))
            .toBeGreaterThan(0);
          await denseTable.evaluate((element) => {
            element.scrollLeft = 0;
          });
        }
        const generatedImage = content.getByTestId('chat-generated-image');
        await expect
          .poll(() =>
            generatedImage.evaluate(
              (element) =>
                element.getBoundingClientRect().width -
                element.parentElement.clientWidth,
            ),
          )
          .toBeLessThanOrEqual(1);
        expect(
          await generatedImage.evaluate(
            (element) =>
              element.getBoundingClientRect().width /
              element.getBoundingClientRect().height,
          ),
        ).toBeCloseTo(8.75, 1);
        for (const region of [
          content.getByRole('group', { name: 'Formula' }).nth(1),
          content.locator('.markdown-code-copy-host pre'),
        ]) {
          await expect(region).toHaveAttribute('tabindex', '0');
          await expect
            .poll(() =>
              region.evaluate(
                (element) => element.scrollWidth - element.clientWidth,
              ),
            )
            .toBeGreaterThan(0);
          await region.focus();
          await region.press('ArrowRight');
          await expect
            .poll(() => region.evaluate((element) => element.scrollLeft))
            .toBeGreaterThan(0);
          await region.evaluate((element) => {
            element.scrollLeft = element.scrollWidth;
          });
          await expect
            .poll(() =>
              region.evaluate(
                (element) =>
                  element.scrollWidth -
                  element.clientWidth -
                  element.scrollLeft,
              ),
            )
            .toBeLessThanOrEqual(1);
          await region.evaluate((element) => {
            element.scrollLeft = 0;
          });
        }
        await expect
          .poll(() => content.evaluate((element) => element.clientWidth))
          .toBeLessThanOrEqual(736);
      }
    }
    // Capture the clipboard boundary without changing the user's system clipboard.
    await window.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            document.documentElement.dataset.copiedCode = text;
          },
        },
      });
    });
    const code = content.locator('.markdown-code-copy-host');
    await code.hover();
    await code.getByRole('button', { name: 'Copy code to clipboard' }).click();
    await expect(code.getByRole('button', { name: 'Copied' })).toBeVisible();
    const copied = await window.evaluate(
      () => document.documentElement.dataset.copiedCode,
    );
    expect(copied).toBe(
      'function configure() {\n    const path = "' +
        'deployment/'.repeat(35) +
        '";\n    return path;\n}',
    );
    await expect(
      content.locator('.canopy-markdown-math[data-math-display="false"]'),
    ).not.toHaveAttribute('role', 'region');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('code stays unwrapped and equation labels stay clear while rich content streams', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-width-edges-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Width edge cases',
        blocks: [{ type: 'text', text: edgeMarkdown }],
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, 'Canopy-CWIDTH-EDGE-STREAM', {
    llm: {
      steps: [
        {
          text: edgeMarkdown + '\n\nStream finished.',
          streamMs: 8000,
          chunkChars: 40,
          stopReason: 'end_turn',
        },
      ],
    },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await window.setViewportSize({ width: 1000, height: 1100 });
    const content = window.getByTestId('chat-message-list-content');
    await expect(content.locator('.katex-tag')).toHaveCount(2);
    for (const tag of await content.locator('.katex-tag').all()) {
      expect(
        await tag.evaluate((element) => {
          const terms = [...element.parentElement.children].filter(
            (child) => child !== element,
          );
          return (
            element.getBoundingClientRect().top -
            Math.max(
              ...terms.map((child) => child.getBoundingClientRect().bottom),
            )
          );
        }),
      ).toBeGreaterThanOrEqual(-1);
    }
    const host = content.locator('.markdown-code-copy-host');
    await host.hover();
    await expect(
      host.getByRole('button', { name: 'Wrap long lines' }),
    ).toHaveCount(0);
    const pre = host.locator('pre');
    await pre.focus();
    await pre.press('ArrowRight');
    await expect
      .poll(() => pre.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    await pre.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    expect(
      await pre.evaluate(
        (element) =>
          element.scrollWidth - element.clientWidth - element.scrollLeft,
      ),
    ).toBeLessThanOrEqual(1);
    const cells = content.locator('tbody tr').first().locator('td');
    expect(
      await cells
        .nth(0)
        .evaluate((element) => element.getBoundingClientRect().width),
    ).toBeLessThan(
      await cells
        .nth(1)
        .evaluate((element) => element.getBoundingClientRect().width),
    );
    await window
      .getByRole('textbox')
      .first()
      .fill('[Canopy-CWIDTH-EDGE-STREAM] Stream the example.');
    await window
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      content.getByRole('heading', { name: 'Width edge cases' }),
    ).toHaveCount(2, { timeout: 90000 });
    // Observe repeated intermediate layouts, rather than checking only the final reply.
    for (let sample = 0; sample < 6; sample++) {
      for (const pre of await content
        .locator('.markdown-code-copy-host pre')
        .all()) {
        expect(
          await pre.evaluate(
            (element) =>
              element.getBoundingClientRect().width -
              element.parentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(1);
        expect(
          await pre.evaluate((element) => getComputedStyle(element).whiteSpace),
        ).toBe('pre');
      }
      expect(
        await content.evaluate((element) => element.clientWidth),
      ).toBeLessThanOrEqual(736);
      await window.waitForTimeout(300);
    }
    await expect(
      content.getByText('Stream finished.', { exact: true }),
    ).toBeVisible({ timeout: 30000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { setUiScale } from './uiScale.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';

import { edgeMarkdown } from './fixtures/chat-width-edges.mjs';
import { DEFAULT_MOCK_BASE_URL, registerScenario } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
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
      const image = diagram.getByRole('img', { name: 'Mermaid diagram' });
      await expect(image).toBeVisible();
      await expect(image.locator('svg')).toContainText('vis_<uuid>');
      await diagram
        .getByRole('button', { name: 'Show source', exact: true })
        .click();
      await expect(diagram.locator('pre')).toHaveText(
        MERMAID_PLACEHOLDER_SOURCE,
      );
      await diagram
        .getByRole('button', { name: 'Copy source', exact: true })
        .click();
      await expect(
        diagram.getByRole('button', { name: 'Copied', exact: true }),
      ).toBeVisible();
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
      await expect(
        panel.getByRole('img', { name: 'Mermaid diagram' }),
      ).toHaveCount(2);
      await expect(diagrams).toHaveCount(3);
      await expect(
        diagrams.nth(0).getByRole('img', { name: 'Mermaid diagram' }),
      ).toBeVisible();
      await expect(
        diagrams.nth(1).getByRole('img', { name: 'Mermaid diagram' }),
      ).toBeVisible();
      await diagrams
        .first()
        .getByRole('button', { name: 'Show source', exact: true })
        .click();
      await expect(diagrams.first().locator('pre')).toHaveText(MERMAID_SOURCE);
      const copyButton = diagrams
        .first()
        .getByRole('button', { name: 'Copy source', exact: true });
      await expect(copyButton).toHaveText('');
      await expect(copyButton.locator('svg')).toBeVisible();
      await copyButton.click();
      await expect(
        diagrams.first().getByRole('button', { name: 'Copied', exact: true }),
      ).toBeVisible();
      await expect(
        diagrams.first().getByRole('button', { name: 'Copied', exact: true }),
      ).toHaveText('');
      const copied = await electronApp.evaluate(({ clipboard }) =>
        clipboard.readText(),
      );
      expect(copied).toBe(MERMAID_SOURCE);
      await diagrams
        .first()
        .getByRole('button', { name: 'Show diagram', exact: true })
        .click();
      await expect(
        diagrams.first().getByRole('img', { name: 'Mermaid diagram' }),
      ).toBeVisible();
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
    for (let index = 0; index < allowed.length; index += 1) {
      await diagrams.nth(index).scrollIntoViewIfNeeded();
      await expect(
        diagrams.nth(index).getByRole('img', { name: 'Mermaid diagram' }),
      ).toBeVisible();
      await expect(
        diagrams
          .nth(index)
          .getByRole('img', { name: 'Mermaid diagram' })
          .locator('svg'),
      ).toHaveCount(1);
    }
    await expect(
      diagrams
        .nth(0)
        .getByRole('img', { name: 'Mermaid diagram' })
        .locator('svg'),
    ).toContainText('<uuid> <img> <svg> <script> <iframe>');
    await expect(
      diagrams
        .nth(1)
        .getByRole('img', { name: 'Mermaid diagram' })
        .locator('svg'),
    ).toContainText('<img src=https://mermaid-tracker.invalid/pixel>');
    const svgIds = await diagrams
      .getByRole('img', { name: 'Mermaid diagram' })
      .locator('svg[id], svg [id]')
      .evaluateAll((nodes) => nodes.map((node) => node.id));
    expect(new Set(svgIds).size).toBe(svgIds.length);
    for (let index = 0; index < rejected.length; index += 1) {
      const diagram = diagrams.nth(allowed.length + index);
      await diagram.scrollIntoViewIfNeeded();
      await expect(diagram.locator('pre')).toHaveText(rejected[index]);
      await expect(
        diagram.getByRole('img', { name: 'Mermaid diagram' }),
      ).toHaveCount(0);
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

test('chat search ignores generated Mermaid labels and finds authored prose', async () => {
  const { seedMarkdownMermaid } =
    await import('./seeders/seedMarkdownMermaid.mjs');
  const markdown = [
    '# Search boundary',
    '',
    'Show source appears in authored prose.',
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
      chatPanel.getByRole('img', { name: 'Mermaid diagram' }),
    ).toBeVisible();

    await window.keyboard.press('ControlOrMeta+f');
    // CAN-3048: the chord opens the shared floating find bar in chat mode.
    const searchBar = window.getByTestId('surface-find-bar');
    await expect(searchBar).toBeVisible();
    await expect(searchBar).toHaveAttribute('data-find-mode', 'chat');
    await searchBar.getByRole('textbox').fill('Show source');

    await expect(searchBar.getByText('1 of 1', { exact: true })).toBeVisible();

    await searchBar
      .getByRole('textbox')
      .fill('This diagram uses features unavailable in preview');
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
    await content.getByRole('button', { name: /^Thinking/ }).click();
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

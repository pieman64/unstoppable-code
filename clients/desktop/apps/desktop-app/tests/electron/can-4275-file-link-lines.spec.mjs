// CAN-4275: real Codex transcript → indexed pill / markdown → file viewer.
// Each click arms a fresh observer after the previous flash clears; snapshots
// retain exact source-line geometry so an earlier highlight cannot satisfy replay.
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';

const PROJECT = 'demo-ts-pnpm-vite';
const WORKTREE = 'demo-main';
const CHAT = 'can-4275-lines';
const FILE = 'src/can4275-lines.ts';
const OTHER_FILE = 'src/can4275-other.ts';
const marker = (line) => `CAN4275_UNIQUE_LINE_${line}_END`;
const GO_TO_START =
  process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home';

test('file pills and authored markdown replay whole-line reveals and replace ranges', async () => {
  test.setTimeout(90_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can4275-'));
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  writeFileSync(
    path.join(seed.workspaces[0].worktreePath, FILE),
    Array.from({ length: 10 }, (_, index) => `// ${marker(index + 1)}`).join(
      '\n',
    ),
  );
  writeFileSync(
    path.join(seed.workspaces[0].worktreePath, OTHER_FILE),
    '// Other file',
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT,
    worktreeId: WORKTREE,
    providerType: 'codex',
    activeTabId: CHAT,
    tabs: [
      {
        id: CHAT,
        title: 'Line references',
        messages: [
          {
            id: 'request',
            role: 'user',
            blocks: [{ type: 'text', text: 'Review the late source lines.' }],
            timestamp: 1792000000000,
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
    await app.selectWorktree(WORKTREE);
    await injectChatEvent(electronApp, {
      projectId: PROJECT,
      worktreeId: WORKTREE,
      chatId: CHAT,
      data: {
        type: 'codex',
        event: {
          type: 'item.completed',
          item: {
            id: 'line-references',
            type: 'agent_message',
            phase: 'final_answer',
            text: `[Cached source](${FILE}:1). [Other source](${OTHER_FILE}:1). Inspect ${FILE}:150-160. Also \`${FILE}#L155\`. [Authored source label](${FILE}:170:2-175:8)`,
          },
        },
      },
    });
    const chat = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT}"]`,
    );
    const rangePill = chat.getByRole('button', {
      name: `Open ${FILE}:150-160`,
      exact: true,
    });
    await expect(rangePill).toHaveText(`${FILE}:150-160`);
    await expect(rangePill).toHaveCount(1);
    const editor = window.locator('[data-testid="monaco-file-editor"]:visible');
    // Populate a short cached session, switch files, then let the agent grow it.
    // Reopening must consume the line request against the refreshed bytes.
    await chat
      .getByTestId('chat-local-file-link')
      .filter({ hasText: 'Cached source' })
      .click();
    await expect(
      editor.locator('.view-line').filter({ hasText: marker(10) }),
    ).toBeVisible();
    await chat
      .getByTestId('chat-local-file-link')
      .filter({ hasText: 'Other source' })
      .click();
    await expect(
      editor.locator('.view-line').filter({ hasText: 'Other file' }),
    ).toBeVisible();
    writeFileSync(
      path.join(seed.workspaces[0].worktreePath, FILE),
      Array.from({ length: 200 }, (_, index) => `// ${marker(index + 1)}`).join(
        '\n',
      ),
    );
    const revealLink = async (link, line, expectedLines) => {
      await expect(editor.locator('.canopy-editor-reveal-flash')).toHaveCount(
        0,
      );
      const requestId = await window.evaluate(() => {
        window.__can4275FlashObserver?.disconnect();
        window.__can4275RevealId = (window.__can4275RevealId ?? 0) + 1;
        const id = window.__can4275RevealId;
        window.__can4275Flashes = [];
        const observer = new MutationObserver(() => {
          const root = [
            ...document.querySelectorAll('[data-testid="monaco-file-editor"]'),
          ].find((candidate) => {
            const bounds = candidate.getBoundingClientRect();
            return (
              bounds.width > 0 &&
              bounds.height > 0 &&
              getComputedStyle(candidate).visibility !== 'hidden'
            );
          });
          if (!root) return;
          const flashes = [
            ...root.querySelectorAll('.canopy-editor-reveal-flash'),
          ];
          if (flashes.length === 0) return;
          const rows = [...root.querySelectorAll('.view-line')];
          const lines = flashes.map((flash) => {
            const bounds = flash.getBoundingClientRect();
            const row = rows.find(
              (item) =>
                Math.abs(item.getBoundingClientRect().top - bounds.top) < 1,
            );
            const match = row?.textContent?.match(
              /CAN4275_UNIQUE_LINE_(\d+)_END/,
            );
            return match ? Number(match[1]) : null;
          });
          window.__can4275Flashes.push({
            requestId: id,
            lines,
            wholeLines: flashes.every(
              (flash) =>
                flash instanceof HTMLElement &&
                flash.style.width === '100%' &&
                flash.getBoundingClientRect().width > 0,
            ),
          });
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style'],
        });
        window.__can4275FlashObserver = observer;
        return id;
      });
      await link.click();
      await expect(editor).toBeVisible();
      await expect(
        editor.locator('.view-line').filter({ hasText: marker(line) }),
      ).toBeInViewport();
      await expect
        .poll(() =>
          window.evaluate(
            ({ id, first, count }) => {
              const expected = Array.from(
                { length: count },
                (_, index) => first + index,
              );
              return window.__can4275Flashes.some(
                (flash) =>
                  flash.requestId === id &&
                  flash.wholeLines &&
                  JSON.stringify([...flash.lines].sort((a, b) => a - b)) ===
                    JSON.stringify(expected),
              );
            },
            { id: requestId, first: line, count: expectedLines },
          ),
        )
        .toBe(true);
      // Wait while the requested rows are still visible. Scrolling away can
      // remove overlay DOM without expiring its decoration; that is not proof
      // the previous request can no longer flash when those rows return.
      await expect(editor.locator('.canopy-editor-reveal-flash')).toHaveCount(
        0,
      );
    };
    await revealLink(rangePill, 150, 11);
    await editor.click();
    await window.keyboard.press(GO_TO_START);
    await expect(
      editor.locator('.view-line').filter({ hasText: marker(1) }),
    ).toBeInViewport();
    await revealLink(rangePill, 150, 11);
    const markdown = chat
      .getByTestId('chat-local-file-link')
      .filter({ hasText: 'Authored source label' });
    await expect(markdown).toHaveText('Authored source label');
    await expect(markdown).toHaveAttribute('title', `${FILE}:170:2-175:8`);
    await revealLink(markdown, 170, 6);
    await revealLink(
      chat.getByRole('button', { name: `Open ${FILE}#L155`, exact: true }),
      155,
      1,
    );
    // The retained one-line snapshot also proves the previous range was replaced.
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

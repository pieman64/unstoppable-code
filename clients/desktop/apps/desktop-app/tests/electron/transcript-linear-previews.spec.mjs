// ---------------------------------------------------------------------------
// Transcript Linear previews — inline titles and hover cards for references.
//
// Seeds a settled chat that mentions Linear issues, connects Linear through
// the app's real settings path against the shared GraphQL mock, and walks the
// user flow with Early access off: one paginated team-catalog load gates bare
// identifiers by accessible team key, visible references resolve their titles
// once through the bounded queue, the inline icon carries no text, native
// selection copies `ID: full title`, a long title is cut after a whole word,
// hover/keyboard/Escape and click behave, an inaccessible issue stays quiet,
// disconnecting removes decorations, and turning Early access on changes
// nothing.
//
// Visual evidence: pnpm run test:electron:captures:built transcript-linear-previews.capture-spec.ts
// ---------------------------------------------------------------------------
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { DEFAULT_GROUP_IDS } from './panelHarness.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { expectWordCut, readTruncation } from './wordBoundaryTruncation.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'linear-previews-chat';
const TOKEN = 'lin_api_e2e_reference_previews';
const ISSUE_URL = 'https://linear.app/acme/issue/CAN-42/preview-tickets';
const LINK_ITEMS = ['Copy link', 'Open in browser', 'Open in external browser'];
const COPY_ITEMS = ['Copy message', 'Copy as Markdown'];
const LONG_TITLE =
  'Preview tickets in transcripts with titles long enough to need visual truncation — résumé 日本語 🚀';
const ASSISTANT_TEXT = [
  'CAN-42 is in progress; REG-7 shipped. FOO-9 is not a team.',
  '',
  'Raw https://linear.app/acme/issue/CAN-42 and [the ticket](https://linear.app/acme/issue/CAN-42).',
  '',
  'Inline `CAN-43` stays code. CAN-404 is not shared with you.',
].join('\n');

// Seven teams over four pages; REG is only on the last page.
const TEAMS = ['ALP', 'BET', 'CAN', 'DEL', 'EPS', 'ZET', 'REG'].map(
  (key, index) => ({ id: `team_${index}`, key, name: key }),
);

function seed(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreeDataDir = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktree-data',
    WORKTREE_ID,
  );
  mkdirSync(worktreeDataDir, { recursive: true });
  writeFileSync(
    path.join(worktreeDataDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: 'advanced' }),
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Linear previews',
        messages: [
          {
            id: 'linear-previews-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Can you check CAN-42?' }],
            timestamp: Date.parse('2026-10-01T10:00:00.000Z'),
          },
          {
            id: 'linear-previews-assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: ASSISTANT_TEXT }],
            timestamp: Date.parse('2026-10-01T10:00:05.000Z'),
          },
        ],
      },
    ],
  });
}

// Main's Linear SDK resolves `globalThis.fetch` per request; count only the
// preview operations so other Linear traffic cannot satisfy the assertions.
async function countProviderReads(electronApp) {
  await electronApp.evaluate(() => {
    const original = globalThis.fetch;
    const counts = { issue: 0, teams: 0 };
    Reflect.set(globalThis, '__linearPreviewCounts', counts);
    globalThis.fetch = (input, init) => {
      if (typeof init?.body === 'string') {
        if (init.body.includes('referencePreviewIssue')) counts.issue += 1;
        if (init.body.includes('referencePreviewTeams')) counts.teams += 1;
      }
      return original(input, init);
    };
  });
  return () =>
    electronApp.evaluate(() => ({
      ...Reflect.get(globalThis, '__linearPreviewCounts'),
    }));
}

// Select a DOM range in the renderer, then copy through Chromium's native
// copy command and read the system clipboard.
async function copySelection(window, electronApp, select) {
  await electronApp.evaluate(({ clipboard }) => clipboard.clear());
  await window.evaluate(select);
  await electronApp.evaluate(({ BrowserWindow }) => {
    const focused =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    focused.webContents.copy();
  });
  await expect
    .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
    .not.toBe('');
  return electronApp.evaluate(({ clipboard }) => clipboard.readText());
}

test('Linear references show team-gated inline titles and preview cards', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-linear-previews-'),
  );
  seed(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, TOKEN, {
    linear: {
      previewTeams: TEAMS,
      teamPageSize: 2,
      issues: [
        {
          id: 'iss_can_42',
          identifier: 'CAN-42',
          title: LONG_TITLE,
          description: '## Goal\n\nShow **compact** issue cards.',
          url: ISSUE_URL,
          state: { name: 'In Progress' },
          assignee: { name: 'Rowan Doe', displayName: 'Rowan' },
          project: { name: 'Canopy' },
        },
        {
          id: 'iss_reg_7',
          identifier: 'REG-7',
          title: 'Registry rollout',
          url: 'https://linear.app/acme/issue/REG-7/registry-rollout',
        },
      ],
    },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    expect(
      await window.evaluate(() =>
        window.api.experiments
          .getSnapshot()
          .then((snapshot) => snapshot.earlyAccessEnabled),
      ),
    ).not.toBe(true);
    await window.evaluate((token) => window.api.saveLinearToken(token), TOKEN);
    const providerReads = await countProviderReads(electronApp);
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`).click();
    const chat = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    await expect(chat).toBeVisible();

    const references = chat.getByTestId('linear-reference');
    await expect(references).toHaveText([
      `CAN-42: ${LONG_TITLE}`,
      `CAN-42: ${LONG_TITLE}`,
      'REG-7: Registry rollout',
      `CAN-42: ${LONG_TITLE}`,
      'the ticket',
      'CAN-404',
    ]);
    // One paginated catalog; one read per visible identity (bare CAN-42,
    // bare REG-7, bare CAN-404, and the acme URL shared by both anchors).
    await expect.poll(providerReads).toEqual({ issue: 4, teams: 4 });
    await expect(chat).toContainText('FOO-9 is not a team.');
    await expect(chat.locator('code', { hasText: 'CAN-43' })).toBeVisible();
    await expect(
      chat.locator('a[href="https://linear.app/acme/issue/CAN-42"]'),
    ).toHaveCount(2);
    for (const reference of await references.all()) {
      await expect(reference.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    }

    // The title is clipped visually but whole in the DOM.
    const title = references.nth(1).getByTestId('linear-reference-title');
    const clipping = await title.evaluate((element) => ({
      overflow: getComputedStyle(element).textOverflow,
      clipped: element.scrollWidth > element.clientWidth,
      text: element.textContent,
    }));
    expect(clipping).toEqual({
      overflow: 'ellipsis',
      clipped: true,
      text: LONG_TITLE,
    });
    // The clip lands after the last whole word that fits (CAN-3889); the hover
    // card, not a native tooltip, shows the full title.
    await expect
      .poll(async () => (await readTruncation(title)).truncated)
      .toBe('word');
    const wide = await readTruncation(title);
    expectWordCut(wide, LONG_TITLE);
    expect(wide.title).toBeNull();
    expect(
      await readTruncation(
        references.nth(2).getByTestId('linear-reference-title'),
      ),
    ).toMatchObject({
      truncated: null,
      maxWidth: '',
      overflows: false,
      text: 'Registry rollout',
    });
    // A narrower column measures again and still cuts at a word.
    await title.evaluate(
      (element, width) => {
        element.closest('p').style.width = `${width}px`;
      },
      Math.floor(wide.width / 2),
    );
    await expect
      .poll(async () => (await readTruncation(title)).visibleLength)
      .toBeLessThan(wide.visibleLength);
    expectWordCut(await readTruncation(title), LONG_TITLE);
    await title.evaluate((element) => {
      element.closest('p').style.width = '';
    });
    await expect
      .poll(async () => (await readTruncation(title)).visibleLength)
      .toBe(wide.visibleLength);

    // Native selection: a whole label, part of one, and prose spanning two.
    expect(
      await copySelection(window, electronApp, () => {
        const target = document.querySelectorAll(
          '[data-testid="panel-content-chat"] [data-testid="linear-reference"]',
        )[1];
        const range = document.createRange();
        range.selectNodeContents(target);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      }),
    ).toBe(`CAN-42: ${LONG_TITLE}`);
    expect(
      await copySelection(window, electronApp, () => {
        const target = document.querySelectorAll(
          '[data-testid="panel-content-chat"] [data-testid="linear-reference-title"]',
        )[1];
        const text = target.firstChild;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 'Preview tickets'.length);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      }),
    ).toBe('Preview tickets');
    expect(
      await copySelection(window, electronApp, () => {
        const paragraph = document
          .querySelectorAll(
            '[data-testid="panel-content-chat"] [data-testid="linear-reference"]',
          )[1]
          .closest('p');
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      }),
    ).toBe(
      `CAN-42: ${LONG_TITLE} is in progress; REG-7: Registry rollout shipped. FOO-9 is not a team.`,
    );
    // First activation preserves the trigger and an existing native selection.
    await references.nth(1).evaluate((element) => {
      Reflect.set(window, '__linearOriginalTrigger', element);
    });
    const selectedProse = await window.evaluate(() =>
      getSelection()?.toString(),
    );
    const card = window.getByTestId('linear-issue-preview-card');
    await references.nth(1).hover();
    await expect(card).toContainText(LONG_TITLE);
    expect(
      await references
        .nth(1)
        .evaluate(
          (element) =>
            element === Reflect.get(window, '__linearOriginalTrigger'),
        ),
    ).toBe(true);
    expect(await window.evaluate(() => getSelection()?.toString())).toBe(
      selectedProse,
    );
    await window.evaluate(() => getSelection()?.removeAllRanges());
    await expect(card).toContainText('In Progress · Rowan · Canopy');
    await expect(card).toContainText('Goal Show compact issue cards.');
    await window.mouse.move(0, 0);
    await expect(card).toHaveCount(0);
    await window.keyboard.press('Shift');
    await references.nth(0).focus();
    await expect(card).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(references.nth(0)).toBeFocused();
    // Enter retains the link's single canonical navigation.
    await window.evaluate(() => {
      Reflect.set(window, '__linearOriginalWindowOpen', window.open);
      Reflect.set(window, '__openedUrls', []);
      window.open = (url) => {
        Reflect.get(window, '__openedUrls').push(String(url));
        return null;
      };
    });
    await window.keyboard.press('Enter');
    await expect
      .poll(() => window.evaluate(() => Reflect.get(window, '__openedUrls')))
      .toEqual([ISSUE_URL]);
    await references.nth(5).hover();
    await expect(window.getByRole('tooltip')).toContainText(
      'Preview unavailable',
    );
    await window.mouse.move(0, 0);
    expect(await providerReads()).toEqual({ issue: 4, teams: 4 });

    await window.evaluate(() => {
      Reflect.set(window, '__openedUrls', []);
      window.open = (url) => {
        Reflect.get(window, '__openedUrls').push(String(url));
        return null;
      };
    });
    await references.nth(1).click();
    await expect
      .poll(() => window.evaluate(() => Reflect.get(window, '__openedUrls')))
      .toEqual([ISSUE_URL]);

    await window.evaluate(() => {
      window.open = Reflect.get(window, '__linearOriginalWindowOpen');
    });

    // A resolved bare reference carries the message menu's link section
    // (CAN-2632); the canonical URL differs from the one written in prose.
    await expect(references.nth(1)).toContainText('CAN-42');
    await expect(references.nth(5)).toHaveText('CAN-404');
    await expect(references.nth(1)).toHaveAttribute('data-link-url', ISSUE_URL);
    await expect(references.nth(5)).not.toHaveAttribute('data-link-url', /.*/);
    await window.mouse.move(0, 0);
    await references.nth(1).click({ button: 'right' });
    const messageMenu = window.getByTestId('chat-message-context-menu');
    await expect(messageMenu).toBeVisible();
    expect(await messageMenu.getByRole('menuitem').allTextContents()).toEqual([
      ...LINK_ITEMS,
      ...COPY_ITEMS,
    ]);
    await electronApp.evaluate(({ clipboard }) => clipboard.writeText(''));
    await window.getByTestId('chat-message-copy-link').click();
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(ISSUE_URL);
    await expect(messageMenu).toHaveCount(0);
    // An unresolved reference offers only the copy items.
    await references.nth(5).click({ button: 'right' });
    await expect(messageMenu).toBeVisible();
    expect(await messageMenu.getByRole('menuitem').allTextContents()).toEqual(
      COPY_ITEMS,
    );
    await window.keyboard.press('Escape');
    await expect(messageMenu).toHaveCount(0);
    await window.mouse.move(0, 0);

    // Early access has no effect on previews.
    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: true,
      }),
    );
    await expect(references).toHaveCount(6);
    await expect(references.nth(2)).toHaveText('REG-7: Registry rollout');
    expect(await providerReads()).toEqual({ issue: 4, teams: 4 });

    // Disconnecting removes every decoration; URLs stay ordinary links.
    await window.evaluate(() => window.api.saveLinearToken(''));
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:linear-connection-changed')),
    );
    await expect(references).toHaveCount(0);
    await expect(
      chat.locator('a[href="https://linear.app/acme/issue/CAN-42"]'),
    ).toHaveCount(2);
    await expect(chat).toContainText('CAN-42 is in progress');
    expect(
      await window.evaluate(() =>
        localStorage.getItem('canopy.referencePreviews.v1'),
      ),
    ).toBeNull();

    // Reconnecting reloads the catalog and titles once.
    await window.evaluate((token) => window.api.saveLinearToken(token), TOKEN);
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:linear-connection-changed')),
    );
    await expect(references).toHaveCount(6);
    await expect(references.nth(2)).toHaveText('REG-7: Registry rollout');
    await expect.poll(providerReads).toEqual({ issue: 8, teams: 8 });

    // Adopt the stable transcript into another document before its first focus.
    await window.evaluate((groupId) => {
      window.__canopyPanelTestApi.setFixedTopology(false);
      window.__canopyPanelTestApi.splitPanel(groupId, 'right');
    }, DEFAULT_GROUP_IDS.chat);
    const auxiliaryPromise = electronApp.waitForEvent('window');
    const auxiliaryId = await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.popOutPanel(groupId),
      DEFAULT_GROUP_IDS.chat,
    );
    const auxiliary = await auxiliaryPromise;
    const auxiliaryReference = auxiliary.getByTestId('linear-reference').nth(1);
    await expect(auxiliaryReference).toBeVisible();
    await auxiliary.keyboard.press('Shift');
    await auxiliaryReference.focus();
    await expect(
      auxiliary.getByTestId('linear-issue-preview-card'),
    ).toContainText(LONG_TITLE);
    await expect(window.getByRole('tooltip')).toHaveCount(0);
    await auxiliary.setViewportSize({ width: 360, height: 500 });
    await expect
      .poll(() =>
        auxiliary.getByRole('tooltip').evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight
          );
        }),
      )
      .toBe(true);
    await auxiliary.keyboard.press('Escape');
    await expect(auxiliary.getByRole('tooltip')).toHaveCount(0);
    await expect(auxiliaryReference).toBeFocused();
    await window.evaluate(
      (id) => window.__canopyPanelTestApi.mergeBackWindow(id),
      auxiliaryId,
    );
    await expect.poll(() => auxiliary.isClosed()).toBe(true);
    await expect(references.nth(1)).toBeVisible();
    await references.nth(1).hover();
    await expect(card).toContainText(LONG_TITLE);
  } finally {
    await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

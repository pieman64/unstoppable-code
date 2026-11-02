import { mkdirSync, mkdtempSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSessionReuseFlow } from './seeders/sessionReuseFlow.mjs';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { openPipelineAssistant } from './pipelineAssistant.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';

const PIPELINE_ESCAPE_MARKER = 'Canopy-CPIPEESC';

// The toggle renders as soon as the page mounts, while the drawer's default
// resolves later, once preferences and the assistant's tabs have loaded. A
// single "no drawer" check would pass before that decision, so hold it across
// a window long enough for a wrong default to open the drawer.
async function expectDrawerStaysClosed(window) {
  const drawer = window.getByTestId('pipeline-chat-drawer');
  await expect(window.getByTestId('pipeline-chat-toggle')).toBeVisible();
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    await expect(drawer).toHaveCount(0);
    await window.waitForTimeout(100);
  }
}

// Embedded pipeline-editor chat drawer (frontend slice).
//
// Workflows > Library hosts a collapsible, resizable chat drawer. It opens by
// default only when the assistant already holds a conversation, so an empty
// assistant starts closed behind its page-header toggle (CAN-3980). The
// `pipelineChatPanelVisible` preference only allows the drawer: a collapse
// keeps it closed across navigation/restart even with a conversation, while a
// saved "visible" never opens an empty assistant by itself. This spec verifies
// both defaults, the collapse/show toggle, and what survives leaving and
// re-entering the Pipelines page (which remounts `PipelinesPage` and re-reads
// preferences).
//
// Testids exercised:
//   - `page-workflows-library` -> Library list view (drives openPipelinesPage)
//   - `pipeline-chat-drawer`  -> the drawer root (present only when visible)
//   - `pipeline-chat-panel`   -> the chat panel inside the drawer
//   - `pipeline-chat-toggle`  -> Library header toggle, visible whether
//                                the drawer is currently expanded or collapsed.
//
// Retained visual counterpart:
//   pnpm run test:electron:captures:built pipeline-assistant-drag-region.capture-spec.ts --reporter=line
test('pipeline-editor chat drawer starts closed for an empty assistant, toggles, and persists', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    // Hold the real snapshot response: the composer must not accept a draft
    // until it has a canonical chat target to receive the submission.
    await electronApp.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('chat:get-state');
      globalThis.pipelineSnapshotEntered = false;
      const gate = new Promise((resolve) => {
        globalThis.releasePipelineSnapshot = resolve;
      });
      ipcMain.removeHandler('chat:get-state');
      ipcMain.handle('chat:get-state', async (event, request) => {
        if (request.projectId === 'pipeline-editor') {
          globalThis.pipelineSnapshotEntered = true;
          await gate;
        }
        return original(event, request);
      });
    });
    await app.openPipelinesPage();
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.pipelineSnapshotEntered),
      )
      .toBe(true);
    const drawer = window.getByTestId('pipeline-chat-drawer');
    const panel = window.getByTestId('pipeline-chat-panel');
    const toggle = window.getByTestId('pipeline-chat-toggle');
    const collapse = window.getByTestId('pipeline-chat-collapse');

    // (1) Starts closed: the drawer waits behind its page-header toggle. The
    // toggle is an explicit choice, so it opens the drawer before the held
    // snapshot can say whether the assistant holds a conversation.
    await expect(drawer).toHaveCount(0);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('textbox')).toHaveCount(0);
    await electronApp.evaluate(() => globalThis.releasePipelineSnapshot());
    await expect(panel.getByRole('textbox').first()).toBeVisible();

    // (1b) Open: the drawer + chat panel render with the collapse control,
    // and the empty snapshot arriving does not close the chosen drawer.
    await expect(drawer).toBeVisible();
    await expect(collapse).toBeVisible();
    await expect(toggle).toHaveCount(0);

    // (1a) The panel header occupies the same top 40px band that the main
    // shell paints as an OS window-drag rect (`app-main-titlebar-drag-region`
    // in App.tsx). app-region hit testing ignores z-order, so without an
    // explicit no-drag hole the collapse button receives a window drag instead
    // of a click for REAL mice. Playwright's synthetic clicks bypass
    // app-region entirely, so `collapse.click()` below cannot catch this —
    // assert the computed region instead.
    const collapseBox = await collapse.boundingBox();
    expect(collapseBox).not.toBeNull();
    expect(collapseBox.y).toBeLessThan(40);
    await expect(collapse).toHaveCSS('-webkit-app-region', 'no-drag');

    const rootBoxWithDrawer = await window
      .getByTestId('page-pipelines-root')
      .boundingBox();
    const pageBoxWithDrawer = await window
      .getByTestId('page-workflows-library')
      .boundingBox();
    const drawerBox = await drawer.boundingBox();
    expect(rootBoxWithDrawer).not.toBeNull();
    expect(pageBoxWithDrawer).not.toBeNull();
    expect(drawerBox).not.toBeNull();
    expect(
      Math.abs(
        drawerBox.x +
          drawerBox.width -
          (rootBoxWithDrawer.x + rootBoxWithDrawer.width),
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        pageBoxWithDrawer.x +
          pageBoxWithDrawer.width / 2 -
          (rootBoxWithDrawer.x + drawerBox.x) / 2,
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(pageBoxWithDrawer.x + pageBoxWithDrawer.width - drawerBox.x),
    ).toBeLessThanOrEqual(1);

    const separator = window.getByRole('separator', {
      name: 'Resize workflow assistant',
    });
    const separatorBox = await separator.boundingBox();
    expect(separatorBox).not.toBeNull();
    await window.mouse.move(
      separatorBox.x + separatorBox.width / 2,
      separatorBox.y + separatorBox.height / 2,
    );
    await window.mouse.down();
    await window.mouse.move(
      rootBoxWithDrawer.x + rootBoxWithDrawer.width * 0.55,
      separatorBox.y + separatorBox.height / 2,
    );
    await window.mouse.up();

    const pageBoxAfterResize = await window
      .getByTestId('page-workflows-library')
      .boundingBox();
    const drawerBoxAfterResize = await drawer.boundingBox();
    expect(pageBoxAfterResize).not.toBeNull();
    expect(drawerBoxAfterResize).not.toBeNull();
    expect(drawerBoxAfterResize.width).not.toBe(drawerBox.width);
    expect(
      Math.abs(
        drawerBoxAfterResize.x +
          drawerBoxAfterResize.width -
          (rootBoxWithDrawer.x + rootBoxWithDrawer.width),
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        pageBoxAfterResize.x +
          pageBoxAfterResize.width / 2 -
          (rootBoxWithDrawer.x + drawerBoxAfterResize.x) / 2,
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        pageBoxAfterResize.x +
          pageBoxAfterResize.width -
          drawerBoxAfterResize.x,
      ),
    ).toBeLessThanOrEqual(1);

    await window.screenshot({
      path: testInfo.outputPath('pipeline-chat-drawer-opened.png'),
    });

    // (2) Collapse: the drawer's edge control hides it. The page-header
    // toggle then becomes available to show it again.
    await collapse.click();
    await expect(drawer).toHaveCount(0);
    await expect(window.getByTestId('pipeline-chat-toggle')).toBeVisible();
    // Same app-region hazard as the collapse control: the list view scrolls
    // under the main shell's top-40px drag rect, so the show toggle keeps its
    // own no-drag hole.
    await expect(window.getByTestId('pipeline-chat-toggle')).toHaveCSS(
      '-webkit-app-region',
      'no-drag',
    );

    const pageBoxWithoutDrawer = await window
      .getByTestId('page-workflows-library')
      .boundingBox();
    expect(pageBoxWithoutDrawer).not.toBeNull();
    expect(
      Math.abs(
        pageBoxWithoutDrawer.x +
          pageBoxWithoutDrawer.width / 2 -
          (rootBoxWithDrawer.x + rootBoxWithDrawer.width / 2),
      ),
    ).toBeLessThanOrEqual(1);

    // (3) Persistence (hidden): leave the Pipelines page entirely (unmounts
    // PipelinesPage) and return so it remounts and re-reads preferences. The
    // drawer should stay hidden.
    await app.openMainPage();
    await app.openPipelinesPage();
    await expectDrawerStaysClosed(window);

    // (4) Re-show: toggling again brings the drawer back.
    await window.getByTestId('pipeline-chat-toggle').click();
    await expect(window.getByTestId('pipeline-chat-drawer')).toBeVisible();
    await expect(window.getByTestId('pipeline-chat-panel')).toBeVisible();

    // (5) Still empty: the saved "visible" only allows the drawer, so a
    // remount with no conversation starts closed behind the toggle again.
    await app.openMainPage();
    await app.openPipelinesPage();
    await expectDrawerStaysClosed(window);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('pipeline-editor chat drawer opens by default for an assistant that holds a conversation, and persists its toggle', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-chat-drawer-'),
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'pipeline-editor',
    worktreeId: 'pipeline-editor',
    providerType: 'claude',
    activeTabId: 'pipeline-drawer-history',
    tabs: [
      {
        id: 'pipeline-drawer-history',
        title: 'Earlier pipeline chat',
        model: 'sonnet',
        messages: [
          {
            id: 'pipeline-drawer-history-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Draft a nightly lint pipeline' }],
            timestamp: Date.parse('2026-04-10T12:00:00.000Z'),
          },
          {
            id: 'pipeline-drawer-history-2',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Drafted.' }],
            timestamp: Date.parse('2026-04-10T12:00:05.000Z'),
          },
        ],
      },
    ],
  });
  mkdirSync(path.join(userDataDir, 'app-workspaces'), { recursive: true });
  renameSync(
    path.join(userDataDir, 'workspaces', 'pipeline-editor'),
    path.join(userDataDir, 'app-workspaces', 'pipeline-editor'),
  );
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const drawer = window.getByTestId('pipeline-chat-drawer');
    const panel = window.getByTestId('pipeline-chat-panel');
    const toggle = window.getByTestId('pipeline-chat-toggle');

    // (1) Default-visible: the drawer opens without any interaction because
    // the assistant already holds a conversation.
    await app.openPipelinesPage();
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    await expect(
      panel.getByText('Draft a nightly lint pipeline'),
    ).toBeVisible();
    await expect(toggle).toHaveCount(0);

    // (2) Persistence (hidden): a collapse wins over the conversation default
    // after the page remounts and re-reads preferences.
    await window.getByTestId('pipeline-chat-collapse').click();
    await expect(drawer).toHaveCount(0);
    await app.openMainPage();
    await app.openPipelinesPage();
    await expectDrawerStaysClosed(window);

    // (3) Persistence (visible): showing it again survives a remount.
    await toggle.click();
    await expect(drawer).toBeVisible();
    await app.openMainPage();
    await app.openPipelinesPage();
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    await expect(panel).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('pipeline-chat-drawer-restored.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const providerType of ['claude', 'codex']) {
  test(`CAN-2835 pipeline ${providerType} preserves consecutive responses and restart`, async () => {
    test.setTimeout(240_000);
    await runSessionReuseFlow({ surface: 'pipeline', providerType });
  });
}

test('pipeline assistant ignores Escape from the adjacent editor', async () => {
  await registerScenario(DEFAULT_MOCK_BASE_URL, PIPELINE_ESCAPE_MARKER, {
    llm: {
      steps: [{ text: 'slow pipeline assistant turn', streamMs: 180_000 }],
    },
  });
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const panel = await openPipelineAssistant(app);
    const composer = panel.getByRole('textbox').first();
    await composer.fill(`[${PIPELINE_ESCAPE_MARKER}] start a slow turn`);
    await composer.press('Enter');

    const stopButton = panel.getByTestId('chat-stop-generation');
    await expect(stopButton).toBeVisible({ timeout: 30_000 });
    await window.evaluate(() => {
      const probe = document.createElement('button');
      probe.dataset.testid = 'pipeline-editor-focus-probe';
      document
        .querySelector('[data-testid="page-workflows-library"]')
        ?.append(probe);
      probe.focus();
    });
    await window.keyboard.press('Escape');
    await window.keyboard.press('Escape');

    await expect(stopButton).toBeVisible();
    await expect(stopButton).toHaveAccessibleName('Stop generation');
    await expect(stopButton).not.toHaveAttribute('data-cancel-armed', 'true');

    // Escape remains functional from inside the assistant itself.
    await composer.click();
    await window.keyboard.press('Escape');
    await window.keyboard.press('Escape');
    await expect(stopButton).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

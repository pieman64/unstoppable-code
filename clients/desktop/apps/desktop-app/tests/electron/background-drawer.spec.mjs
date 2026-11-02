// Background drawer consolidation: the composer's top drawer holds the
// worktree chat tip and then the chat's background work, on one surface with
// one divider between them (D11). The background drawer opens upward without
// moving the composer, caps its list, scrolls its grouped rows
// (D10), and Esc closes it.
//
// Deterministic and offline: backgroundDrawerScenario seeds ten pipeline
// runs (one waiting for input, one paused) and injects two background shells
// and one background agent through the E2E chat-event ingress.
// `freshOnboardingTips` keeps the worktree chat tip.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { expectDrawerSpinnerMotion } from './backgroundDrawer.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DRAWER_SCENARIO,
  seedBackgroundDrawerChat,
  startBackgroundDrawerWork,
} from './seeders/backgroundDrawerScenario.mjs';
import { injectPipelineExecutionEvent } from './seeders/injectPipelineExecutionEvent.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

const { worktreeId, chatId } = DRAWER_SCENARIO;

/** A run row's test id: the drawer keys runs by their receipts' dedupe key. */
function runRowId(executionId) {
  return `background-tray-run-canopy:pipeline_run:execution:${executionId}`;
}

/** The actual composer box, independent of the drawer's wrapper structure. */
function composerTop(drawer) {
  return drawer
    .page()
    .locator('[data-chat-composer-root] [data-composer-layout]')
    .last()
    .evaluate((element) => element.getBoundingClientRect().top);
}

function borderTopWidth(locator) {
  return locator.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).borderTopWidth),
  );
}

test('the composer drawer holds background work without the tip, and opens without moving the composer', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-background-drawer-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedBackgroundDrawerChat(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    freshOnboardingTips: true,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(worktreeId);
    const panel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await expect(panel).toBeVisible();
    await startBackgroundDrawerWork(electronApp);

    const drawer = panel.getByTestId('composer-work-drawer');
    const tip = drawer.getByTestId('chat-input-onboarding-tip');
    const tray = drawer;
    await expect(tray.getByTestId('composer-work-drawer-toggle')).toHaveText(
      /Running\s*15\s*Needs you\s*2/,
      { timeout: 60_000 },
    );

    await expect(
      tray.getByTestId('composer-work-drawer-toggle'),
    ).toHaveAccessibleName('Show work: Running 15, Needs you 2');

    // Existing history suppresses onboarding tips; the shared grouped section owns the drawer.
    await expect(tip).toHaveCount(0);
    const sections = drawer.locator('[data-composer-drawer-section]');
    await expect(sections).toHaveCount(1);
    expect(await borderTopWidth(sections.first())).toBe(0);

    // Opening grows the drawer upward: the composer stays where it is.
    const before = await composerTop(drawer);
    // Arm recording before the real click so no opening frame is missed while
    // Playwright waits for visibility or reads the list's layout.
    const recording = await drawer.evaluateHandle(() => {
      const composer = document.querySelector(
        '[data-chat-composer-root] [data-composer-layout]',
      );
      const positions = [];
      let frame;
      const sample = () => {
        positions.push(composer.getBoundingClientRect().top);
        frame = requestAnimationFrame(sample);
      };
      sample();
      return { positions, stop: () => cancelAnimationFrame(frame) };
    });
    try {
      await tray.getByTestId('composer-work-drawer-toggle').click();
      const openingPositions = await recording.evaluate(
        async ({ positions }) => {
          const started = performance.now();
          do {
            await new Promise((resolve) => requestAnimationFrame(resolve));
          } while (performance.now() - started < 250);
          return positions;
        },
      );
      expect(Math.min(...openingPositions)).toBeCloseTo(before, 0);
      expect(Math.max(...openingPositions)).toBeCloseTo(before, 0);
    } finally {
      await recording.evaluate(({ stop }) => stop());
      await recording.dispose();
    }
    const list = tray.getByTestId('composer-work-drawer-list');
    await expect(list).toBeVisible();
    expect(await composerTop(drawer)).toBeCloseTo(before, 0);

    // The list is capped and scrolls inside the drawer, with the groups in order.
    const { clientHeight, scrollHeight, cap } = await list.evaluate(
      (element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        // min(22rem, 45vh)
        cap: Math.min(
          16.75 *
            Number.parseFloat(
              getComputedStyle(document.documentElement).fontSize,
            ),
          window.innerHeight * 0.35,
        ),
      }),
    );
    expect(scrollHeight).toBeGreaterThan(clientHeight);
    expect(clientHeight).toBeLessThanOrEqual(cap + 1);
    expect(
      await list
        .locator('[data-work-group]')
        .evaluateAll((groups) =>
          groups.map((group) => group.getAttribute('data-work-group')),
        ),
    ).toEqual(['Needs you', 'Running']);
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    // Esc closes the list from a row action too, and hands focus back to
    // the toggle. While the list is open the drawer opts out of the
    // composer's cancel-turn shortcut.
    await expect(sections.first()).toHaveAttribute(
      'data-chat-cancel-shortcut-ignore',
      'true',
    );
    await list.evaluate((element) => {
      element.scrollTop = 0;
    });
    await tray.getByTestId(`${runRowId('bgd-plan-review')}-respond`).focus();
    await window.keyboard.press('Escape');
    expect(
      await list.evaluate(
        (element) => element.closest('[aria-hidden="true"]') !== null,
      ),
    ).toBe(true);
    await expect(tray.getByTestId('composer-work-drawer-toggle')).toBeFocused();
    await expect(sections.first()).not.toHaveAttribute(
      'data-chat-cancel-shortcut-ignore',
    );
    await expect(tip).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

async function openDrawerChat(viewportSize) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-background-drawer-inspect-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const states = seedBackgroundDrawerChat(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir, viewportSize });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(worktreeId);
  const panel = window
    .locator('[data-testid="panel-content-chat"]:visible')
    .first();
  await expect(panel).toBeVisible();
  await startBackgroundDrawerWork(electronApp);
  const tray = panel.getByTestId('composer-work-drawer');
  await expect(tray.getByTestId('composer-work-drawer-toggle')).toContainText(
    'Running',
    { timeout: 60_000 },
  );
  await tray.getByTestId('composer-work-drawer-toggle').click();
  return { electronApp, userDataDir, window, tray, states };
}

/** Whether `inner` sits wholly inside `outer`'s box (1px tolerance). */
async function within(inner, outer) {
  const a = await inner.boundingBox();
  const b = await outer.boundingBox();
  return (
    a !== null &&
    b !== null &&
    a.y >= b.y - 1 &&
    a.y + a.height <= b.y + b.height + 1
  );
}

test('a task row opens its inspector in place, one at a time, revealed inside the list', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window, tray } = await openDrawerChat();
  try {
    const list = tray.getByTestId('composer-work-drawer-list');
    const row = (title) =>
      tray.getByTestId('background-tray-row').filter({ hasText: title });
    const inspector = tray.getByTestId('background-tray-inspector');

    // A shell shows its command and output tail, and opens its output.
    await row('pnpm run dev').getByTestId('background-tray-row-toggle').click();
    await expect(inspector).toHaveCount(1);
    await expect(inspector).toContainText('$ pnpm run dev');
    await inspector.getByTestId('background-tray-inspector-open').click();
    const modal = window.getByTestId('bg-process-detail-modal');
    await expect(modal).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);

    // Opening another row closes the first.
    await row('Checkout copy review workflow')
      .getByTestId('background-tray-row-toggle')
      .click();
    await expect(inspector).toHaveCount(1);
    await expect(
      row('pnpm run dev').getByTestId('background-tray-inspector'),
    ).toHaveCount(0);

    // From the end of the list, opening a row scrolls the list, not the
    // page, so the row and its inspector show whole.
    await row('Checkout copy review workflow')
      .getByTestId('background-tray-row-toggle')
      .click();
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const pageScroll = await window.evaluate(
      () => document.scrollingElement?.scrollTop ?? 0,
    );
    await row('pnpm test src/checkout --watch')
      .getByTestId('background-tray-row-toggle')
      .click();
    await expect(inspector).toHaveCount(1);
    await expect.poll(() => within(inspector, list)).toBe(true);
    expect(
      await window.evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    ).toBe(pageScroll);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('on a short window an open inspector still fits inside the list', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, tray } = await openDrawerChat({
    width: 1200,
    height: 560,
  });
  try {
    const list = tray.getByTestId('composer-work-drawer-list');
    await tray
      .getByTestId('background-tray-row')
      .filter({ hasText: 'pnpm run dev' })
      .getByTestId('background-tray-row-toggle')
      .click();
    const inspector = tray.getByTestId('background-tray-inspector');
    await expect(inspector).toHaveCount(1);
    await expect.poll(() => within(inspector, list)).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('each background subagent is its own row: Stop one, open one, Stop all and View tree', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window, tray } = await openDrawerChat();
  try {
    // Record delegate stops instead of reaching a delegation runtime.
    await electronApp.evaluate(({ ipcMain }) => {
      globalThis.__backgroundDrawerStops = [];
      for (const channel of [
        'managed-delegation:stop',
        'managed-delegation:stop-all',
      ]) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (_event, request) => {
          globalThis.__backgroundDrawerStops.push({ channel, request });
          return { ok: true };
        });
      }
    });
    const agentRow = (title) =>
      tray.getByTestId('background-tray-agent').filter({ hasText: title });
    const { agent, delegates, codex } = DRAWER_SCENARIO;
    await expect(tray.getByTestId('background-tray-agent')).toHaveCount(4);
    // The Claude agent is listed once, as an agent, not again as a task.
    await expect(
      tray
        .getByTestId('background-tray-row')
        .filter({ hasText: agent.description }),
    ).toHaveCount(0);
    // Its own Stop for the Claude agent and each delegate; none for Codex.
    await expect(
      agentRow(agent.description).getByTestId('background-tray-agent-stop'),
    ).toBeVisible();
    await expect(
      agentRow(codex.description).getByTestId('background-tray-agent-stop'),
    ).toHaveCount(0);
    await expect(
      agentRow(codex.description).getByTestId('background-tray-row-open'),
    ).toBeVisible();
    await agentRow(codex.description)
      .getByTestId('background-tray-row-toggle')
      .click();
    await expect(
      agentRow(codex.description).getByTestId('background-tray-inspector-open'),
    ).toHaveCount(0);

    // Escape reaches the shared drawer from each real nested control.
    const toggle = tray.getByTestId('composer-work-drawer-toggle');
    for (const control of [
      tray.getByTestId('background-tray-row-stop').first(),
      agentRow(agent.description).getByTestId('background-tray-agent-stop'),
      agentRow(delegates[0].description).getByTestId(
        'background-tray-agent-stop',
      ),
      tray.getByTestId('background-tray-stop-all'),
      tray.getByTestId('background-tray-view-tree'),
    ]) {
      await control.focus();
      await control.press('Escape');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle).toBeFocused();
      await toggle.click();
    }

    // Stop one delegate.
    await agentRow(delegates[0].description)
      .getByTestId('background-tray-agent-stop')
      .click();
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.__backgroundDrawerStops),
      )
      .toEqual([
        {
          channel: 'managed-delegation:stop',
          request: expect.objectContaining({
            chatId: DRAWER_SCENARIO.chatId,
            delegationId: delegates[0].id,
          }),
        },
      ]);

    // Stop all background work is the cloud host's (CAN-5205); desktop
    // passes none, so its open header keeps Stop all delegates alone.
    await expect(tray.getByTestId('background-tray-stop-all-work')).toHaveCount(
      0,
    );
    await expect(tray).not.toContainText('Stop all background work');

    // Stop all asks first, in the open header.
    await tray.getByTestId('background-tray-stop-all').click();
    await expect(window.getByRole('dialog')).toContainText('Stop');
    await window.getByTestId('background-tray-stop-all-confirm').click();
    await expect
      .poll(async () =>
        (
          await electronApp.evaluate(() => globalThis.__backgroundDrawerStops)
        ).map((stop) => stop.channel),
      )
      .toEqual(['managed-delegation:stop', 'managed-delegation:stop-all']);

    // The inspector shows what the agent is doing and opens its chat.
    await agentRow(agent.description)
      .getByTestId('background-tray-row-toggle')
      .click();
    const inspector = agentRow(agent.description).getByTestId(
      'background-tray-inspector',
    );
    await expect(inspector).toContainText(agent.description);
    const time = await agentRow(agent.description)
      .getByTestId('background-tray-row-toggle')
      .locator(':scope > span')
      .last()
      .boundingBox();
    const actionTextRight = await inspector
      .getByTestId('background-tray-inspector-open')
      .evaluate((button) => {
        const range = document.createRange();
        range.selectNodeContents(button);
        return range.getBoundingClientRect().right;
      });
    expect(time).not.toBeNull();
    expect(
      Math.abs(actionTextRight - (time.x + time.width)),
    ).toBeLessThanOrEqual(1);

    await inspector.getByTestId('background-tray-inspector-open').click();
    await expect(window.getByTestId('subagent-chat-panel').first()).toBeVisible(
      { timeout: 30_000 },
    );

    // View tree opens the Subagents panel.
    await tray.getByTestId('background-tray-view-tree').click();
    await expect(window.getByTestId('subagents-panel').first()).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a run row shows its jobs; its inspector opens the run; Respond, Resume and Stop act on it; completed history stays', async () => {
  test.setTimeout(180_000);
  const { electronApp, userDataDir, window, tray, states } =
    await openDrawerChat();
  try {
    // Record Stop and Resume instead of reaching the executor.
    await electronApp.evaluate(({ ipcMain }) => {
      globalThis.__backgroundDrawerRunActions = [];
      for (const channel of [
        'pipelines:cancel-execution',
        'pipelines:resume',
      ]) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (_event, executionId) => {
          globalThis.__backgroundDrawerRunActions.push({
            channel,
            executionId,
          });
          return { success: true };
        });
      }
    });
    const runActions = () =>
      electronApp.evaluate(() => globalThis.__backgroundDrawerRunActions);
    const release = tray.getByTestId(runRowId('bgd-release'));
    await expectDrawerSpinnerMotion(window, release);
    const inspector = tray.getByTestId('background-tray-inspector');

    // The row draws the run's two jobs as dots; its inspector, the job list,
    // whose jobs open the run in its panel.
    await expect(
      release.locator(
        '[data-testid="dag-progress-dots"] [data-status-glyph-state]',
      ),
    ).toHaveCount(2);
    await release.getByTestId('background-tray-row-toggle').click();
    await expect(inspector.locator('[data-job-id]')).toHaveCount(2);
    await inspector.locator('[data-job-id]').first().click();
    await expect(
      window.getByTestId('panel-tab-panel-pipeline-bgd-release'),
    ).toBeVisible();

    // Respond opens the run waiting for input, where it is answered.
    await tray.getByTestId(`${runRowId('bgd-plan-review')}-respond`).click();
    await expect(
      window.getByTestId('panel-tab-panel-pipeline-bgd-plan-review'),
    ).toBeVisible();

    // Resume resumes the paused run.
    await tray.getByTestId(`${runRowId('bgd-deploy')}-resume`).click();
    await expect
      .poll(runActions)
      .toEqual([{ channel: 'pipelines:resume', executionId: 'bgd-deploy' }]);

    // Stop cancels a running run; completed history retains it.
    await tray.getByTestId(`${runRowId('bgd-release')}-stop`).click();
    await expect.poll(runActions).toContainEqual({
      channel: 'pipelines:cancel-execution',
      executionId: 'bgd-release',
    });
    const cancelled = { ...states['bgd-release'], status: 'cancelled' };
    // Stop is stubbed above. Persist its result too, so opening the run's
    // detail panel cannot reload the seeded running state over the event.
    writeJson(
      path.join(userDataDir, 'pipeline-executions', 'bgd-release.json'),
      cancelled,
    );
    await injectPipelineExecutionEvent(electronApp, {
      type: 'execution.cancelled',
      state: cancelled,
    });
    await tray.getByTestId('background-tray-completed').click();
    const finished = window.getByTestId('completed-work-dialog');
    const completedRow = finished.getByTestId(runRowId('bgd-release'));
    await expect(
      completedRow.locator('[data-status-glyph="cancelled"]'),
    ).toBeVisible();
    await completedRow.getByTestId('background-tray-row-toggle').click();
    await expect(
      completedRow.getByTestId(`${runRowId('bgd-release')}-dismiss`),
    ).toHaveCount(0);
    await expect(completedRow).toBeVisible();
    await completedRow.locator('button[data-job-id]').first().click();
    await expect(finished).toHaveCount(0);
    await expect(
      window.getByTestId('panel-tab-panel-pipeline-bgd-release'),
    ).toBeVisible();
    await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
    await tray.getByTestId('background-tray-completed').click();
    await completedRow.getByTestId('background-tray-row-open').click();
    await expect(finished).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-4954: real non-git Cowork file actions and deterministic tool lifecycle gates.
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { injectChatEvent, publishTurnLifecycle } from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  seedAgentEditViewer,
  seedPresentedAgentEdit,
  seedMovedAgentFile,
  registerAgentEditScenario,
  startAgentEditFromDesktop,
  EDIT_WORKSPACE,
  EDIT_ENTRY,
  EDIT_CHAT,
  FINDINGS_NAME,
  UPDATED_FINDINGS,
} from './file-viewer-agent-edit-fixture.mjs';

async function openChat(electronApp) {
  const page = await electronApp.firstWindow();
  const app = new CanopyAppDriver(page);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await page.getByTestId(`sidebar-work-entry-${EDIT_ENTRY}`).click();
  await expect(page.getByTestId('cowork-top-bar')).toBeVisible();
  return page;
}

test('an edit plus an absolute ShowFiles receipt keeps one updated chip', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4954-receipt-'));
  const { filename } = seedPresentedAgentEdit(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const page = await openChat(electronApp);
    const chip = page
      .getByTestId('turn-file-chip')
      .filter({ hasText: filename });
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute('data-file-change', 'updated');
    await expect(page.getByTestId('turn-files').last()).toContainText(
      'Updated in Deliverables',
    );
    await chip.getByTestId('turn-file-chip-open').press('Enter');
    await expect(page.getByTestId('file-viewer')).toContainText(
      'Eight participants',
    );
    await page.reload();
    await openChat(electronApp);
    await expect(chip).toHaveAttribute('data-file-change', 'updated');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('edit-only Cowork chips open current content and survive reload', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4954-chip-'));
  const { filePath } = seedAgentEditViewer(userDataDir);
  const marker = 'Canopy-CAN4954CLEAN';
  await registerAgentEditScenario(filePath, marker, 'Done.');
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const page = await openChat(electronApp);
    await electronApp.evaluate(({ shell }) => {
      globalThis.__can4954Reveals = [];
      shell.showItemInFolder = (file) => {
        globalThis.__can4954Reveals.push(file);
      };
    });
    const saved = page
      .locator('[data-testid="turn-file-chip"][data-file-change="created"]')
      .filter({ hasText: FINDINGS_NAME });
    await expect(saved).toContainText('Saved in Deliverables');
    await saved.getByTestId('turn-file-chip-open').click();
    const viewer = page.getByTestId('file-viewer');
    await expect(viewer).toContainText('Six participants');
    await startAgentEditFromDesktop(page, marker);
    const updated = page.locator(
      '[data-testid="turn-file-chip"][data-file-change="updated"]',
    );
    await expect(updated).toHaveCount(1, { timeout: 90_000 });
    await expect(updated).toContainText('Updated in Deliverables');
    await expect(page.getByTestId('turn-files').last()).toContainText(
      'Updated in Deliverables',
    );
    await expect(viewer).toContainText('Eight participants');
    await expect(saved).toContainText('Saved in Deliverables');
    // Close the viewer before reveal, proving reveal does not open one.
    await page
      .locator('[data-testid^="panel-tab-panel-file-"]')
      .click({ button: 'right' });
    await page.getByTestId('panel-tab-context-close').click();
    await expect(viewer).toHaveCount(0);
    await updated.getByTestId('turn-file-chip-reveal').press('Enter');
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__can4954Reveals))
      .toEqual([realpathSync(filePath)]);
    await expect(viewer).toHaveCount(0);
    await updated.getByTestId('turn-file-chip-open').press('Enter');
    await expect(viewer).toContainText('Eight participants');
    writeFileSync(filePath, UPDATED_FINDINGS + '\nLatest content\n');
    await updated.getByTestId('turn-file-chip-open').click();
    await expect(viewer).toContainText('Latest content');
    await page.reload();
    await openChat(electronApp);
    await expect(updated).toHaveCount(1);
    await expect(updated).toContainText('Updated in Deliverables');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const failed of [false, true]) {
  test(`Codex updates gate pending actions then settle ${failed ? 'failed' : 'ready'}`, async () => {
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4954-pending-'));
    const { filePath } = seedAgentEditViewer(userDataDir, 'codex');
    const { electronApp } = await launchCanopy({ userDataDir });
    const turnId = 'can4954-pending-user';
    const scope = {
      projectId: EDIT_WORKSPACE,
      worktreeId: EDIT_ENTRY,
      chatId: EDIT_CHAT,
      turnUserMessageId: turnId,
    };
    const send = (data) =>
      injectChatEvent(electronApp, {
        ...scope,
        providerType: 'codex',
        data: { ...data, canopy_turn_user_message_id: turnId },
      });
    try {
      const page = await openChat(electronApp);
      await expect(page.getByTestId('turn-files').first()).toBeVisible();
      const previousSummaries = await page.getByTestId('turn-files').count();
      await electronApp.evaluate(
        async (_, target) => globalThis.__CANOPY_E2E_HOLD_CHAT_TURN__(target),
        scope,
      );
      await send({
        type: 'canopy_user_prompt',
        original_text: 'Revise the document.',
      });
      await publishTurnLifecycle(electronApp, { ...scope, phase: 'start' });
      await send({
        type: 'codex',
        event: {
          type: 'turn.started',
          thread_id: 'can4954-thread',
          turn_id: 'can4954-turn',
        },
      });
      await send({
        type: 'codex',
        event: {
          type: 'item.completed',
          item: {
            id: 'can4954-presented',
            type: 'mcp_tool_call',
            server: 'canopy',
            tool: 'ShowFiles',
            arguments: {},
            status: 'completed',
            error: null,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    files: [
                      { path: filePath, absolutePath: filePath, ok: true },
                    ],
                  }),
                },
              ],
            },
          },
        },
      });
      const item = {
        id: 'can4954-update',
        type: 'file_change',
        changes: [{ kind: 'update', path: `outputs/${FINDINGS_NAME}` }],
        status: 'inProgress',
      };
      await send({ type: 'codex', event: { type: 'item.started', item } });
      const updated = page.locator(
        '[data-testid="turn-file-chip"][data-file-change="updated"]',
      );
      await expect(updated).toContainText('Updating…');
      await expect(
        page.getByTestId('turn-files').last().getByTestId('turn-file-chip'),
      ).toHaveCount(1);
      const open = updated.getByTestId('turn-file-chip-open');
      await expect(open).toHaveAttribute('aria-disabled', 'true');
      await expect(updated.getByTestId('turn-file-chip-reveal')).toHaveCount(0);
      await open.press('Enter');
      await expect(page.getByTestId('file-viewer')).toHaveCount(0);
      await expect(page.getByTestId('turn-files').last()).toContainText(
        'Updating…',
      );
      if (!failed) writeFileSync(filePath, UPDATED_FINDINGS);
      const completed = {
        type: 'codex',
        event: {
          type: 'item.completed',
          item: { ...item, status: failed ? 'failed' : 'completed' },
        },
      };
      await send(completed);
      await send(completed);
      if (failed) {
        await expect(updated).toHaveCount(0);
        await expect(page.getByTestId('turn-files')).toHaveCount(
          previousSummaries,
        );
      } else {
        await expect(updated).toHaveCount(1);
        await expect(open).toHaveAttribute('aria-disabled', 'false');
        await expect(page.getByTestId('turn-files').last()).toContainText(
          'Updated in Deliverables',
        );
      }
      await publishTurnLifecycle(electronApp, { ...scope, phase: 'end' });
      await send({ type: 'codex', event: { type: 'turn.completed' } });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('canonical moves preserve Saved provenance through native open and reload', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4954-move-'));
  const { filename } = seedMovedAgentFile(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const page = await openChat(electronApp);
    await expect(
      page.getByText('CAN4954-MOVE-DONE', { exact: true }),
    ).toBeVisible();
    const chips = page.getByTestId('turn-file-chip');
    await expect(chips).toHaveCount(1);
    await expect(chips).toContainText(filename);
    await expect(chips).toContainText('Saved in Deliverables');
    await chips.getByTestId('turn-file-chip-open').press('Enter');
    await expect(page.getByTestId('file-viewer')).toContainText(
      'Eight participants',
    );
    await page.reload();
    await page.getByTestId(`sidebar-work-entry-${EDIT_ENTRY}`).click();
    await expect(chips).toHaveCount(1);
    await expect(chips).toContainText('Saved in Deliverables');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('growing output lists keep the existing HTML browser and focus return', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-output-growth-'),
  );
  const { filePath } = seedAgentEditViewer(userDataDir, 'codex');
  const directory = path.dirname(filePath);
  const names = ['growing.html', 'second.md', 'third.md', 'fourth.md'];
  for (const name of names)
    writeFileSync(
      path.join(directory, name),
      name.endsWith('.html')
        ? '<!doctype html><title>Growing output</title><h1>Growing output</h1>'
        : '# Output\n',
    );
  const { electronApp } = await launchCanopy({ userDataDir });
  const turnId = 'growing-outputs-user';
  const scope = {
    projectId: EDIT_WORKSPACE,
    worktreeId: EDIT_ENTRY,
    chatId: EDIT_CHAT,
    turnUserMessageId: turnId,
  };
  const send = (data) =>
    injectChatEvent(electronApp, {
      ...scope,
      providerType: 'codex',
      data: { ...data, canopy_turn_user_message_id: turnId },
    });
  try {
    const page = await openChat(electronApp);
    await electronApp.evaluate(
      async (_, target) => globalThis.__CANOPY_E2E_HOLD_CHAT_TURN__(target),
      scope,
    );
    await send({
      type: 'canopy_user_prompt',
      original_text: 'Prepare the output files.',
    });
    await publishTurnLifecycle(electronApp, { ...scope, phase: 'start' });
    await send({
      type: 'codex',
      event: {
        type: 'turn.started',
        thread_id: 'growing-thread',
        turn_id: 'growing-turn',
      },
    });
    const summary = page.locator(
      `[data-testid="turn-files"][data-turn-id="${turnId}"]`,
    );
    const open = summary.getByRole('button', {
      name: 'Open growing.html',
      exact: true,
    });
    const browsers = page.locator('[role="tab"][data-panel-kind="browser"]');
    for (const [index, name] of names.entries()) {
      const outputPath = path.join(directory, name);
      await send({
        type: 'codex',
        event: {
          type: 'item.completed',
          item: {
            id: `growing-${index}`,
            type: 'mcp_tool_call',
            server: 'canopy',
            tool: 'ShowFiles',
            arguments: {},
            status: 'completed',
            error: null,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    files: [
                      { path: outputPath, absolutePath: outputPath, ok: true },
                    ],
                  }),
                },
              ],
            },
          },
        },
      });
      await expect(summary.getByTestId('turn-file-chip')).toHaveCount(
        index + 1,
      );
      await open.click();
      await expect(open).toHaveAttribute('aria-busy', 'false');
      await expect(browsers).toHaveCount(1);
    }
    await publishTurnLifecycle(electronApp, { ...scope, phase: 'end' });
    await send({ type: 'codex', event: { type: 'turn.completed' } });
    await browsers.hover();
    await browsers.getByRole('button', { name: /^Close / }).click();
    await expect(browsers).toHaveCount(0);
    await expect(open).toBeFocused();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

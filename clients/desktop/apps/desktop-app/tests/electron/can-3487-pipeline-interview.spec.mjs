// CAN-3487 — "New pipeline" is a split action.
//
// - The main button opens a new Cowork chat and immediately sends the
//   interview prompt, with no further click or send.
// - The manual builder is the Library's New workflow menu entry "When you
//   start it, built by hand" (`workflows-new` -> `workflows-new-build`,
//   CAN-3981).
//
// The send is intercepted at the `chat:send-message` IPC boundary so no live
// agent runs; the saved-pipeline half of the handoff (a Cowork chat creating
// and refining a pipeline through `pipeline.create` / `pipeline.update`) is
// covered by `apps/desktop-app/src/main/__tests__/cowork-agent-tools.test.ts`.
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const INTERVIEW_PROMPT_PREFIX = 'Interview me to help me build a pipeline';

test('the main New pipeline action starts the interview in a Cowork chat', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    await electronApp.evaluate(({ ipcMain }) => {
      globalThis.__pipelineInterviewSends = [];
      ipcMain.removeHandler('chat:send-message');
      ipcMain.handle('chat:send-message', (_event, request) => {
        globalThis.__pipelineInterviewSends.push(request);
        return new Promise((resolve) => {
          globalThis.__resolvePipelineInterviewSend = () => resolve({});
        });
      });
    });

    await app.openPipelinesPage();
    await app.startNewWorkflow('describe');

    // While the interview chat is being created, the menu no longer offers
    // to start another one.
    await window.getByTestId('workflows-new').first().click();
    await expect(window.getByTestId('workflows-new-build')).toBeVisible();
    await expect(window.getByTestId('workflows-new-describe')).toHaveCount(0);
    await window.keyboard.press('Escape');

    await expect
      .poll(() =>
        electronApp.evaluate(
          () => typeof globalThis.__resolvePipelineInterviewSend === 'function',
        ),
      )
      .toBe(true);
    await electronApp.evaluate(() => {
      globalThis.__resolvePipelineInterviewSend?.();
    });

    await expect(window.getByTestId('page-chat')).toBeVisible();
    await expect
      .poll(() =>
        electronApp.evaluate(() =>
          globalThis.__pipelineInterviewSends.map((request) => request.text),
        ),
      )
      .toEqual([expect.stringContaining(INTERVIEW_PROMPT_PREFIX)]);
  } finally {
    await electronApp.evaluate(() => {
      globalThis.__resolvePipelineInterviewSend?.();
    });
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Build manually in the New pipeline menu opens the builder', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPipelinesPage();

    const chevron = window.getByTestId('workflows-new').first();
    await expect(chevron).toHaveAttribute('aria-expanded', 'false');
    await chevron.click();
    await expect(chevron).toHaveAttribute('aria-expanded', 'true');

    const manual = window.getByTestId('workflows-new-build');
    await expect(manual).toContainText('When you start it, built by hand');
    await manual.click();

    await expect(window.getByTestId('pipeline-mode-raw')).toBeVisible();
    await expect(window.getByTestId('page-chat')).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

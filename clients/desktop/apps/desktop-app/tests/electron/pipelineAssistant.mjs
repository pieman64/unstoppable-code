import { expect } from '@playwright/test';

/**
 * Opens Workflows › Pipelines with the Pipeline Assistant drawer showing, and
 * returns the assistant panel. An empty assistant starts closed behind its
 * page-header toggle, and one that holds a conversation opens by itself once
 * its tabs load (CAN-3980), so this retries until either path lands.
 *
 * When the toggle is clicked the page records an explicit open and saves the
 * "visible" preference, as a user's click would. Specs that assert the
 * drawer's own default should use `openPipelinesPage` instead.
 *
 * @param {import('./canopyApp.mjs').CanopyAppDriver} app
 */
export async function openPipelineAssistant(app) {
  await app.openPipelinesPage();
  const panel = app.window.getByTestId('pipeline-chat-panel');
  const toggle = app.window.getByTestId('pipeline-chat-toggle');
  await expect(async () => {
    if (await panel.isVisible()) return;
    await toggle.click({ timeout: 2_000 });
    await expect(panel).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return panel;
}

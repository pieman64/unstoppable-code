import { expect } from '@playwright/test';
import { evaluateWithSyntheticIpcEvent } from './syntheticIpcEvent.mjs';
import {
  ENTRY_ID,
  WORKSPACE_ID,
  expandCoworkWorkspace,
  seedDeliveryCoworkWorkspace,
} from './coworkWorkEntryDoneFixture.mjs';

export { ENTRY_ID, WORKSPACE_ID };
export const CHAT_ID = 'chat-refunds';
export const FAILURE_MESSAGE = "Couldn't send your message. Try again.";
export const seedCoworkFailureToast = seedDeliveryCoworkWorkspace;

export async function showCoworkFailureToast(electronApp, window, app) {
  await app.waitForShell();
  await expandCoworkWorkspace(window, WORKSPACE_ID);
  await window.getByTestId(`sidebar-work-entry-${ENTRY_ID}`).click();
  const panel = window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
  );
  await expect(panel).toBeVisible();
  await evaluateWithSyntheticIpcEvent(
    electronApp,
    async ({ ipcMain }, { event, args: { projectId, worktreeId, chatId } }) => {
      const snapshot = await ipcMain._invokeHandlers.get('chat:get-state')(
        event,
        { projectId, worktreeId },
      );
      event.sender.send('chat:state-changed', {
        projectId,
        worktreeId,
        schemaVersion: 1,
        eventId: 'cowork-toast-streaming',
        occurredAt: new Date().toISOString(),
        baseRevision: snapshot.revision,
        revision: snapshot.revision + 1,
        changes: [
          {
            type: 'runtime.patched',
            chatId,
            runtime: { status: 'streaming', queuedMessageIds: [] },
          },
        ],
      });
      ipcMain.removeHandler('chat:send-message');
      ipcMain.handle('chat:send-message', async () => {
        throw new Error('Queued Work chat send rejected by test');
      });
    },
    { projectId: WORKSPACE_ID, worktreeId: ENTRY_ID, chatId: CHAT_ID },
  );
  await expect(panel.getByTestId('chat-stop-generation')).toBeVisible();
  const composer = panel.locator('[data-slate-editor="true"]').first();
  await composer.fill('Queued Work chat draft');
  await composer.press('Enter');
  const toast = window
    .getByTestId('toast-card')
    .filter({ hasText: FAILURE_MESSAGE });
  await expect(toast).toBeVisible();
  await app.openOverviewPage();
  await expect(window.getByTestId('overview-page')).toBeVisible();
  return toast;
}

/**
 * Hold main's `chat:model-change` for one model so a spec can act while the
 * picker already reads the new model but the switch has not committed.
 *
 * `model-selection-fixture.mjs` carries the same hold inside
 * `launchPendingModelFixture`; its bytes are pinned by the performance study
 * test, so this reusable form lives here instead of being exported from it.
 * Release the hold with that fixture's `releasePendingModel`, which owns the
 * `globalThis.__releasePendingModel` slot this hold fills.
 */

/**
 * Intercept `chat:model-change` in main. A change to `modelId` waits until
 * `releasePendingModel` runs; any other model passes straight through to the
 * real handler.
 */
export async function holdModelChange(electronApp, modelId) {
  await electronApp.evaluate(({ ipcMain }, heldModelId) => {
    const channel = 'chat:model-change';
    const original = ipcMain._invokeHandlers.get(channel);
    if (typeof original !== 'function') {
      throw new Error('Expected chat:model-change handler to be registered');
    }
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, request) => {
      if (request.model === heldModelId) {
        await new Promise((resolve) => {
          globalThis.__releasePendingModel = resolve;
        });
      }
      return original(event, request);
    });
  }, modelId);
}

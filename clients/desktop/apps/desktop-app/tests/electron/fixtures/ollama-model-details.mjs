import { closeCanopy, launchCanopy } from '../launchCanopy.mjs';
import { CanopyAppDriver } from '../canopyApp.mjs';

export const LONG_PARENT =
  '/Users/runner/.ollama/models/blobs/sha256-16a9369d0805f80b7377d25d87f937a90c05dc04ad79173a52001e42c9aab311';
export const LONG_FAMILY = 'unbrokenfamily'.repeat(20);

export async function openOllamaModelDetails() {
  const launched = await launchCanopy();
  try {
    await launched.electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ollama:get-state');
      ipcMain.handle('ollama:get-state', () => ({
        port: 11534,
        status: 'stopped',
        mode: 'managed',
        installation: {
          platform: 'darwin',
          ready: false,
          path: null,
          version: null,
          source: 'not-found',
          checkedAt: '2026-07-14T00:00:00.000Z',
          automaticInstallSupported: true,
        },
        models: [
          {
            id: 'ollama-long-details',
            rawModelId: 'long-details:latest',
            label: 'long-details',
            show: { capabilities: ['completion', 'tools'] },
            details: {
              family: 'qwen3',
              parameterSize: '8B',
              quantizationLevel: 'Q4_K_M',
              format: 'gguf',
              parentModel:
                '/Users/runner/.ollama/models/blobs/sha256-16a9369d0805f80b7377d25d87f937a90c05dc04ad79173a52001e42c9aab311',
              families: ['qwen3', 'unbrokenfamily'.repeat(20)],
            },
          },
        ],
      }));
    });
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();
    await app.openSettingsSection('ollama');
    // The model's shared Details disclosure: its root holds the toggle and,
    // once open, the facts.
    const details = window
      .getByTestId('ollama-model-list')
      .locator(
        '[data-testid^="ollama-model-details-"]:not([data-testid$="-toggle"]):not([data-testid$="-body"])',
      )
      .first();
    await details.locator('button[aria-expanded]').first().click();
    return { ...launched, window, details };
  } catch (error) {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    throw error;
  }
}

export async function resizeOllamaSettings(electronApp, width) {
  return electronApp.evaluate(({ BrowserWindow }, requestedWidth) => {
    const window = BrowserWindow.getAllWindows()[0];
    const [minimumWidth] = window.getMinimumSize();
    window.setSize(requestedWidth ?? minimumWidth, 900);
    return requestedWidth ?? minimumWidth;
  }, width);
}

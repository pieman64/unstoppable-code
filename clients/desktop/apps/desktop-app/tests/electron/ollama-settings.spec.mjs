import { expect, test } from '@playwright/test';
import {
  LONG_PARENT,
  LONG_FAMILY,
  openOllamaModelDetails,
  resizeOllamaSettings,
} from './fixtures/ollama-model-details.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('managed Ollama setup progresses from not installed to ready', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy({
    env: {
      CANOPY_E2E_OLLAMA_SETUP: 'managed-install',
    },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openMainPage();

    await app.openSettings();
    await app.openSettingsSection('ollama');

    await expect(window.getByTestId('ollama-managed-setup')).toContainText(
      "Ollama isn't installed",
    );
    await expect(window.getByTestId('ollama-browse')).toBeVisible();
    await expect(window.getByTestId('ollama-redetect')).toBeVisible();

    await window.getByTestId('ollama-install').click();
    await expect(window.getByTestId('ollama-install-progress')).toContainText(
      'Downloading Ollama',
    );
    await expect(window.getByRole('progressbar')).toBeVisible();
    await expect(window.getByTestId('ollama-mode-managed')).toBeDisabled();

    await expect(window.getByTestId('ollama-version')).toHaveText(
      'Ollama 0.14.1',
    );
    await expect(window.getByTestId('ollama-executable-path')).toHaveText(
      '/Applications/Ollama.app/Contents/Resources/ollama',
    );
    await expect(window.getByTestId('ollama-install')).toBeHidden();

    await window.screenshot({
      path: testInfo.outputPath('ollama-managed-setup-ready.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('expanded model details contain long paths and unbroken values at narrow and wide widths', async () => {
  const { electronApp, userDataDir, window, details } =
    await openOllamaModelDetails();
  try {
    for (const width of [undefined, 1400]) {
      const actualWidth = await resizeOllamaSettings(electronApp, width);
      await expect
        .poll(() => window.evaluate(() => window.outerWidth))
        .toBe(actualWidth);
      await expect(details).toBeVisible();
      for (const [label, value] of [
        ['Parent', LONG_PARENT],
        ['Families', `qwen3, ${LONG_FAMILY}`],
      ]) {
        const row = details.getByText(`${label}: ${value}`, { exact: true });
        await expect(row).toBeVisible();
        await expect(row).toHaveText(`${label}: ${value}`);
        const geometry = await row.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const grid = element.parentElement.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          return {
            overflow: element.scrollWidth - element.clientWidth,
            textContained: [...range.getClientRects()].every(
              (rect) =>
                rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1,
            ),
            insideGrid:
              bounds.left >= grid.left - 1 && bounds.right <= grid.right + 1,
          };
        });
        expect(geometry, `${label} at window width ${actualWidth}`).toEqual({
          overflow: 0,
          textContained: true,
          insideGrid: true,
        });
      }
      for (const text of [
        'Family: qwen3',
        'Parameters: 8B',
        'Quantization: Q4_K_M',
        'Format: gguf',
      ]) {
        const row = details.getByText(text, { exact: true });
        await expect(row).toBeVisible();
        expect(
          await row.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return new Set([...range.getClientRects()].map((rect) => rect.top))
              .size;
          }),
        ).toBe(1);
      }
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

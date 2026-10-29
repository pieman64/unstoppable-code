import { expect } from '@playwright/test';

/**
 * Sets the desktop "Interface scale" preference the way the app does it and
 * waits for the resulting uniform zoom to land in the renderer.
 *
 * The scale is a page zoom owned by the main process: persisting `uiScale`
 * makes main call `webContents.setZoomFactor(uiScale / 100)` on every window,
 * after which the renderer republishes the effective zoom as `--ui-zoom` (and
 * syncs `data-ui-scale`) from its `devicePixelRatio` watcher. Poking
 * `data-ui-scale` on <html> therefore does nothing on its own; specs that
 * need a scaled UI go through the preference, exactly like Settings → Display.
 *
 * Note that a zoom shrinks the CSS viewport (`window.innerWidth` = window
 * width / zoom), so layouts compress just as they would for a narrower
 * window.
 */
export async function setUiScale(window, scale) {
  await window.evaluate(
    (value) => window.api.savePreferences({ uiScale: value }),
    scale,
  );
  await expect
    .poll(
      () =>
        window.evaluate(() => ({
          uiZoom: getComputedStyle(document.documentElement)
            .getPropertyValue('--ui-zoom')
            .trim(),
          scale: document.documentElement.getAttribute('data-ui-scale'),
        })),
      { message: `interface scale ${scale}% did not land as a zoom` },
    )
    .toEqual({ uiZoom: String(scale / 100), scale: String(scale) });
}

/** The main window's live Electron zoom factor (1 = 100%). */
export function readMainWindowZoomFactor(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const [mainWindow] = BrowserWindow.getAllWindows();
    return mainWindow ? mainWindow.webContents.getZoomFactor() : null;
  });
}

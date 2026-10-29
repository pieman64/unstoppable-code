/**
 * Panel auxiliary-window main-process gate (Phase 8).
 *
 * Covers the pure decision surface of `panels/aux-window-service.ts`: the
 * narrow `setWindowOpenHandler` allow (about:blank + frame-name prefix +
 * source webContents gate, with the hardened override options) and the
 * child-navigation allowlist. The impure `hardenPanelAuxWindow` wiring is
 * exercised end-to-end by `tests/electron/worktree-panels-pull-out.spec.mjs`.
 */
import {
  makePanelAuxWindowFrameName,
  PANEL_AUX_WINDOW_FRAME_PREFIX,
} from '@canopy/protocol';
import {
  decidePanelAuxWindowOpen,
  hardenPanelAuxWindow,
  isAllowedPanelAuxNavigation,
} from '../panels/aux-window-service';
import type { BrowserWindow } from 'electron';

jest.mock('electron', () => ({
  screen: {
    getAllDisplays: jest.fn(() => []),
  },
  shell: {
    openExternal: jest.fn(),
  },
  app: {
    isPackaged: false,
  },
}));

describe('decidePanelAuxWindowOpen', () => {
  const allowedDetails = {
    url: 'about:blank',
    frameName: makePanelAuxWindowFrameName('aux-123'),
  };

  test('allows about:blank with the panel-aux frame-name prefix', () => {
    const decision = decidePanelAuxWindowOpen(allowedDetails);
    expect(decision).not.toBeNull();
    expect(decision?.action).toBe('allow');
  });

  test('the allow carries the hardened override options and no preload', () => {
    const decision = decidePanelAuxWindowOpen(allowedDetails);
    const options = decision?.overrideBrowserWindowOptions;
    expect(options).toBeDefined();
    const webPreferences = options?.webPreferences;
    expect(webPreferences).toBeDefined();
    expect(webPreferences?.contextIsolation).toBe(true);
    expect(webPreferences?.nodeIntegration).toBe(false);
    expect(webPreferences?.sandbox).toBe(false);
    // NO preload for the child document: it runs no app code of its own.
    expect(webPreferences && 'preload' in webPreferences).toBe(false);
  });

  test('the allow uses the compact hidden-title-bar chrome (renderer top bar replaces the OS title bar)', () => {
    const decision = decidePanelAuxWindowOpen(allowedDetails);
    const options = decision?.overrideBrowserWindowOptions;
    expect(options?.titleBarStyle).toBe('hidden');
    // Traffic lights are positioned to center within the renderer's 38px
    // custom top bar (AuxPanelWindow's drag-region header).
    expect(options?.trafficLightPosition).toEqual({ x: 15, y: 12 });
  });

  test('denies (null) any URL other than exactly about:blank', () => {
    for (const url of [
      'about:srcdoc',
      'about:blank#frag',
      'https://example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
      '',
    ]) {
      expect(
        decidePanelAuxWindowOpen({ url, frameName: allowedDetails.frameName }),
      ).toBeNull();
    }
  });

  test('denies (null) frame names without the panel-aux prefix', () => {
    for (const frameName of [
      '',
      'panel-spike',
      'canopy-panel-aux', // missing the trailing colon of the prefix
      ` ${PANEL_AUX_WINDOW_FRAME_PREFIX}aux-1`, // prefix must be at index 0
      '_blank',
    ]) {
      expect(
        decidePanelAuxWindowOpen({ url: 'about:blank', frameName }),
      ).toBeNull();
    }
  });

  test('creates the child at the opener UI zoom so its first paint matches', () => {
    const decision = decidePanelAuxWindowOpen(allowedDetails, 3, 3, {
      zoomFactor: 1.5,
    });
    expect(
      decision?.overrideBrowserWindowOptions?.webPreferences?.zoomFactor,
    ).toBe(1.5);
    // The minimum zooms with the UI so its CSS-px floor still fits.
    expect(decision?.overrideBrowserWindowOptions?.minWidth).toBe(600);
    expect(decision?.overrideBrowserWindowOptions?.minHeight).toBe(450);
    const unzoomed = decidePanelAuxWindowOpen(allowedDetails, 3, 3);
    expect(unzoomed?.overrideBrowserWindowOptions?.minWidth).toBe(400);
    expect(unzoomed?.overrideBrowserWindowOptions?.minHeight).toBe(300);
    // Without a known zoom the option is omitted rather than forced to 1.
    const unknown = decidePanelAuxWindowOpen(allowedDetails, 3, 3);
    expect(
      unknown?.overrideBrowserWindowOptions?.webPreferences &&
        'zoomFactor' in unknown.overrideBrowserWindowOptions.webPreferences,
    ).toBe(false);
  });

  test('denies (null) when the source webContents is not the main window', () => {
    expect(decidePanelAuxWindowOpen(allowedDetails, 7, 3)).toBeNull();
  });

  test('allows when the source webContents IS the main window', () => {
    expect(decidePanelAuxWindowOpen(allowedDetails, 3, 3)?.action).toBe(
      'allow',
    );
  });
});

describe('isAllowedPanelAuxNavigation', () => {
  test('allows only exactly about:blank', () => {
    expect(isAllowedPanelAuxNavigation('about:blank')).toBe(true);
    expect(isAllowedPanelAuxNavigation('about:blank#x')).toBe(false);
    expect(isAllowedPanelAuxNavigation('about:srcdoc')).toBe(false);
    expect(isAllowedPanelAuxNavigation('https://example.com')).toBe(false);
    expect(isAllowedPanelAuxNavigation('file:///tmp/x.html')).toBe(false);
    expect(isAllowedPanelAuxNavigation('')).toBe(false);
  });
});

describe('hardenPanelAuxWindow', () => {
  test('routes admitted web links through the app-link policy', () => {
    let windowOpenHandler:
      | ((details: { url: string }) => { action: 'deny' })
      | undefined;
    let willNavigateHandler:
      | ((event: { preventDefault: jest.Mock }, url: string) => void)
      | undefined;
    const routeAppLink = jest.fn().mockResolvedValue(undefined);
    const webContents = {
      setWindowOpenHandler: jest.fn(
        (handler: (details: { url: string }) => { action: 'deny' }) => {
          windowOpenHandler = handler;
        },
      ),
      on: jest.fn((event: string, handler: unknown) => {
        if (event === 'will-navigate') {
          willNavigateHandler = handler as typeof willNavigateHandler;
        }
      }),
    };
    const win = {
      getBounds: jest.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
      setBounds: jest.fn(),
      webContents,
    } as unknown as BrowserWindow;

    hardenPanelAuxWindow(win, { routeAppLink });
    expect(windowOpenHandler?.({ url: 'https://example.com/docs' })).toEqual({
      action: 'deny',
    });
    const preventDefault = jest.fn();
    willNavigateHandler?.(
      { preventDefault },
      'http://127.0.0.1:4173/from-chat',
    );

    expect(routeAppLink).toHaveBeenNthCalledWith(1, 'https://example.com/docs');
    expect(routeAppLink).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4173/from-chat',
    );
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });
});

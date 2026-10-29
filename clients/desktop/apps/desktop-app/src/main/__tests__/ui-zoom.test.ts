import { BrowserWindow, type Rectangle } from 'electron';
import {
  applyUiZoomToAllWindows,
  applyUiZoomToWindow,
  applySavedUiZoom,
  boundsSatisfyingMinimum,
  cssRectToWindowDips,
  registerUiZoomMinimumSize,
  registerUiZoomWindowButtons,
  scaledMinimumSize,
  uiScaleToZoomFactor,
  uiZoomWebPreferences,
  type ZoomableBrowserWindow,
} from '../lib/ui-zoom';

interface FakeWindow extends ZoomableBrowserWindow {
  setZoomFactor: jest.Mock<void, [number]>;
  setMinimumSize: jest.Mock<void, [number, number]>;
  setBounds: jest.Mock<void, [Partial<Rectangle>]>;
  setWindowButtonPosition: jest.Mock<void, [{ x: number; y: number }]>;
}

function fakeWindow(
  options: {
    destroyed?: boolean;
    webContentsDestroyed?: boolean;
    maximized?: boolean;
    fullScreen?: boolean;
    bounds?: Rectangle;
  } = {},
): FakeWindow {
  const setZoomFactor = jest.fn<void, [number]>();
  let bounds = options.bounds ?? { x: 100, y: 50, width: 1000, height: 700 };
  return {
    setZoomFactor,
    setMinimumSize: jest.fn<void, [number, number]>(),
    setWindowButtonPosition: jest.fn<void, [{ x: number; y: number }]>(),
    setBounds: jest.fn<void, [Partial<Rectangle>]>((next) => {
      bounds = { ...bounds, ...next };
    }),
    isDestroyed: (): boolean => options.destroyed ?? false,
    isMaximized: (): boolean => options.maximized ?? false,
    isFullScreen: (): boolean => options.fullScreen ?? false,
    getBounds: (): Rectangle => bounds,
    webContents: {
      isDestroyed: (): boolean => options.webContentsDestroyed ?? false,
      setZoomFactor,
    },
  };
}

describe('uiScaleToZoomFactor', () => {
  it('maps the percentage to a zoom factor', () => {
    expect(uiScaleToZoomFactor(100)).toBe(1);
    expect(uiScaleToZoomFactor(125)).toBe(1.25);
    expect(uiScaleToZoomFactor(150)).toBe(1.5);
    expect(uiScaleToZoomFactor(75)).toBe(0.75);
    expect(uiScaleToZoomFactor(200)).toBe(2);
    expect(uiScaleToZoomFactor(50)).toBe(0.5);
    expect(uiScaleToZoomFactor(200)).toBe(2);
  });

  it('clamps into the supported 50–200 range', () => {
    expect(uiScaleToZoomFactor(10)).toBe(0.5);
    expect(uiScaleToZoomFactor(400)).toBe(2);
  });

  it('falls back to 100% for missing or non-finite values', () => {
    expect(uiScaleToZoomFactor(undefined)).toBe(1);
    expect(uiScaleToZoomFactor(Number.NaN)).toBe(1);
    expect(uiScaleToZoomFactor(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('produces the webPreferences fragment for window construction', () => {
    expect(uiZoomWebPreferences(150)).toEqual({ zoomFactor: 1.5 });
    expect(uiZoomWebPreferences(undefined)).toEqual({ zoomFactor: 1 });
  });
});

describe('scaledMinimumSize', () => {
  it('keeps the 100% minimum in CSS px by scaling it with the zoom', () => {
    expect(scaledMinimumSize({ width: 800, height: 500 }, 1)).toEqual({
      width: 800,
      height: 500,
    });
    expect(scaledMinimumSize({ width: 800, height: 500 }, 1.5)).toEqual({
      width: 1200,
      height: 750,
    });
    expect(scaledMinimumSize({ width: 800, height: 500 }, 0.75)).toEqual({
      width: 600,
      height: 375,
    });
  });

  it('rounds up so the CSS minimum is never undershot', () => {
    expect(scaledMinimumSize({ width: 361, height: 421 }, 1.25)).toEqual({
      width: 452,
      height: 527,
    });
  });

  it('caps the minimum to the display work area', () => {
    expect(
      scaledMinimumSize({ width: 800, height: 500 }, 2, {
        width: 1440,
        height: 875,
      }),
    ).toEqual({ width: 1440, height: 875 });
  });
});

describe('boundsSatisfyingMinimum', () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };

  it('returns null when the bounds already fit the minimum', () => {
    expect(
      boundsSatisfyingMinimum(
        { x: 0, y: 25, width: 1400, height: 900 },
        { width: 1200, height: 750 },
        workArea,
      ),
    ).toBeNull();
  });

  it('grows in place when there is room', () => {
    expect(
      boundsSatisfyingMinimum(
        { x: 40, y: 60, width: 900, height: 600 },
        { width: 1200, height: 750 },
        workArea,
      ),
    ).toEqual({ x: 40, y: 60, width: 1200, height: 750 });
  });

  it('moves the window back inside the work area when growth would overflow it', () => {
    expect(
      boundsSatisfyingMinimum(
        { x: 600, y: 400, width: 800, height: 500 },
        { width: 1200, height: 750 },
        workArea,
      ),
    ).toEqual({ x: 240, y: 150, width: 1200, height: 750 });
  });
});

describe('cssRectToWindowDips', () => {
  it('is the identity at 100%', () => {
    expect(
      cssRectToWindowDips({ x: 280, y: 46, width: 600, height: 400 }, 1),
    ).toEqual({ x: 280, y: 46, width: 600, height: 400 });
  });

  it('scales CSS px by the zoom', () => {
    expect(
      cssRectToWindowDips({ x: 280, y: 46, width: 600, height: 400 }, 1.5),
    ).toEqual({ x: 420, y: 69, width: 900, height: 600 });
  });

  it('rounds edges so adjacent rectangles keep sharing an edge', () => {
    const left = cssRectToWindowDips(
      { x: 0, y: 0, width: 101, height: 1 },
      1.25,
    );
    const right = cssRectToWindowDips(
      { x: 101, y: 0, width: 101, height: 1 },
      1.25,
    );
    expect(left.x + left.width).toBe(right.x);
  });
});

describe('applySavedUiZoom', () => {
  it('applies the scale saved now, not one read earlier', async () => {
    const window = fakeWindow();
    await applySavedUiZoom(window, () => Promise.resolve(150));
    expect(window.setZoomFactor).toHaveBeenLastCalledWith(1.5);
  });

  it('falls back to 100% when the preferences cannot be read', async () => {
    const window = fakeWindow();
    await applySavedUiZoom(window, () => Promise.reject(new Error('locked')));
    expect(window.setZoomFactor).toHaveBeenLastCalledWith(1);
  });
});

describe('applyUiZoomToWindow', () => {
  it('sets the zoom factor on a live window', () => {
    const window = fakeWindow();

    applyUiZoomToWindow(window, 1.25);

    expect(window.setZoomFactor).toHaveBeenCalledWith(1.25);
  });

  it('skips destroyed windows and destroyed webContents', () => {
    const destroyed = fakeWindow({ destroyed: true });
    const gone = fakeWindow({ webContentsDestroyed: true });

    applyUiZoomToWindow(destroyed, 1.25);
    applyUiZoomToWindow(gone, 1.25);

    expect(destroyed.setZoomFactor).not.toHaveBeenCalled();
    expect(gone.setZoomFactor).not.toHaveBeenCalled();
  });

  it('leaves the minimum of an unregistered window alone', () => {
    const window = fakeWindow();

    applyUiZoomToWindow(window, 1.5);

    expect(window.setMinimumSize).not.toHaveBeenCalled();
    expect(window.setBounds).not.toHaveBeenCalled();
  });

  it('rescales a registered minimum and grows a window the zoom made too small', () => {
    // The mock display work area is 1920 x 1080 at the origin.
    const window = fakeWindow({
      bounds: { x: 100, y: 50, width: 1000, height: 700 },
    });
    registerUiZoomMinimumSize(window, { width: 800, height: 500 });

    applyUiZoomToWindow(window, 1.5);

    expect(window.setMinimumSize).toHaveBeenLastCalledWith(1200, 750);
    expect(window.setBounds).toHaveBeenLastCalledWith({
      x: 100,
      y: 50,
      width: 1200,
      height: 750,
    });

    // Zooming back out lowers the minimum without shrinking the window.
    window.setBounds.mockClear();
    applyUiZoomToWindow(window, 1);
    expect(window.setMinimumSize).toHaveBeenLastCalledWith(800, 500);
    expect(window.setBounds).not.toHaveBeenCalled();
  });

  it('never resizes a maximized or full-screen window', () => {
    const maximized = fakeWindow({ maximized: true });
    const fullScreen = fakeWindow({ fullScreen: true });
    registerUiZoomMinimumSize(maximized, { width: 800, height: 500 });
    registerUiZoomMinimumSize(fullScreen, { width: 800, height: 500 });

    applyUiZoomToWindow(maximized, 1.5);
    applyUiZoomToWindow(fullScreen, 1.5);

    expect(maximized.setMinimumSize).toHaveBeenCalledWith(1200, 750);
    expect(maximized.setBounds).not.toHaveBeenCalled();
    expect(fullScreen.setBounds).not.toHaveBeenCalled();
  });
});

describe('applyUiZoomToAllWindows', () => {
  it('fans the zoom and the scaled minimum out to every open window', () => {
    // The jest Electron mock's BrowserWindow carries a settable zoom factor.
    const first = new BrowserWindow();
    const second = new BrowserWindow();
    registerUiZoomMinimumSize(first, { width: 800, height: 500 });
    const getAllWindowsSpy = jest
      .spyOn(BrowserWindow, 'getAllWindows')
      .mockReturnValue([first, second]);

    try {
      applyUiZoomToAllWindows(1.5);
    } finally {
      getAllWindowsSpy.mockRestore();
    }

    expect(first.webContents.getZoomFactor()).toBe(1.5);
    expect(second.webContents.getZoomFactor()).toBe(1.5);
    expect(first.getMinimumSize()).toEqual([1200, 750]);
    expect(second.getMinimumSize()).toEqual([0, 0]);
  });
});

describe('registerUiZoomWindowButtons', () => {
  it('moves the traffic lights with the zoom once registered', () => {
    const window = fakeWindow();
    registerUiZoomWindowButtons(window, (zoomFactor) => ({
      x: 16,
      y: Math.round(10 * zoomFactor),
    }));
    applyUiZoomToWindow(window, 2);
    expect(window.setWindowButtonPosition).toHaveBeenLastCalledWith({
      x: 16,
      y: 20,
    });
  });

  it('leaves unregistered windows where they were created', () => {
    const window = fakeWindow();
    applyUiZoomToWindow(window, 2);
    expect(window.setWindowButtonPosition).not.toHaveBeenCalled();
  });
});

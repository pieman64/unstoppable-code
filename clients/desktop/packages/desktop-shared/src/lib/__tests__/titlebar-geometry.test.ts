import {
  APP_ADVISOR_TITLEBAR_ROW_HEIGHT_PX,
  appAdvisorWindowButtonPosition,
  MAC_WINDOW_BUTTON_HEIGHT_PX,
  macWindowButtonPosition,
  titlebarRowCenterAtZoomDip,
} from '../titlebar-geometry';

describe('macOS window buttons under the interface-scale zoom', () => {
  const SUPPORTED_ZOOMS = [0.5, 0.6, 0.75, 1, 1.25, 1.5, 1.65, 1.8, 2];

  it('keeps the created position at 100%', () => {
    expect(macWindowButtonPosition(1)).toEqual({ x: 16, y: 16 });
  });

  it.each(SUPPORTED_ZOOMS)(
    'centres the traffic lights on the titlebar row at %s zoom',
    (zoomFactor) => {
      const { y } = macWindowButtonPosition(zoomFactor);
      const lightsCenter = y + MAC_WINDOW_BUTTON_HEIGHT_PX / 2;
      // Positions are whole points, so the lights land within half a point.
      expect(
        Math.abs(lightsCenter - titlebarRowCenterAtZoomDip(zoomFactor)),
      ).toBeLessThanOrEqual(0.5);
    },
  );

  it('only moves the lights where the row can no longer reach them', () => {
    expect(
      SUPPORTED_ZOOMS.map((zoomFactor) => [
        zoomFactor,
        macWindowButtonPosition(zoomFactor).y,
      ]),
    ).toEqual([
      [0.5, 10],
      [0.6, 13],
      [0.75, 16],
      [1, 16],
      [1.25, 16],
      [1.5, 16],
      [1.65, 16],
      [1.8, 18],
      [2, 21],
    ]);
  });
});

describe('App Advisor window buttons under the interface-scale zoom', () => {
  const SUPPORTED_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

  it.each(SUPPORTED_ZOOMS)(
    'centres the traffic lights on the zooming header row at %s zoom',
    (zoomFactor) => {
      const { x, y } = appAdvisorWindowButtonPosition(zoomFactor);
      const rowCenter = (APP_ADVISOR_TITLEBAR_ROW_HEIGHT_PX / 2) * zoomFactor;
      expect(x).toBe(16);
      expect(
        Math.abs(y + MAC_WINDOW_BUTTON_HEIGHT_PX / 2 - rowCenter),
      ).toBeLessThanOrEqual(0.5);
    },
  );
});

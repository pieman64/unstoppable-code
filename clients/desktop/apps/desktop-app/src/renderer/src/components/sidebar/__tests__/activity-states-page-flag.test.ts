/** @jest-environment jsdom */
import { isActivityStatesPageEnabled } from '../activity-states-page-flag';

interface DevInfoWindow {
  devInfo?: { isDev: boolean };
}

const devInfoWindow: DevInfoWindow = window;

describe('isActivityStatesPageEnabled', () => {
  afterEach(() => {
    delete devInfoWindow.devInfo;
  });

  it('is enabled in an unpackaged development build', () => {
    devInfoWindow.devInfo = { isDev: true };
    expect(isActivityStatesPageEnabled()).toBe(true);
  });

  it('stays hidden in a packaged build', () => {
    devInfoWindow.devInfo = { isDev: false };
    expect(isActivityStatesPageEnabled()).toBe(false);
  });
});

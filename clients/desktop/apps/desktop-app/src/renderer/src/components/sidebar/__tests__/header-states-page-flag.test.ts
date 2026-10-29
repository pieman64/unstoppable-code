/**
 * @jest-environment jsdom
 */
import {
  HEADER_STATES_PAGE_STORAGE_KEY,
  isHeaderStatesPageEnabled,
} from '../header-states-page-flag';

interface DevInfoWindow {
  devInfo?: { isDev: boolean };
}

const devInfoWindow: DevInfoWindow = window;

describe('isHeaderStatesPageEnabled', () => {
  afterEach(() => {
    delete devInfoWindow.devInfo;
    window.localStorage.clear();
  });

  it('is disabled in dev builds without the opt-in flag', () => {
    devInfoWindow.devInfo = { isDev: true };
    expect(isHeaderStatesPageEnabled()).toBe(false);
  });

  it('is enabled in dev builds when the opt-in flag is set', () => {
    devInfoWindow.devInfo = { isDev: true };
    window.localStorage.setItem(HEADER_STATES_PAGE_STORAGE_KEY, '1');
    expect(isHeaderStatesPageEnabled()).toBe(true);
  });

  it('stays disabled outside dev builds even with the flag set', () => {
    // The packaged-build guarantee: no `devInfo.isDev`, so the stored opt-in
    // cannot surface the page for a user who happens to have the key set.
    window.localStorage.setItem(HEADER_STATES_PAGE_STORAGE_KEY, '1');
    expect(isHeaderStatesPageEnabled()).toBe(false);
  });
});

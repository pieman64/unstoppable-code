/**
 * @jest-environment jsdom
 */
import {
  HOME_BELOW_COMPOSER_GALLERY_STORAGE_KEY,
  isHomeBelowComposerGalleryEnabled,
} from '../home-below-composer-gallery-flag';

describe('isHomeBelowComposerGalleryEnabled', () => {
  const originalDevInfo = window.devInfo;

  afterEach(() => {
    window.devInfo = originalDevInfo;
    window.localStorage.removeItem(HOME_BELOW_COMPOSER_GALLERY_STORAGE_KEY);
  });

  it('stays off in dev builds until a developer opts in', () => {
    // An ordinary `npm run dev` must exercise the live Home sections, not the
    // fixture stack that replaces them.
    window.devInfo = { isDev: true, isPackaged: false, version: '0.0.0' };
    expect(isHomeBelowComposerGalleryEnabled()).toBe(false);
  });

  it('opts in when localStorage is 1', () => {
    window.devInfo = { isDev: true, isPackaged: false, version: '0.0.0' };
    window.localStorage.setItem(HOME_BELOW_COMPOSER_GALLERY_STORAGE_KEY, '1');
    expect(isHomeBelowComposerGalleryEnabled()).toBe(true);
  });

  it('stays off outside dev builds even when opted in', () => {
    window.devInfo = { isDev: false, isPackaged: true, version: '0.0.0' };
    window.localStorage.setItem(HOME_BELOW_COMPOSER_GALLERY_STORAGE_KEY, '1');
    expect(isHomeBelowComposerGalleryEnabled()).toBe(false);
  });
});

/**
 * @jest-environment jsdom
 */
import {
  createSidebarSectionRootRegistry,
  returnSidebarSectionToRoot,
  scrollSectionToTop,
} from '../sidebar-section-root';

describe('returnSidebarSectionToRoot', () => {
  it('re-click on root does not remount, resets tab and scroll', () => {
    const resetInPlace = jest.fn();
    const enterRoot = jest.fn();
    returnSidebarSectionToRoot({
      section: { atRoot: () => true, resetInPlace },
      enterRoot,
    });
    expect(resetInPlace).toHaveBeenCalledTimes(1);
    expect(enterRoot).not.toHaveBeenCalled();
  });

  it('enters the root fresh from a deeper page', () => {
    const resetInPlace = jest.fn();
    const enterRoot = jest.fn();
    returnSidebarSectionToRoot({
      section: { atRoot: () => false, resetInPlace },
      enterRoot,
    });
    expect(enterRoot).toHaveBeenCalledTimes(1);
    expect(resetInPlace).not.toHaveBeenCalled();
  });

  it('enters the root fresh when the section reports nothing', () => {
    const enterRoot = jest.fn();
    returnSidebarSectionToRoot({ section: undefined, enterRoot });
    expect(enterRoot).toHaveBeenCalledTimes(1);
  });
});

describe('createSidebarSectionRootRegistry', () => {
  it('holds the latest section until it unregisters', () => {
    const registry = createSidebarSectionRootRegistry();
    const first = { atRoot: (): boolean => true, resetInPlace: jest.fn() };
    const second = { atRoot: (): boolean => true, resetInPlace: jest.fn() };
    const releaseFirst = registry.register(first);
    const releaseSecond = registry.register(second);
    expect(registry.current()).toBe(second);
    // A late cleanup of an older section leaves the newer one in place.
    releaseFirst();
    expect(registry.current()).toBe(second);
    releaseSecond();
    expect(registry.current()).toBeUndefined();
  });
});

describe('scrollSectionToTop', () => {
  it('scrolls the element, its scrolled ancestors and descendants to the top', () => {
    const outer = document.createElement('div');
    const page = document.createElement('div');
    const list = document.createElement('div');
    outer.appendChild(page);
    page.appendChild(list);
    document.body.appendChild(outer);
    try {
      // jsdom does not lay out, so scrollTop only sticks once defined.
      for (const element of [outer, page, list]) {
        let top = 0;
        Object.defineProperty(element, 'scrollTop', {
          configurable: true,
          get: () => top,
          set: (value: number) => {
            top = value;
          },
        });
      }
      outer.scrollTop = 40;
      page.scrollTop = 30;
      list.scrollTop = 20;
      scrollSectionToTop(page);
      expect([outer.scrollTop, page.scrollTop, list.scrollTop]).toEqual([
        0, 0, 0,
      ]);
    } finally {
      outer.remove();
    }
  });

  it('ignores a missing element', () => {
    expect(() => scrollSectionToTop(null)).not.toThrow();
  });
});

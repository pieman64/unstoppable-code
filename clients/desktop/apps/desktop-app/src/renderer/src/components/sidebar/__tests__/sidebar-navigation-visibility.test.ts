/** @jest-environment jsdom */

import {
  isSidebarNavigationHidden,
  measureSidebarNavigationThreshold,
} from '../sidebar-navigation-visibility';

describe('sidebar navigation boundary', () => {
  it.each([
    [119.75, 120, false],
    [120, 120, true],
    [120.25, 120, true],
    [120.125, 120.125, true],
    [120, 120.125, false],
    [0, 0, false],
    [-1, 0, false],
    [1, 0, true],
    [100, null, false],
    [100, Number.NaN, false],
    [Number.NaN, 0, false],
  ])(
    'scroll %s, threshold %s => hidden %s',
    (scrollTop, threshold, expected) => {
      expect(isSidebarNavigationHidden(scrollTop, threshold)).toBe(expected);
    },
  );

  it('normalizes fractional normal-flow geometry, border and restored scroll to CSS content coordinates', () => {
    const viewport = document.createElement('div');
    const sentinel = document.createElement('div');
    sentinel.dataset.testid = 'sidebar-sticky-workspace-sentinel';
    viewport.appendChild(sentinel);
    viewport.scrollTop = 180.25;
    Object.defineProperty(viewport, 'clientTop', { value: 2 });
    jest
      .spyOn(viewport, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 50.5, 280, 560));
    jest
      .spyOn(sentinel, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, -7.625, 280, 1));
    // (-6.625 - 50.5 - 2) + 180.25 - the 1px sticky seat.
    expect(measureSidebarNavigationThreshold(viewport)).toBe(120.125);
  });

  it('accepts a measured zero threshold and omits roll-up without measurable surfaces', () => {
    const viewport = document.createElement('div');
    expect(measureSidebarNavigationThreshold(viewport)).toBeNull();
    const sentinel = document.createElement('div');
    sentinel.dataset.testid = 'sidebar-sticky-workspace-sentinel';
    viewport.appendChild(sentinel);
    expect(measureSidebarNavigationThreshold(viewport)).toBeNull();
    jest
      .spyOn(viewport, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 280, 560));
    jest
      .spyOn(sentinel, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 280, 1));
    expect(measureSidebarNavigationThreshold(viewport)).toBe(0);
    expect(isSidebarNavigationHidden(viewport.scrollTop, 0)).toBe(false);
  });
});

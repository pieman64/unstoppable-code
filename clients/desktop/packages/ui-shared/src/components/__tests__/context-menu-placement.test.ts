/**
 * Right-click menus at the pointer (desktop early access): top-left at the
 * pointer, flipping to the other side of the pointer on an axis where the
 * menu would not fit, and shifting only when neither side fits.
 */
import { placeContextMenuAtPoint } from '../context-menu-placement';

const VIEWPORT = { viewportWidth: 800, viewportHeight: 600 };
const MENU = { menuWidth: 180, menuHeight: 200 };

describe('placeContextMenuAtPoint', () => {
  it('opens below and to the right of the pointer', () => {
    expect(
      placeContextMenuAtPoint({ x: 60, y: 100, ...MENU, ...VIEWPORT }),
    ).toEqual({ left: 62, top: 102 });
  });

  it('flips above the pointer near the bottom, never covering it', () => {
    const { top } = placeContextMenuAtPoint({
      x: 60,
      y: 500,
      ...MENU,
      ...VIEWPORT,
    });
    // Bottom edge 2px above the pointer.
    expect(top).toBe(500 - 2 - 200);
  });

  it('flips left of the pointer near the right edge', () => {
    const { left } = placeContextMenuAtPoint({
      x: 700,
      y: 100,
      ...MENU,
      ...VIEWPORT,
    });
    expect(left).toBe(700 - 2 - 180);
  });

  it('shifts inside the viewport only when neither side fits', () => {
    const { top } = placeContextMenuAtPoint({
      x: 60,
      y: 300,
      menuWidth: 180,
      menuHeight: 500,
      ...VIEWPORT,
    });
    // 500px fits neither 298px above nor 290px below: pinned to the bottom
    // inset, fully on screen.
    expect(top).toBe(600 - 500 - 8);
  });
});

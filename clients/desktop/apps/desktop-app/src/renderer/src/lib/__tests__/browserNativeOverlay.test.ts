/**
 * @jest-environment jsdom
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { resolve } from 'node:path';
import {
  BROWSER_NATIVE_VIEW_AVAILABLE_ATTRIBUTE,
  BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE,
  BROWSER_NATIVE_VIEW_OVERLAY_LAYERS,
  hasBrowserNativeViewOverlay,
  subscribeBrowserOverlayTopology,
} from '../browserNativeOverlay';

describe('hasBrowserNativeViewOverlay', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  it('returns false when no blocking overlay is present', () => {
    const button = document.createElement('button');
    button.textContent = 'Regular button';
    document.body.appendChild(button);

    expect(hasBrowserNativeViewOverlay()).toBe(false);
  });

  it('detects modal dialogs and dropdown surfaces', () => {
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);

    expect(hasBrowserNativeViewOverlay()).toBe(true);

    modal.remove();

    const listbox = document.createElement('div');
    listbox.setAttribute('role', 'listbox');
    document.body.appendChild(listbox);

    expect(hasBrowserNativeViewOverlay()).toBe(true);

    listbox.remove();

    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);

    expect(hasBrowserNativeViewOverlay()).toBe(true);
  });

  it('detects explicitly marked popovers without semantic roles', () => {
    const popover = document.createElement('div');
    popover.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
    document.body.appendChild(popover);

    expect(hasBrowserNativeViewOverlay()).toBe(true);
  });

  it.each(BROWSER_NATIVE_VIEW_OVERLAY_LAYERS)(
    'detects an unmarked surface on the %s layer',
    (layer) => {
      // The CI checks popover: a plain floating box with no role or marker.
      const popover = document.createElement('div');
      popover.className = `fixed z-${layer}`;
      document.body.appendChild(popover);

      expect(hasBrowserNativeViewOverlay()).toBe(true);
    },
  );

  it('detects a surface that sets its layer through an inline z-index', () => {
    const popover = document.createElement('div');
    popover.setAttribute(
      'style',
      'position: fixed; z-index: var(--z-index-dropdown)',
    );
    document.body.appendChild(popover);

    expect(hasBrowserNativeViewOverlay()).toBe(true);
  });

  it('ignores the sticky layer and unlayered content', () => {
    const header = document.createElement('div');
    header.className = 'sticky top-0 z-sticky';
    document.body.appendChild(header);

    expect(hasBrowserNativeViewOverlay()).toBe(false);
  });

  it('covers every floating z-index layer the design system defines', () => {
    const tokens = readFileSync(
      resolve(
        __dirname,
        '../../../../../../../packages/ui-shared/src/styles/canopy-tokens-core.css',
      ),
      'utf8',
    );
    const layers = Array.from(
      tokens.matchAll(/--z-index-([a-z-]+):/g),
      (match) => match[1],
    ).filter((layer) => layer !== 'sticky');
    expect(layers.length).toBeGreaterThan(0);
    // A new floating layer must block the Browser view too.
    expect([...BROWSER_NATIVE_VIEW_OVERLAY_LAYERS].sort()).toEqual(
      layers.sort(),
    );
  });

  it('skips a surface that opts out, and one kept mounted but inert', () => {
    const optedOut = document.createElement('div');
    optedOut.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'false');
    const child = document.createElement('div');
    child.className = 'fixed z-tooltip';
    optedOut.appendChild(child);
    document.body.appendChild(optedOut);

    expect(hasBrowserNativeViewOverlay()).toBe(false);

    const closed = document.createElement('div');
    closed.className = 'fixed inset-0 z-modal';
    closed.setAttribute('inert', '');
    document.body.appendChild(closed);

    expect(hasBrowserNativeViewOverlay()).toBe(false);
  });

  it('lets the nearest marker decide: a "true" inside a "false" region counts', () => {
    // The notification corner: the container opts out (its own z-toast class
    // no longer counts), the banner wrapper inside it opts back in.
    const corner = document.createElement('div');
    corner.className = 'fixed z-toast';
    corner.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'false');
    document.body.appendChild(corner);

    expect(hasBrowserNativeViewOverlay()).toBe(false);

    const banners = document.createElement('div');
    banners.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
    corner.appendChild(banners);

    expect(hasBrowserNativeViewOverlay()).toBe(true);

    // A layered surface under the opted-in wrapper opts out again.
    banners.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'false');
    const nested = document.createElement('div');
    nested.className = 'fixed z-tooltip';
    banners.appendChild(nested);

    expect(hasBrowserNativeViewOverlay()).toBe(false);

    // Without its own marker, the nested layer inherits the corner's opt-out;
    // its own "true" opts it back in.
    banners.removeAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE);
    expect(hasBrowserNativeViewOverlay()).toBe(false);
    nested.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
    expect(hasBrowserNativeViewOverlay()).toBe(true);
  });

  it('keeps elements without a marker ancestor on the layer default', () => {
    const layered = document.createElement('div');
    layered.className = 'fixed z-dropdown';
    const marker = document.createElement('div');
    marker.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'false');
    document.body.append(layered, marker);

    expect(hasBrowserNativeViewOverlay()).toBe(true);
  });

  it('notifies topology listeners when a browser area becomes available', async () => {
    const area = document.createElement('div');
    area.setAttribute(BROWSER_NATIVE_VIEW_AVAILABLE_ATTRIBUTE, 'false');
    document.body.appendChild(area);
    const listener = jest.fn();
    const unsubscribe = subscribeBrowserOverlayTopology(listener);

    area.setAttribute(BROWSER_NATIVE_VIEW_AVAILABLE_ATTRIBUTE, 'true');
    await Promise.resolve();

    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('only detects overlays that intersect the target rect when provided', () => {
    const popover = document.createElement('div');
    popover.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
    document.body.appendChild(popover);

    const rectSpy = jest
      .spyOn(popover, 'getBoundingClientRect')
      .mockReturnValue({
        left: 150,
        top: 150,
        right: 200,
        bottom: 200,
        width: 50,
        height: 50,
        x: 150,
        y: 150,
        toJSON: () => ({}),
      } as DOMRect);

    expect(
      hasBrowserNativeViewOverlay(document, {
        left: 0,
        top: 0,
        right: 100,
        bottom: 100,
        width: 100,
        height: 100,
      }),
    ).toBe(false);

    rectSpy.mockReturnValue({
      left: 50,
      top: 50,
      right: 150,
      bottom: 150,
      width: 100,
      height: 100,
      x: 50,
      y: 50,
      toJSON: () => ({}),
    } as DOMRect);

    expect(
      hasBrowserNativeViewOverlay(document, {
        left: 0,
        top: 0,
        right: 100,
        bottom: 100,
        width: 100,
        height: 100,
      }),
    ).toBe(true);
  });

  it('blocks one pane or both panes according to independent intersections', () => {
    const overlay = document.createElement('div');
    overlay.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
    document.body.appendChild(overlay);
    const overlayRect = jest
      .spyOn(overlay, 'getBoundingClientRect')
      .mockReturnValue({
        left: 10,
        top: 10,
        right: 90,
        bottom: 90,
        width: 80,
        height: 80,
      } as DOMRect);
    const firstPane = {
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    };
    const secondPane = {
      left: 100,
      top: 0,
      right: 200,
      bottom: 100,
      width: 100,
      height: 100,
    };

    expect(hasBrowserNativeViewOverlay(document, firstPane)).toBe(true);
    expect(hasBrowserNativeViewOverlay(document, secondPane)).toBe(false);

    overlayRect.mockReturnValue({
      left: 50,
      top: 10,
      right: 150,
      bottom: 90,
      width: 100,
      height: 80,
    } as DOMRect);
    expect(hasBrowserNativeViewOverlay(document, firstPane)).toBe(true);
    expect(hasBrowserNativeViewOverlay(document, secondPane)).toBe(true);
  });

  it('ignores hidden overlay candidates', () => {
    const hiddenCandidate = document.createElement('div');
    hiddenCandidate.setAttribute('role', 'listbox');
    hiddenCandidate.style.display = 'none';
    document.body.appendChild(hiddenCandidate);

    const hiddenParent = document.createElement('div');
    hiddenParent.hidden = true;
    const childCandidate = document.createElement('div');
    childCandidate.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');
    hiddenParent.appendChild(childCandidate);
    document.body.appendChild(hiddenParent);

    expect(hasBrowserNativeViewOverlay()).toBe(false);
  });

  it('keeps the shared observer alive until the final pane unsubscribes', () => {
    const observe = jest.spyOn(MutationObserver.prototype, 'observe');
    const disconnect = jest.spyOn(MutationObserver.prototype, 'disconnect');

    const unsubscribeFirst = subscribeBrowserOverlayTopology(jest.fn());
    const unsubscribeSecond = subscribeBrowserOverlayTopology(jest.fn());

    expect(observe).toHaveBeenCalledTimes(1);
    unsubscribeFirst();
    expect(disconnect).not.toHaveBeenCalled();
    unsubscribeSecond();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

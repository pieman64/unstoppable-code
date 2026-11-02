/**
 * @jest-environment jsdom
 */
import type { OverlayLayerRect } from '@canopy/desktop-shared/types';
import {
  ABOVE_BROWSER_ATTRIBUTE,
  ABOVE_BROWSER_HOVER_ATTRIBUTE,
} from '@canopy/ui-shared/lib/above-browser';
import {
  BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE,
  hasBrowserNativeViewOverlay,
  setAboveBrowserMirrorActive,
} from '@/lib/browserNativeOverlay';
import {
  ABOVE_BROWSER_COPIED_ATTRIBUTE,
  AboveBrowserMirror,
} from '../aboveBrowserMirror';

interface FakeLayer {
  root: HTMLElement;
  setBounds: jest.Mock<Promise<void>, [OverlayLayerRect | null]>;
  isLost: () => boolean;
  onLost: (listener: () => void) => () => void;
}

let layer: FakeLayer | null = null;
let onLostHook: (listener: () => void) => () => void = () => (): void =>
  undefined;
let layerAvailable = true;
const openOverlayLayer = jest.fn((): FakeLayer | null => {
  if (!layerAvailable) return null;
  if (!layer) {
    const childDocument = document.implementation.createHTMLDocument('layer');
    const root = document.createElement('div');
    childDocument.body.appendChild(root);
    layer = {
      root,
      setBounds: jest
        .fn<Promise<void>, [OverlayLayerRect | null]>()
        .mockResolvedValue(undefined),
      isLost: (): boolean => false,
      onLost: (listener: () => void): (() => void) => onLostHook(listener),
    };
  }
  return layer;
});

jest.mock('@/lib/overlayLayer', () => ({
  isOverlayLayerAvailable: (): boolean => layerAvailable,
  openOverlayLayer: (): unknown => openOverlayLayer(),
}));

function place(element: HTMLElement, rect: DOMRect): void {
  element.getBoundingClientRect = (): DOMRect => rect;
}

/** A live page area at x 400-1000, y 100-700. */
function addPage(rect = new DOMRect(400, 100, 600, 600)): HTMLElement {
  const page = document.createElement('div');
  page.setAttribute('data-browser-native-view-available', 'true');
  place(page, rect);
  document.body.appendChild(page);
  return page;
}

function frame(): HTMLElement | null {
  return (
    layer?.root.querySelector<HTMLElement>(
      '[data-testid="above-browser-frame"]',
    ) ?? null
  );
}

let mirror: AboveBrowserMirror | null = null;

function startMirror(): AboveBrowserMirror {
  mirror = new AboveBrowserMirror(document);
  mirror.start();
  return mirror;
}

afterEach(() => {
  mirror?.dispose();
  mirror = null;
  layer = null;
  layerAvailable = true;
  onLostHook = (): (() => void) => (): void => undefined;
  openOverlayLayer.mockClear();
  document.body.innerHTML = '';
});

describe('AboveBrowserMirror', () => {
  it('copies a marked element over a page into the layer, cut to the page', () => {
    addPage();
    const layout = document.createElement('div');
    layout.setAttribute('data-window-layout', 'inset');
    const tip = document.createElement('span');
    tip.id = 'tip-1';
    tip.textContent = 'Reload';
    tip.style.position = 'fixed';
    tip.setAttribute(ABOVE_BROWSER_ATTRIBUTE, 'true');
    place(tip, new DOMRect(380, 80, 60, 26));
    layout.appendChild(tip);
    document.body.appendChild(layout);

    startMirror().evaluate();

    // The tip's reach (its box plus the shadow margin) cut to the page.
    expect(layer?.setBounds).toHaveBeenLastCalledWith({
      x: 400,
      y: 100,
      width: 72,
      height: 38,
    });
    const copy = frame()?.querySelector('span');
    expect(copy?.textContent).toBe('Reload');
    expect(copy?.id).toBe('');
    expect(copy?.getAttribute('aria-hidden')).toBe('true');
    // Ancestor rules still match the copy.
    expect(copy?.closest('[data-window-layout="inset"]')).not.toBeNull();
    // The frame stands where the main viewport is, relative to the layer.
    expect(frame()?.style.left).toBe('-400px');
    expect(frame()?.style.top).toBe('-100px');
  });

  it('opens no layer for a marked element away from every page', () => {
    addPage();
    const tip = document.createElement('span');
    tip.setAttribute(ABOVE_BROWSER_ATTRIBUTE, 'true');
    place(tip, new DOMRect(10, 10, 60, 26));
    document.body.appendChild(tip);

    startMirror().evaluate();

    expect(openOverlayLayer).not.toHaveBeenCalled();
  });

  it('copies a hover-mode handle only while it is active, then hides the layer', () => {
    addPage();
    const sash = document.createElement('div');
    sash.className = 'canopy-sash vertical';
    sash.setAttribute(ABOVE_BROWSER_ATTRIBUTE, 'hover');
    place(sash, new DOMRect(396, 300, 4, 200));
    document.body.appendChild(sash);
    const instance = startMirror();

    instance.evaluate();
    expect(openOverlayLayer).not.toHaveBeenCalled();

    sash.classList.add('active');
    instance.evaluate();
    const copy = frame()?.querySelector('.canopy-sash');
    expect(copy).not.toBeNull();
    // Not fixed: placed by its measured box.
    expect(copy instanceof HTMLElement && copy.style.left).toBe('396px');
    expect(copy?.hasAttribute(ABOVE_BROWSER_HOVER_ATTRIBUTE)).toBe(false);

    sash.classList.remove('active');
    instance.evaluate();
    expect(frame()?.querySelector('.canopy-sash')).toBeNull();
    expect(layer?.setBounds).toHaveBeenLastCalledWith(null);
  });

  it('draws a menu over a page until its freeze frame covers it', () => {
    const page = addPage();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.textContent = 'Archived chats';
    place(menu, new DOMRect(700, 60, 300, 200));
    document.body.appendChild(menu);
    const instance = startMirror();

    // Not covered (by the pane's own check): nothing to draw.
    instance.evaluate();
    expect(openOverlayLayer).not.toHaveBeenCalled();

    // Covered, and the frame is still being captured: the menu shows over
    // the live page.
    page.setAttribute('data-browser-native-view-covered', 'true');
    page.setAttribute('data-browser-native-view-frozen', 'false');
    instance.evaluate();
    expect(frame()?.querySelector('[role="menu"]')?.textContent).toBe(
      'Archived chats',
    );
    expect(menu.getAttribute(ABOVE_BROWSER_COPIED_ATTRIBUTE)).toBe('true');

    // The frame stands in for the page: the menu itself shows over it.
    page.setAttribute('data-browser-native-view-frozen', 'true');
    instance.evaluate();
    expect(frame()?.querySelector('[role="menu"]')).toBeNull();
    expect(menu.hasAttribute(ABOVE_BROWSER_COPIED_ATTRIBUTE)).toBe(false);
    expect(layer?.setBounds).toHaveBeenLastCalledWith(null);
  });

  it('never spans the app between two pages: it draws over the page with the most overlap', () => {
    addPage(new DOMRect(100, 100, 300, 600));
    addPage(new DOMRect(410, 100, 600, 600));
    const sash = document.createElement('div');
    sash.className = 'canopy-sash vertical active';
    sash.setAttribute(ABOVE_BROWSER_ATTRIBUTE, 'hover');
    // Closer to the right page: more of its reach lies over that one.
    place(sash, new DOMRect(404, 300, 4, 200));
    document.body.appendChild(sash);

    startMirror().evaluate();

    expect(layer?.setBounds.mock.calls.at(-1)?.[0]?.x).toBe(410);
  });

  it('resets the originals when the layer is lost', () => {
    addPage();
    const tip = document.createElement('span');
    tip.style.position = 'fixed';
    tip.setAttribute(ABOVE_BROWSER_ATTRIBUTE, 'true');
    place(tip, new DOMRect(380, 80, 60, 26));
    document.body.appendChild(tip);
    let lose: () => void = () => undefined;
    onLostHook = (listener): (() => void) => {
      lose = listener;
      return (): void => undefined;
    };

    startMirror().evaluate();
    expect(tip.getAttribute(ABOVE_BROWSER_COPIED_ATTRIBUTE)).toBe('true');
    lose();
    expect(tip.hasAttribute(ABOVE_BROWSER_COPIED_ATTRIBUTE)).toBe(false);
  });

  it('keeps a placed copy where it is when the original restyles', async () => {
    addPage();
    const sash = document.createElement('div');
    sash.className = 'canopy-sash vertical active';
    sash.setAttribute(ABOVE_BROWSER_ATTRIBUTE, 'hover');
    place(sash, new DOMRect(396, 300, 4, 200));
    document.body.appendChild(sash);
    startMirror().evaluate();

    sash.setAttribute('style', 'left: 12px; top: 0px; height: 100%;');
    await Promise.resolve();
    const copy = frame()?.querySelector<HTMLElement>('.canopy-sash');
    expect(copy?.style.left).toBe('396px');
    expect(copy?.style.top).toBe('300px');
  });

  it('updates ticking text on the copy in place, so its animations keep running', async () => {
    addPage();
    const card = document.createElement('div');
    card.setAttribute(ABOVE_BROWSER_ATTRIBUTE, 'true');
    card.innerHTML = '<span class="spinner"></span><span>Working… 1s</span>';
    place(card, new DOMRect(500, 200, 280, 120));
    document.body.appendChild(card);
    const tracked = startMirror();
    tracked.evaluate();
    const copy = frame()?.querySelector('.spinner')?.parentElement;
    expect(copy?.textContent).toBe('Working… 1s');

    const elapsed = card.lastChild?.firstChild;
    if (!elapsed) throw new Error('No elapsed text');
    elapsed.nodeValue = 'Working… 2s';
    await Promise.resolve();
    tracked.evaluate();

    const after = frame()?.querySelector('.spinner')?.parentElement;
    expect(after).toBe(copy);
    expect(after?.textContent).toBe('Working… 2s');
  });

  it('copies the original again when its children change', async () => {
    addPage();
    const card = document.createElement('div');
    card.setAttribute(ABOVE_BROWSER_ATTRIBUTE, 'true');
    card.innerHTML = '<span>One</span>';
    place(card, new DOMRect(500, 200, 280, 120));
    document.body.appendChild(card);
    const tracked = startMirror();
    tracked.evaluate();
    const copy = frame()?.querySelector('span')?.parentElement;

    card.appendChild(document.createElement('b')).textContent = 'Two';
    await Promise.resolve();
    tracked.evaluate();

    const after = frame()?.querySelector('span')?.parentElement;
    expect(after).not.toBe(copy);
    expect(after?.textContent).toBe('OneTwo');
  });

  it('counts marked elements as overlays again once disposed', () => {
    const tip = document.createElement('span');
    tip.className = 'z-tooltip';
    tip.setAttribute(ABOVE_BROWSER_ATTRIBUTE, 'true');
    document.body.appendChild(tip);
    const instance = startMirror();
    expect(hasBrowserNativeViewOverlay(document)).toBe(false);
    instance.dispose();
    mirror = null;
    expect(hasBrowserNativeViewOverlay(document)).toBe(true);
  });

  it("copies a handle while it carries its own delayed 'hover' class", () => {
    addPage();
    const sash = document.createElement('div');
    sash.className = 'canopy-sash vertical hover';
    sash.setAttribute(ABOVE_BROWSER_ATTRIBUTE, 'hover');
    place(sash, new DOMRect(396, 300, 4, 200));
    document.body.appendChild(sash);

    startMirror().evaluate();

    expect(frame()?.querySelector('.canopy-sash')).not.toBeNull();
  });

  it('draws over the live page, not a frozen one, and lets a marked tip freeze the other page', () => {
    const left = addPage(new DOMRect(100, 100, 300, 600));
    left.setAttribute('data-browser-native-view-frozen', 'true');
    const right = addPage(new DOMRect(410, 100, 600, 600));
    const tip = document.createElement('span');
    tip.style.position = 'fixed';
    tip.className = 'z-tooltip';
    tip.setAttribute(ABOVE_BROWSER_ATTRIBUTE, 'true');
    // Mostly over the frozen left page, partly over the live right one.
    place(tip, new DOMRect(300, 200, 130, 26));
    document.body.appendChild(tip);

    startMirror().evaluate();

    expect(layer?.setBounds.mock.calls.at(-1)?.[0]?.x).toBe(410);
    // Drawn over the right page; the left one is frozen by it as usual.
    expect(
      hasBrowserNativeViewOverlay(document, right.getBoundingClientRect()),
    ).toBe(false);
    expect(
      hasBrowserNativeViewOverlay(document, left.getBoundingClientRect()),
    ).toBe(true);
  });

  it('lets marked elements skip the freeze frame only while it can draw them', () => {
    const tip = document.createElement('span');
    tip.className = 'z-tooltip';
    tip.setAttribute(ABOVE_BROWSER_ATTRIBUTE, 'true');
    document.body.appendChild(tip);
    const menu = document.createElement('div');
    menu.setAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true');

    startMirror();
    expect(hasBrowserNativeViewOverlay(document)).toBe(false);
    document.body.appendChild(menu);
    expect(hasBrowserNativeViewOverlay(document)).toBe(true);
    menu.remove();

    // No layer on this page: the tip freezes the page like any overlay.
    layerAvailable = false;
    addPage();
    place(tip, new DOMRect(380, 80, 60, 26));
    mirror?.evaluate();
    expect(hasBrowserNativeViewOverlay(document)).toBe(true);
    setAboveBrowserMirrorActive(false);
  });

  it('plays a running animation of the original on its copy, once', () => {
    addPage();
    const card = document.createElement('div');
    card.textContent = 'Docs';
    card.style.position = 'fixed';
    card.setAttribute(ABOVE_BROWSER_ATTRIBUTE, 'true');
    place(card, new DOMRect(420, 120, 280, 200));
    document.body.appendChild(card);
    // jsdom has no Web Animations: the original reports a running slide
    // 40ms in, and every element can be animated.
    const keyframes = [{ translate: '-90px 0px' }, { translate: '0 0' }];
    class FakeKeyframeEffect {
      getKeyframes(): Keyframe[] {
        return keyframes;
      }
      getTiming(): EffectTiming {
        return { duration: 120, easing: 'ease-out', delay: 0, fill: 'auto' };
      }
    }
    Object.defineProperty(window, 'KeyframeEffect', {
      configurable: true,
      value: FakeKeyframeEffect,
    });
    const running = {
      playState: 'running',
      currentTime: 40,
      effect: new FakeKeyframeEffect(),
      finished: new Promise<void>(() => undefined),
    };
    card.getAnimations = (): Animation[] => [running as unknown as Animation];
    const replayed = { currentTime: null as number | null };
    const animate = jest.fn(() => replayed);
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    });
    try {
      const started = startMirror();
      started.evaluate();
      expect(animate).toHaveBeenCalledTimes(1);
      const target: unknown = animate.mock.contexts[0];
      expect(target).not.toBe(card);
      expect(target instanceof HTMLElement && target.textContent).toBe('Docs');
      expect(animate).toHaveBeenCalledWith(keyframes, {
        duration: 120,
        easing: 'ease-out',
        delay: 0,
        fill: 'auto',
      });
      expect(replayed.currentTime).toBe(40);
      // A later evaluation does not start it again.
      started.evaluate();
      expect(animate).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'animate');
      Reflect.deleteProperty(window, 'KeyframeEffect');
    }
  });

  it('sizes the layer to a sliding overlay’s whole path, then to where it lands', () => {
    addPage();
    const card = document.createElement('div');
    card.textContent = 'Docs';
    card.style.position = 'fixed';
    card.setAttribute(ABOVE_BROWSER_ATTRIBUTE, 'true');
    // Mid-slide the card still shows near its start (x 420); its layout box,
    // where the slide lands, is at x 720.
    place(card, new DOMRect(420, 120, 280, 200));
    for (const [name, value] of [
      ['offsetLeft', 720],
      ['offsetTop', 120],
      ['offsetWidth', 280],
      ['offsetHeight', 200],
    ] as const) {
      Object.defineProperty(card, name, { configurable: true, value });
    }
    let finish: () => void = () => undefined;
    const running = {
      playState: 'running',
      currentTime: 40,
      effect: null,
      finished: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    card.getAnimations = (): Animation[] => [running as unknown as Animation];
    document.body.appendChild(card);

    const started = startMirror();
    started.evaluate();
    // From the start's left reach to the page's right edge (the landing
    // spot's reach runs past it).
    expect(layer?.setBounds).toHaveBeenLastCalledWith({
      x: 400,
      y: 100,
      width: 600,
      height: 252,
    });

    // Landed: the layer shrinks to the card's final box.
    card.getAnimations = (): Animation[] => [];
    place(card, new DOMRect(720, 120, 280, 200));
    finish();
    started.evaluate();
    expect(layer?.setBounds).toHaveBeenLastCalledWith({
      x: 688,
      y: 100,
      width: 312,
      height: 252,
    });
  });
});

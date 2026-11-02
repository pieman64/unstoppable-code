import { decodeLayoutZoom } from '../cdp-decode';
import type { BrowserPageModel } from '../model-types';
import { buildPageModel } from '../page-model';
import {
  loadRecording,
  recordedDeps,
  type Recording,
} from './fixtures/recorded-cdp';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scaleFields(
  record: Record<string, unknown>,
  keys: readonly string[],
  zoom: number,
): void {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number') record[key] = value * zoom;
  }
}

/** Scales every number of a CDP list of `[x, y, width, height]` rows. */
function scaleRectangles(value: unknown, zoom: number): void {
  if (!Array.isArray(value)) return;
  for (const row of value) {
    if (!Array.isArray(row)) continue;
    const entries: unknown[] = row;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (typeof entry === 'number') entries[index] = entry * zoom;
    }
  }
}

/**
 * The recording as Chromium reports the same page at a device scale factor
 * of `zoom` (checked against headless Chromium run with
 * `--force-device-scale-factor=2`): DOMSnapshot layout and text-box bounds,
 * document scroll offsets and content sizes, and the deprecated
 * `layoutViewport`, `visualViewport` and `contentSize` metrics are in layout
 * units. Client and offset rects, computed styles, `DOM.getBoxModel` and the
 * `css*` metrics stay in CSS pixels.
 */
function atDeviceScale(recording: Recording, zoom: number): Recording {
  const scaled = structuredClone(recording);
  for (const entry of scaled.responses) {
    const response = entry.response;
    if (!isRecord(response)) continue;
    if (
      entry.method === 'DOMSnapshot.captureSnapshot' &&
      Array.isArray(response.documents)
    ) {
      for (const document of response.documents) {
        if (!isRecord(document)) continue;
        scaleFields(
          document,
          ['scrollOffsetX', 'scrollOffsetY', 'contentWidth', 'contentHeight'],
          zoom,
        );
        if (isRecord(document.layout)) {
          scaleRectangles(document.layout.bounds, zoom);
        }
        if (isRecord(document.textBoxes)) {
          scaleRectangles(document.textBoxes.bounds, zoom);
        }
      }
    } else if (entry.method === 'Page.getLayoutMetrics') {
      for (const key of ['layoutViewport', 'visualViewport', 'contentSize']) {
        const metric = response[key];
        if (!isRecord(metric)) continue;
        scaleFields(
          metric,
          [
            'pageX',
            'pageY',
            'offsetX',
            'offsetY',
            'clientWidth',
            'clientHeight',
            'x',
            'y',
            'width',
            'height',
          ],
          zoom,
        );
      }
    }
  }
  return scaled;
}

/** The recording with a shorter root viewport, in CSS (= layout) pixels. */
function withRootViewportHeight(
  recording: Recording,
  height: number,
): Recording {
  const edited = structuredClone(recording);
  for (const entry of edited.responses) {
    if (entry.method !== 'Page.getLayoutMetrics' || entry.sessionId !== '') {
      continue;
    }
    const response = entry.response;
    if (!isRecord(response)) continue;
    for (const key of ['layoutViewport', 'cssLayoutViewport']) {
      const viewport = response[key];
      if (isRecord(viewport)) viewport.clientHeight = height;
    }
  }
  return edited;
}

function coverage(model: BrowserPageModel): Array<[string, string, string]> {
  return model.coverage.map((entry) => [
    entry.url,
    entry.status,
    entry.reason ?? '',
  ]);
}

function geometry(model: BrowserPageModel): number[] {
  return model.nodes.flatMap((node) => [
    node.bounds.x,
    node.bounds.y,
    node.bounds.width,
    node.bounds.height,
    node.frameLocalBounds.x,
    node.frameLocalBounds.y,
    node.frameLocalBounds.width,
    node.frameLocalBounds.height,
  ]);
}

describe('page model at a device scale factor above 1', () => {
  it.each([
    ['oopif', 2],
    ['transforms', 2],
    ['frames', 2],
    ['oopif', 1.25],
    ['transforms', 1.5],
  ])(
    '%s at %f models the same frames and CSS-pixel geometry as at 1',
    async (name, zoom) => {
      const recording = loadRecording(name);
      const reference = await buildPageModel(recordedDeps(recording));
      const scaled = await buildPageModel(
        recordedDeps(atDeviceScale(recording, zoom)),
      );
      expect(coverage(scaled)).toEqual(coverage(reference));
      expect(scaled.page.viewport).toEqual(reference.page.viewport);
      expect(scaled.nodes.map((node) => node.inViewport)).toEqual(
        reference.nodes.map((node) => node.inViewport),
      );
      const expected = geometry(reference);
      const actual = geometry(scaled);
      expect(actual).toHaveLength(expected.length);
      const drift = actual.map((value, index) =>
        Math.abs(value - (expected[index] ?? NaN)),
      );
      expect(Math.max(0, ...drift)).toBeLessThan(1e-6);
    },
  );

  it('keeps a cross-site frame near the viewport bottom at device scale factor 2 (H009)', async () => {
    const recording = loadRecording('oopif');
    const reference = await buildPageModel(recordedDeps(recording));
    const owner = reference.nodes.find(
      (node) => node.attributes.id === 'visible-frame',
    );
    if (!owner) throw new Error('Missing #visible-frame');
    // Only the frame's top 20 CSS px are on screen, as on CI's frames page.
    const bottomEdge = withRootViewportHeight(recording, owner.bounds.y + 20);
    const visibleFrame = (model: BrowserPageModel): unknown =>
      model.coverage.find((entry) => entry.url.endsWith('/oopif-child.html'));
    const atOne = await buildPageModel(recordedDeps(bottomEdge));
    expect(visibleFrame(atOne)).toMatchObject({ status: 'included' });
    const atTwo = await buildPageModel(
      recordedDeps(atDeviceScale(bottomEdge, 2)),
    );
    expect(visibleFrame(atTwo)).toMatchObject({ status: 'included' });
    expect(coverage(atTwo)).toEqual(coverage(atOne));
  });
});

describe('decodeLayoutZoom', () => {
  const metrics = (layout: number, css: number): Record<string, unknown> => ({
    layoutViewport: { clientWidth: 800 * layout, clientHeight: 600 * layout },
    contentSize: { x: 0, y: 0, width: 800 * layout, height: 3000 * layout },
    cssLayoutViewport: { clientWidth: 800 * css, clientHeight: 600 * css },
    cssContentSize: { x: 0, y: 0, width: 800 * css, height: 3000 * css },
  });

  it('reads layout units per CSS pixel from the deprecated metrics', () => {
    expect(decodeLayoutZoom(metrics(1, 1))).toBe(1);
    expect(decodeLayoutZoom(metrics(2, 1))).toBe(2);
    // Chromium at --force-device-scale-factor=1.1.
    expect(
      decodeLayoutZoom({
        layoutViewport: { clientWidth: 880, clientHeight: 660 },
        contentSize: { width: 880, height: 3300 },
        cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
        cssContentSize: { width: 800, height: 3000 },
      }),
    ).toBeCloseTo(1.1, 9);
  });

  it('uses the largest pair, as whole layout units round small sizes', () => {
    expect(
      decodeLayoutZoom({
        layoutViewport: { clientWidth: 3, clientHeight: 3 },
        cssLayoutViewport: { clientWidth: 2, clientHeight: 2 },
        contentSize: { width: 1250, height: 500 },
        cssContentSize: { width: 1000, height: 400 },
      }),
    ).toBe(1.25);
  });

  it('is undefined without a usable layout and CSS pair', () => {
    expect(decodeLayoutZoom(undefined)).toBeUndefined();
    expect(
      decodeLayoutZoom({
        cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
      }),
    ).toBeUndefined();
    expect(
      decodeLayoutZoom({
        layoutViewport: { clientWidth: 0, clientHeight: 0 },
        cssLayoutViewport: { clientWidth: 0, clientHeight: 0 },
      }),
    ).toBeUndefined();
  });
});

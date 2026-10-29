/**
 * Geometry the page itself reports, independent of CDP: every `iframe[id]`
 * and `button[id]` in every frame, measured with `getBoundingClientRect`
 * (which includes CSS transforms) and the untransformed `offsetWidth`,
 * `clientLeft` and padding. `expectedTopLevelRect` maps a child element to
 * top-level viewport coordinates through a chain of axis-aligned owners.
 */
import type { BrowserRectangle } from '@canopy/desktop-shared/types/browser';
import type { Page } from 'playwright-core';

export interface ElementMeasurement {
  x: number;
  y: number;
  width: number;
  height: number;
  offsetWidth: number;
  offsetHeight: number;
  clientLeft: number;
  clientTop: number;
  paddingLeft: number;
  paddingTop: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const FIELDS: Array<keyof ElementMeasurement> = [
  'x',
  'y',
  'width',
  'height',
  'offsetWidth',
  'offsetHeight',
  'clientLeft',
  'clientTop',
  'paddingLeft',
  'paddingTop',
];

export function decodeMeasurements(
  value: unknown,
): Record<string, ElementMeasurement> {
  const result: Record<string, ElementMeasurement> = {};
  if (!isRecord(value)) return result;
  for (const [id, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const numbers = FIELDS.map((field) => entry[field]);
    if (!numbers.every((number) => typeof number === 'number')) continue;
    result[id] = {
      x: Number(entry.x),
      y: Number(entry.y),
      width: Number(entry.width),
      height: Number(entry.height),
      offsetWidth: Number(entry.offsetWidth),
      offsetHeight: Number(entry.offsetHeight),
      clientLeft: Number(entry.clientLeft),
      clientTop: Number(entry.clientTop),
      paddingLeft: Number(entry.paddingLeft),
      paddingTop: Number(entry.paddingTop),
    };
  }
  return result;
}

/** Measures `iframe[id]` and `button[id]` in every frame of the page. */
export async function measureFrames(
  page: Page,
): Promise<Record<string, ElementMeasurement>> {
  const result: Record<string, ElementMeasurement> = {};
  for (const frame of page.frames()) {
    const measured: unknown = await frame
      .evaluate(() =>
        Array.from(document.querySelectorAll('iframe[id], button[id]')).map(
          (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return [
              element.id,
              {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                offsetWidth:
                  element instanceof HTMLElement ? element.offsetWidth : 0,
                offsetHeight:
                  element instanceof HTMLElement ? element.offsetHeight : 0,
                clientLeft: element.clientLeft,
                clientTop: element.clientTop,
                paddingLeft: Number.parseFloat(style.paddingLeft),
                paddingTop: Number.parseFloat(style.paddingTop),
              },
            ];
          },
        ),
      )
      .catch(() => []);
    if (!Array.isArray(measured)) continue;
    const entries: unknown[] = measured;
    for (const entry of entries) {
      if (!Array.isArray(entry)) continue;
      const pair: unknown[] = entry;
      const [id, value] = pair;
      if (typeof id !== 'string') continue;
      Object.assign(result, decodeMeasurements({ [id]: value }));
    }
  }
  return result;
}

/**
 * The element's rectangle in top-level viewport coordinates, through
 * `owners` (outermost first). Each owner is axis-aligned: its scale is its
 * transformed width over its untransformed `offsetWidth`, and its content
 * box starts `clientLeft + padding` (scaled) inside its border box.
 */
export function expectedTopLevelRect(
  measurements: Record<string, ElementMeasurement>,
  owners: string[],
  elementId: string,
): BrowserRectangle {
  let translateX = 0;
  let translateY = 0;
  let scaleX = 1;
  let scaleY = 1;
  for (const ownerId of owners) {
    const owner = measurements[ownerId];
    if (!owner) throw new Error(`No measurement for #${ownerId}.`);
    const ownerScaleX = owner.width / owner.offsetWidth;
    const ownerScaleY = owner.height / owner.offsetHeight;
    const contentX =
      owner.x + ownerScaleX * (owner.clientLeft + owner.paddingLeft);
    const contentY =
      owner.y + ownerScaleY * (owner.clientTop + owner.paddingTop);
    translateX += scaleX * contentX;
    translateY += scaleY * contentY;
    scaleX *= ownerScaleX;
    scaleY *= ownerScaleY;
  }
  const element = measurements[elementId];
  if (!element) throw new Error(`No measurement for #${elementId}.`);
  return {
    x: translateX + scaleX * element.x,
    y: translateY + scaleY * element.y,
    width: scaleX * element.width,
    height: scaleY * element.height,
  };
}

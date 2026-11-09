import { randomUUID } from 'node:crypto';
import type { BrowserRecordingStep } from '@canopy/execution-engine/types/browser';
import { CENTER_TEXT_MATCH } from '../frames/scroll-state';
import type { AmountScrollResult } from './scroll';

interface Point {
  x: number;
  y: number;
}
const move = (point: Point): string =>
  `await page.mouse.move(${point.x}, ${point.y});`;

/** `base`, moved by a distance: `box.x + 12.5`, `y - 30`. */
function offset(base: string, by: number): string {
  const amount = Math.round(by * 100) / 100;
  if (amount === 0) return base;
  return amount > 0 ? `${base} + ${amount}` : `${base} - ${-amount}`;
}

/**
 * Finds the element again before the pointer moves. The action scrolled it
 * into view and then measured its point, so the point is replayed from the
 * element's box, wherever the replay's own scroll leaves it.
 */
function fromElement(locator: string, what: string, lines: string[]): string {
  return [
    '{',
    `  const source = ${locator};`,
    '  await source.scrollIntoViewIfNeeded();',
    '  const box = await source.boundingBox();',
    `  if (!box) throw new Error('The ${what} is not rendered.');`,
    ...lines.map((line) => `  ${line}`),
    '}',
  ].join('\n');
}

const UNLOCATED =
  '// The element has no replayable locator. This replays at the point the action used, without its scroll into view.';

export function pointerRecording(options: {
  action: 'hover' | 'scroll' | 'drag';
  locator?: string;
  point?: Point;
  /**
   * For a hover or drag on an element: the top-left of its box when `point`
   * was measured, in the same coordinates. With `locator`, the step then
   * replays from the element instead of from a viewport point.
   */
  origin?: Point;
  /** The hover or drag was on an element that nothing replayable locates. */
  unlocated?: boolean;
  destination?: Point;
  steps?: number;
  modifiers?: string[];
  scroll?: AmountScrollResult;
  page?: boolean;
  /** The normalized words a to-text scroll matched inside the located element. */
  text?: string;
}): BrowserRecordingStep {
  let playwright = '// This action has no replayable locator or point.';
  const { point, origin, destination } = options;
  const note = options.unlocated ? [UNLOCATED] : [];
  if (options.action === 'hover' && point)
    playwright =
      options.locator && origin
        ? fromElement(options.locator, 'hover target', [
            `await page.mouse.move(${offset('box.x', point.x - origin.x)}, ${offset('box.y', point.y - origin.y)});`,
          ])
        : [...note, move(point)].join('\n');
  if (options.action === 'drag' && point && destination) {
    const press = [
      ...(options.modifiers ?? []).map(
        (key) => `await page.keyboard.down(${JSON.stringify(key)});`,
      ),
      'await page.mouse.down();',
    ];
    const release = [
      'await page.mouse.up();',
      ...(options.modifiers ?? [])
        .slice()
        .reverse()
        .map((key) => `await page.keyboard.up(${JSON.stringify(key)});`),
    ];
    const steps = `{ steps: ${options.steps ?? 10} }`;
    playwright =
      options.locator && origin
        ? fromElement(options.locator, 'drag source', [
            `const x = ${offset('box.x', point.x - origin.x)}, y = ${offset('box.y', point.y - origin.y)};`,
            'await page.mouse.move(x, y);',
            ...press,
            // The destination is not scrolled: it keeps its distance from the source.
            `await page.mouse.move(${offset('x', destination.x - point.x)}, ${offset('y', destination.y - point.y)}, ${steps});`,
            ...release,
          ])
        : [
            ...note,
            move(point),
            ...press,
            `await page.mouse.move(${destination.x}, ${destination.y}, ${steps});`,
            ...release,
          ].join('\n');
  }
  if (options.action === 'scroll') {
    if (!options.scroll && options.locator)
      playwright =
        options.text === undefined
          ? `await ${options.locator}.scrollIntoViewIfNeeded();`
          : // The action scrolled to the words. Their element comes into
            // view first, with the frames around it; it can be far taller
            // than the viewport, so the words are then centred inside it.
            [
              `await ${options.locator}.scrollIntoViewIfNeeded();`,
              `await ${options.locator}.evaluate((element, text) => {`,
              `  const center = ${CENTER_TEXT_MATCH.replace(/\n/g, '\n  ')};`,
              '  const nodes = [...element.childNodes, ...(element.shadowRoot ? element.shadowRoot.childNodes : [])];',
              '  for (const node of nodes) if (node.nodeType === 3 && center(node, text) !== null) return;',
              `}, ${JSON.stringify(options.text)});`,
            ].join('\n');
    if (options.scroll) {
      const deltas = options.scroll.deltas;
      if (deltas.length === 0)
        playwright = '// The scroll was already at its edge.';
      else {
        const operations =
          options.scroll.operations ??
          deltas.map((delta) => ({
            ...delta,
            kind: options.scroll?.inputMode === 'direct' ? 'script' : 'wheel',
            point: options.point,
          }));
        const lines: string[] = [];
        for (const operation of operations) {
          if (operation.kind === 'wheel') {
            const point = options.scroll.operations
              ? operation.point
              : (operation.point ?? options.point);
            if (!point) {
              lines.push('// This wheel has no replayable point.');
              continue;
            }
            lines.push(
              move(point),
              `await page.mouse.wheel(${operation.dx}, ${operation.dy});`,
            );
          } else {
            const amount = `{ left: ${operation.dx}, top: ${operation.dy}, behavior: 'instant' }`;
            if (options.page)
              lines.push(
                `await page.evaluate(() => (document.scrollingElement || document.documentElement).scrollBy(${amount}));`,
              );
            else if (options.locator)
              lines.push(
                `await ${options.locator}.evaluate(el => el.scrollBy(${amount}));`,
              );
            else lines.push('// This script scroll has no replayable locator.');
          }
        }
        playwright = lines.join('\n');
      }
    }
  }
  return {
    id: randomUUID(),
    action: options.action,
    timestamp: Date.now(),
    ...(options.locator ? { locator: options.locator } : {}),
    playwright,
  };
}

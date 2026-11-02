/**
 * @jest-environment node
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(__dirname, '..', 'canopy-tokens-core.css'),
  'utf-8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');

function baseLayerRule(selector: string): string {
  const layers = SOURCE.split('@layer base {').slice(1);
  for (const layer of layers) {
    const start = layer.indexOf(selector);
    if (start === -1) continue;
    const open = layer.indexOf('{', start);
    return layer.slice(open + 1, layer.indexOf('}', open)).trim();
  }
  throw new Error(`no ${selector} rule in a base layer`);
}

describe('text wrap styles', () => {
  // Wrapped UI text avoids a lone last word everywhere, below every utility.
  it('makes wrapped text pretty from the root, in the base layer', () => {
    expect(baseLayerRule(':root {')).toBe('text-wrap-style: pretty;');
  });

  // Plain breaks for code, fields and editors, numbers, and the chat window
  // (transcript and composer), where streamed text would move words around.
  it('keeps plain breaks in code, fields, numbers and the chat window', () => {
    const optOut = SOURCE.match(
      /:where\(([^)]*)\) \{ text-wrap-style: auto; \}/,
    );
    expect(optOut?.[1]?.split(',').map((s) => s.trim())).toEqual([
      'pre',
      'code',
      'kbd',
      'samp',
      '.font-mono',
      '.tabular-nums',
      'textarea',
      'input',
      '[contenteditable]',
      '[data-chat-window]',
    ]);
  });
});

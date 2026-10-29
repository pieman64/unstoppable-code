/**
 * @jest-environment node
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const SOURCE = readFileSync(join(__dirname, '..', 'toast-stack.css'), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');

describe('toast stack styles', () => {
  // Base UI drops `--toast-height` (and there is no frontmost height) on the
  // last card as it closes. An unresolved `var()` anywhere in the transform
  // chain invalidates the exit transform, so the card snaps back instead of
  // sliding out.
  it('resolves every card height without the Base UI variables', () => {
    expect(SOURCE).toContain(
      '--toast-rest-height: var(--toast-frontmost-height, var(--toast-height, 0px));',
    );
    const bare = SOURCE.match(/var\(--toast-(?:frontmost-)?height\)/g) ?? [];
    expect(bare).toEqual([]);
  });
});

/**
 * @jest-environment node
 */
// Source-level coverage keeps the portaled overlay contract explicit without
// mounting diff components and their chat-store/Electron dependencies.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const readComponent = (name: string): string =>
  readFileSync(join(__dirname, '..', name), 'utf-8');

describe('turn diff overlays', () => {
  it.each(['TurnDiffPopover.tsx'])(
    'marks %s as blocking native browser content',
    (component) => {
      const source = readComponent(component);

      expect(source).toContain('data-canopy-browser-native-overlay="true"');
      expect(source).toContain('document.body');
    },
  );
});

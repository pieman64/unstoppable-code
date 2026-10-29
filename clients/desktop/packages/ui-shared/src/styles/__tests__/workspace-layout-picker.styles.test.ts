/**
 * @jest-environment node
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(__dirname, '..', 'workspace-layout-picker.css'),
  'utf-8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');

describe('workspace layout picker styles', () => {
  // The desktop hides the main window with `visibility: hidden` while
  // Settings covers it. A descendant set to `visible` shows through that, so
  // the Side Panel and Bottom Drawer toggles stayed on screen over Settings.
  it('never forces the header toggles visible inside a hidden ancestor', () => {
    expect(SOURCE).toContain(
      ".workspace-layout-toggle-reveal[data-open='true'] { width: 64px; visibility: inherit; }",
    );
    expect(SOURCE).not.toContain('visibility: visible');
  });
});

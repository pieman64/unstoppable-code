// Test-only source inspection; production ui-shared remains browser-only.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';

const tokensCss = readFileSync(
  path.resolve(__dirname, '../canopy-tokens-core.css'),
  'utf8',
);

describe('custom scrollbars', () => {
  it('lets the surface show where two scrollbars meet', () => {
    // Chromium paints the corner between a vertical and a horizontal
    // scrollbar white unless styled; the Memory list showed a white square.
    // The probe exclusion keeps the scroller-style probe on native bars.
    expect(tokensCss).toMatch(
      /:not\(\[data-native-scrollbar-probe\]\)::-webkit-scrollbar-corner \{\s*background: transparent;\s*\}/,
    );
  });

  it('shows the arrow over the scrollbar, whatever cursor its scroller takes', () => {
    // A styled scrollbar takes its scroller's cursor, so the prompt box's
    // `cursor-text` showed the text cursor over its scrollbar. Chromium
    // ignores `cursor` on `::-webkit-scrollbar` itself; the thumb and the
    // track each honour their own.
    expect(tokensCss).toMatch(
      /:not\(\[data-native-scrollbar-probe\]\)::-webkit-scrollbar-thumb,\s*:not\(\[data-native-scrollbar-probe\]\)::-webkit-scrollbar-track \{\s*cursor: default;\s*\}/,
    );
  });
});

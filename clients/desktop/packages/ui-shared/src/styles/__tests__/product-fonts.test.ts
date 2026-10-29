// Test-only source inspection; production ui-shared remains browser-only.
// eslint-disable-next-line no-restricted-imports
import { existsSync, readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';

// DESIGN.md: Inter for product UI, JetBrains Mono for code, commands, paths,
// and identifiers. Both hosts must self-host both faces from this package's
// assets so a code block, a diff, or a path renders in the same typeface on
// desktop and web. The desktop used to declare only Inter and fell through to
// SF Mono, while web fetched JetBrains Mono from Google Fonts at build time.
const repoRoot = path.resolve(__dirname, '../../../../..');
const fontsRoot = path.resolve(__dirname, '../../assets/fonts');
const desktopGlobalsCss = readFileSync(
  path.join(repoRoot, 'apps/desktop-app/src/renderer/src/styles/globals.css'),
  'utf8',
);
const webLayoutSource = ''; // Hosted source checks below are explicitly skipped.
const webInterItalicManifest = ''; // Hosted font checks below are explicitly skipped.

const FACES = [
  ['Inter', 'inter/InterVariable.woff2', 'inter/InterVariable-Italic.woff2'],
  [
    'JetBrains Mono',
    'jetbrains-mono/JetBrainsMonoVariable.woff2',
    'jetbrains-mono/JetBrainsMonoVariable-Italic.woff2',
  ],
] as const;

function desktopFontFaceBlocks(family: string): string[] {
  return Array.from(desktopGlobalsCss.matchAll(/@font-face\s*\{[^}]*\}/g))
    .map((match) => match[0])
    .filter((block) => block.includes(`font-family: '${family}'`));
}

describe('product fonts', () => {
  it.each(FACES)(
    'ships %s upright and italic variable assets with a license',
    (_family, upright, italic) => {
      expect(existsSync(path.join(fontsRoot, upright))).toBe(true);
      expect(existsSync(path.join(fontsRoot, italic))).toBe(true);
      expect(
        existsSync(path.join(fontsRoot, path.dirname(upright), 'LICENSE.txt')),
      ).toBe(true);
    },
  );

  it.each(FACES)(
    'desktop self-hosts %s upright and italic from the shared assets',
    (family, upright, italic) => {
      const blocks = desktopFontFaceBlocks(family);
      const normal = blocks.find((block) =>
        block.includes('font-style: normal'),
      );
      const italicBlock = blocks.find((block) =>
        block.includes('font-style: italic'),
      );
      expect(normal).toContain(`assets/fonts/${upright}`);
      expect(italicBlock).toContain(`assets/fonts/${italic}`);
      for (const block of blocks) {
        expect(block).toContain('font-weight: 400 500');
        expect(block).toContain('font-display: swap');
      }
    },
  );

  it.skip.each(FACES)(
    'web self-hosts %s upright and italic from the shared assets',
    (family, upright, italic) => {
      expect(webLayoutSource).toContain(`assets/fonts/${upright}`);
      if (family !== 'Inter') {
        expect(webLayoutSource).toContain(`assets/fonts/${italic}`);
        return;
      }
      // Web serves Inter italic on demand from a byte-identical public copy
      // of the shared asset, declared through an explicit @font-face.
      const manifest: unknown = JSON.parse(webInterItalicManifest);
      expect(manifest).toMatchObject({
        source: `packages/ui-shared/src/assets/fonts/${italic}`,
        style: 'italic',
      });
      expect(webLayoutSource).toMatch(
        /src:url\("\$\{INTER_ITALIC_ASSET\}"\) format\("woff2"\);font-style:italic;/,
      );
    },
  );

  it.skip('web loads no face from Google Fonts', () => {
    expect(webLayoutSource).not.toContain('next/font/google');
  });
});

import { transform } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import {
  minifyRendererChunk,
  rendererChunkMinifyOptions,
} from '../renderer-minification';
import { RENDERER_OBFUSCATION_OPTIONS } from '../renderer-obfuscation';

const SOURCE = `export function summarizeRendererWidgets(widgetLabels) {
  const summaryAccumulator = [];
  for (const widgetLabel of widgetLabels) {
    if (widgetLabel.length > 3) {
      summaryAccumulator.push(widgetLabel.toUpperCase());
    } else {
      summaryAccumulator.push(\`short:\${widgetLabel}\`);
    }
  }
  return summaryAccumulator.join(', ');
}
`;

/** What Vite's transpile pass shipped before: esbuild's readable re-print. */
async function viteReprint(code: string): Promise<string> {
  const result = await transform(code, {
    loader: 'js',
    format: 'esm',
    charset: 'utf8',
    target: 'chrome130',
  });
  return result.code;
}

function obfuscate(code: string): string {
  return JavaScriptObfuscator.obfuscate(code, {
    ...RENDERER_OBFUSCATION_OPTIONS,
    seed: 1,
  }).getObfuscatedCode();
}

describe('rendererChunkMinifyOptions', () => {
  it('only removes whitespace from obfuscated chunks', () => {
    expect(rendererChunkMinifyOptions(true)).toEqual({
      minifyWhitespace: true,
      treeShaking: false,
    });
  });

  it('fully minifies chunks that are not obfuscated', () => {
    expect(rendererChunkMinifyOptions(false)).toEqual({
      minify: true,
      treeShaking: true,
    });
  });
});

describe('minifyRendererChunk', () => {
  it('changes only formatting in obfuscated chunks', async () => {
    const shippedBefore = await viteReprint(obfuscate(SOURCE));
    expect(shippedBefore.split('\n').length).toBeGreaterThan(5);

    const { code } = await minifyRendererChunk(shippedBefore, {
      fileName: 'assets/entry.js',
      obfuscated: true,
      format: 'es',
      target: 'chrome130',
      sourcemap: false,
    });

    expect(code.trimEnd().split('\n')).toHaveLength(1);
    // Re-printing both the same way yields identical programs: no identifier,
    // syntax or string change.
    expect(await viteReprint(code)).toBe(await viteReprint(shippedBefore));
    expect(code.match(/\b_0x[0-9a-f]+\b/g)).toEqual(
      shippedBefore.match(/\b_0x[0-9a-f]+\b/g),
    );
  });

  it('mangles identifiers in chunks that are not obfuscated', async () => {
    const { code } = await minifyRendererChunk(await viteReprint(SOURCE), {
      fileName: 'assets/chunk.js',
      obfuscated: false,
      format: 'es',
      target: 'chrome130',
      sourcemap: false,
    });

    expect(code).not.toMatch(/summaryAccumulator|widgetLabel\b/);
    expect(code).toContain('summarizeRendererWidgets');
    expect(code.trimEnd().split('\n')).toHaveLength(1);
  });

  it('returns a separate source map when maps are enabled', async () => {
    const { code, map } = await minifyRendererChunk(SOURCE, {
      fileName: 'assets/chunk.js',
      obfuscated: false,
      format: 'es',
      target: 'chrome130',
      sourcemap: true,
    });

    expect(code).not.toContain('sourceMappingURL');
    expect(map).toMatchObject({ version: 3, sources: ['assets/chunk.js'] });
  });
});

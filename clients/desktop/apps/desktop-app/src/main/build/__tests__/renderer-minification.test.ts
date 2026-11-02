import { transform } from 'esbuild';
import { minifyRendererChunk } from '../renderer-minification';

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

/** Vite's transpile output before the final pass: esbuild's readable re-print. */
async function viteReprint(code: string): Promise<string> {
  const result = await transform(code, {
    loader: 'js',
    format: 'esm',
    charset: 'utf8',
    target: 'chrome130',
  });
  return result.code;
}

describe('minifyRendererChunk', () => {
  it('mangles identifiers and ships one line', async () => {
    const { code } = await minifyRendererChunk(await viteReprint(SOURCE), {
      fileName: 'assets/chunk.js',
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
      format: 'es',
      target: 'chrome130',
      sourcemap: true,
    });

    expect(code).not.toContain('sourceMappingURL');
    expect(map).toMatchObject({ version: 3, sources: ['assets/chunk.js'] });
  });
});

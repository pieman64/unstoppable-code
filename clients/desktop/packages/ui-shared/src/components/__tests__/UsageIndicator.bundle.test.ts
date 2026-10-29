import { buildSync } from 'esbuild';

describe('usage details loading', () => {
  it('keeps usage detail views out of the initial composer bundle', () => {
    const entryPoint = '../UsageIndicator.tsx';
    const outputPrefix = `${__dirname.replaceAll('\\', '/')}/`;
    const result = buildSync({
      absWorkingDir: __dirname,
      entryPoints: [entryPoint],
      outdir: '.bundle-output',
      bundle: true,
      write: false,
      splitting: true,
      metafile: true,
      platform: 'browser',
      format: 'esm',
      jsx: 'automatic',
      packages: 'external',
    });
    const outputs = result.metafile?.outputs;
    if (!outputs || !result.outputFiles)
      throw new Error('Missing bundle output');
    const entry = Object.entries(outputs).find(
      ([, output]) => output.entryPoint === entryPoint,
    );
    if (!entry) throw new Error('Missing composer entry');
    const initial = new Set<string>();
    const visit = (name: string): void => {
      if (initial.has(name)) return;
      initial.add(name);
      for (const dependency of outputs[name]?.imports ?? []) {
        if (!dependency.external && dependency.kind !== 'dynamic-import') {
          visit(dependency.path);
        }
      }
    };
    visit(entry[0]);
    const content = new Map(
      result.outputFiles.map((file) => [
        file.path.replaceAll('\\', '/').slice(outputPrefix.length),
        file.text,
      ]),
    );
    const initialCode = Array.from(initial, (name: string) => {
      const text = content.get(name);
      if (text === undefined) throw new Error(`Missing emitted chunk ${name}`);
      return text;
    }).join('\n');
    const allCode = [...content.values()].join('\n');

    // The normal composer must not pay for optional usage details.
    expect(initialCode).not.toContain('usage-indicator-details-switch');
    expect(initialCode).not.toContain('usage-indicator-context-breakdown');
    // A split must retain the details when the user opens the popover.
    expect(allCode).toContain('usage-indicator-details-switch');
    expect(allCode).toContain('usage-indicator-context-breakdown');
  });
});

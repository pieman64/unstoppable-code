import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Ollama prefix call sites', () => {
  it.each([
    'packages/desktop-shared/src/builtin-actions/_lib/model-registry.ts',
  ])('%s uses the shared prefix helper', (relativePath) => {
    const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');

    expect(source).not.toContain("replace(/^ollama-/, '')");
    expect(source.match(/stripOllamaModelPrefix\(id\)/g)).toHaveLength(2);
  });
});

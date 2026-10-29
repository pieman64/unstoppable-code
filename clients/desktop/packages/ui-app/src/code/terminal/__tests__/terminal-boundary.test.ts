/** @jest-environment jsdom */
// eslint-disable-next-line no-restricted-imports
import { readFileSync, readdirSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
function productionFiles(directory: string): string[] {
  return readdirSync(join(REPO_ROOT, directory), {
    withFileTypes: true,
  }).flatMap((entry): string[] => {
    if (entry.name === '__tests__') return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
const IMPLEMENTATION_FILES = [
  ...productionFiles('packages/ui-app/src/code/terminal'),
  ...productionFiles('packages/app-state/src/terminal'),
];

describe('shared terminal package boundary', () => {
  it.each(IMPLEMENTATION_FILES)('%s has no desktop-only dependency', (file) => {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    expect(source).not.toMatch(/window\.api/);
    expect(source).not.toMatch(/@canopy\/desktop-shared/);
    expect(source).not.toMatch(/['"]electron['"]/);
    expect(source).not.toMatch(/['"]@\//);
  });

  it('keeps the terminal-core entry xterm-free at runtime', () => {
    jest.mock('@xterm/xterm', () => {
      throw new Error('terminal-core imported @xterm/xterm');
    });
    jest.mock('@xterm/addon-fit', () => {
      throw new Error('terminal-core imported @xterm/addon-fit');
    });
    jest.mock('@xterm/addon-search', () => {
      throw new Error('terminal-core imported @xterm/addon-search');
    });

    expect(() => {
      jest.isolateModules(() => {
        jest.requireActual('../../../terminal-core');
      });
    }).not.toThrow();
  });
});

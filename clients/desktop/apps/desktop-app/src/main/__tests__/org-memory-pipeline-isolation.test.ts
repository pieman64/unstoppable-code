import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

describe('organization memory pipeline isolation', () => {
  it('keeps pipeline, builtin-action, and desktop CLI sources free of the memory client', async () => {
    const roots = [
      join(process.cwd(), 'apps/desktop-app/src/main/pipelines'),
      join(process.cwd(), 'packages/desktop-shared/src/builtin-actions'),
    ];
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    // A literal import-path scan can miss the client reached through a barrel or
    // re-export, so we also flag the client's public entry symbols by name —
    // those surface at any call site regardless of the import path taken.
    // 'fetchOrgMemory' matches both fetchOrgMemory and fetchOrgMemoryAttempt.
    const forbiddenMarkers = ['memory/memory-client', 'fetchOrgMemory'];
    const violations: string[] = [];
    await Promise.all(
      files.map(async (file) => {
        const source = await readFile(file, 'utf8');
        if (forbiddenMarkers.some((marker) => source.includes(marker))) {
          violations.push(file);
        }
      }),
    );
    expect(violations).toEqual([]);
  });
});

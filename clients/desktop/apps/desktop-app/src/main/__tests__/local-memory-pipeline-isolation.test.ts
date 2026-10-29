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

describe('local memory pipeline isolation', () => {
  it('routes cowork chats through the interactive dispatch funnel', async () => {
    const serviceSource = await readFile(
      join(
        process.cwd(),
        'apps/desktop-app/src/main/services/standalone-chat-service.ts',
      ),
      'utf8',
    );
    const funnelSource = await readFile(
      join(
        process.cwd(),
        'apps/desktop-app/src/main/lib/worktree-chat-turn.ts',
      ),
      'utf8',
    );
    expect(serviceSource).toContain('await dispatchWorktreeChatTurn({');
    expect(serviceSource).toContain('projectId: workspaceId');
    expect(funnelSource).toContain('await prepareLocalMemory({');
  });

  it('keeps pipelines, builtin actions, and desktop CLI outside local-memory injection', async () => {
    const roots = [
      join(process.cwd(), 'apps/desktop-app/src/main/pipelines'),
      join(process.cwd(), 'packages/desktop-shared/src/builtin-actions'),
    ];
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const forbiddenMarkers = [
      'memory/local/prepare',
      'prepareLocalMemory',
      'renderLocalMemoryBlock',
      '<local_memory>',
    ];
    const violations: string[] = [];
    await Promise.all(
      files.map(async (file): Promise<void> => {
        const source = await readFile(file, 'utf8');
        if (forbiddenMarkers.some((marker) => source.includes(marker))) {
          violations.push(file);
        }
      }),
    );
    expect(violations).toEqual([]);
  });
});

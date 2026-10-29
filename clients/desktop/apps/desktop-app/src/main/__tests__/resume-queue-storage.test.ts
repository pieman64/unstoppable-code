import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ResumeQueueStorage } from '../services/resume-queue-storage';

it('atomically replaces queue state and preserves corrupt or unsupported state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resume-queue-'));
  const file = join(dir, 'queue.json');
  try {
    const storage = new ResumeQueueStorage(file);
    expect(await storage.load()).toBeNull();
    const state = {
      version: 1 as const,
      revision: 1,
      paused: true,
      entries: [
        {
          id: 'entry',
          target: {
            kind: 'chat' as const,
            projectId: 'p',
            worktreeId: 'w',
            chatId: 'c',
          },
          title: 'Task',
          workspaceName: 'Workspace',
          interruptionId: '1',
          accountProxyConnectionId: 'proxy',
          createdAt: 1,
          status: 'waiting' as const,
          providers: ['codex' as const],
        },
      ],
    };
    await storage.save(state);
    expect(await new ResumeQueueStorage(file).load()).toEqual(state);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(state);
    const legacy = {
      ...state,
      entries: state.entries.map((entry) => ({
        ...entry,
        providers: undefined,
      })),
    };
    await writeFile(file, JSON.stringify(legacy));
    expect(await storage.load()).toEqual(legacy);
    await writeFile(file, '{"version":99,"entries":[]}');
    await expect(storage.load()).rejects.toThrow('unsupported or corrupt');
    expect(await readFile(file, 'utf8')).toBe('{"version":99,"entries":[]}');
    await writeFile(file, '{');
    await expect(storage.load()).rejects.toThrow('unsupported or corrupt');
    expect(await readFile(file, 'utf8')).toBe('{');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

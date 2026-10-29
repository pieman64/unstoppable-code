import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProviderStorePresence } from '../provider-presence';

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

describe('detectProviderStorePresence', () => {
  let root: string;
  let dataDir: string;
  let claudeProjectsDir: string;
  let claudeGlobalConfigPath: string;
  let codexSessionsDir: string;
  let codexGlobalStatePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'provider-presence-'));
    dataDir = join(root, 'canopy-data');
    claudeProjectsDir = join(root, 'claude', 'projects');
    claudeGlobalConfigPath = join(root, 'claude', '.claude.json');
    codexSessionsDir = join(root, 'codex', 'sessions');
    codexGlobalStatePath = join(root, 'codex', '.codex-global-state.json');
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function probe(): Promise<boolean> {
    return detectProviderStorePresence({
      claudeProjectsDir,
      claudeGlobalConfigPath,
      codexSessionsDir,
      codexGlobalStatePath,
      excludedRoots: [dataDir],
      ownOriginators: ['unstoppable-code'],
    });
  }

  it('is false with no provider stores at all', async () => {
    expect(await probe()).toBe(false);
  });

  it("ignores Canopy's own Claude footprint but sees an external project dir", async () => {
    const ownSlug = join(dataDir, 'workspaces', 'x', 'worktrees', 'y').replace(
      /[^A-Za-z0-9-]/g,
      '-',
    );
    await mkdir(join(claudeProjectsDir, ownSlug), { recursive: true });
    expect(await probe()).toBe(false);
    await mkdir(join(claudeProjectsDir, '-Users-me-app'), { recursive: true });
    // An external directory alone proves nothing until a native session is in it.
    expect(await probe()).toBe(false);
    await writeFile(
      join(claudeProjectsDir, '-Users-me-app', 'sdk.jsonl'),
      jsonl([
        {
          type: 'user',
          cwd: '/Users/me/app',
          sessionId: 'sdk',
          entrypoint: 'sdk-ts',
          timestamp: '2026-09-01T00:00:00.000Z',
          message: { role: 'user', content: 'hi' },
        },
      ]),
    );
    expect(await probe()).toBe(false);
    await writeFile(
      join(claudeProjectsDir, '-Users-me-app', 'native.jsonl'),
      jsonl([
        {
          type: 'user',
          cwd: '/Users/me/app',
          sessionId: 'native',
          timestamp: '2026-09-02T00:00:00.000Z',
          message: { role: 'user', content: 'hi' },
        },
      ]),
    );
    expect(await probe()).toBe(true);
  });

  it('does not treat a sibling that merely shares the data-dir prefix as Canopy footprint', async () => {
    const siblingSlug = `${dataDir}2`.replace(/[^A-Za-z0-9-]/g, '-');
    await mkdir(join(claudeProjectsDir, siblingSlug), { recursive: true });
    await writeFile(
      join(claudeProjectsDir, siblingSlug, 'native.jsonl'),
      jsonl([
        {
          type: 'user',
          cwd: `${dataDir}2`,
          sessionId: 'native',
          timestamp: '2026-09-02T00:00:00.000Z',
          message: { role: 'user', content: 'hi' },
        },
      ]),
    );
    expect(await probe()).toBe(true);
  });

  it('reads only external project keys from the Claude settings file', async () => {
    await mkdir(join(root, 'claude'), { recursive: true });
    await writeFile(
      claudeGlobalConfigPath,
      JSON.stringify({
        projects: { [join(dataDir, 'workspaces', 'w')]: {} },
      }),
    );
    expect(await probe()).toBe(false);
    await writeFile(
      claudeGlobalConfigPath,
      JSON.stringify({
        projects: { [join(dataDir, 'w')]: {}, '/Users/me/site': {} },
      }),
    );
    expect(await probe()).toBe(true);
  });

  it('treats Codex threads with the brand originator as Canopy footprint', async () => {
    const day = join(codexSessionsDir, '2026', '03', '12');
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, 'rollout-2026-03-12T10-00-00-own.jsonl'),
      jsonl([
        {
          type: 'session_meta',
          payload: {
            id: 'own',
            cwd: '/Users/me/app',
            originator: 'unstoppable-code',
          },
        },
      ]),
    );
    await writeFile(
      join(day, 'rollout-2026-03-12T09-00-00-inside.jsonl'),
      jsonl([
        {
          type: 'session_meta',
          payload: {
            id: 'inside',
            cwd: join(dataDir, 'workspaces', 'w'),
            originator: 'codex_cli_rs',
          },
        },
      ]),
    );
    expect(await probe()).toBe(false);
    await writeFile(
      join(day, 'rollout-2026-03-12T08-00-00-native.jsonl'),
      jsonl([
        {
          type: 'session_meta',
          payload: {
            id: 'native',
            cwd: '/Users/me/app',
            originator: 'codex_cli_rs',
          },
        },
      ]),
    );
    expect(await probe()).toBe(true);
  });

  it('accepts a Codex desktop local project as evidence', async () => {
    await mkdir(join(root, 'codex'), { recursive: true });
    await writeFile(
      codexGlobalStatePath,
      JSON.stringify({
        'local-projects': {
          one: { id: 'one', name: 'Site', rootPaths: ['/Users/me/site'] },
        },
      }),
    );
    expect(await probe()).toBe(true);
  });
});

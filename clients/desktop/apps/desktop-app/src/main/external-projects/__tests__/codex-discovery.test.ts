import type { Stats } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Records every path `stat`ed so a test can prove the scan budget bounds
// the listing work, not only the head reads.
const mockStatTracker: { paths: string[] } = { paths: [] };
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    stat: (path: Parameters<typeof actual.stat>[0]): Promise<Stats> => {
      mockStatTracker.paths.push(String(path));
      return actual.stat(path);
    },
  };
});
import {
  discoverCodexProjects,
  readCodexRolloutHeadMetadata,
} from '../codex-discovery';
import { DEFAULT_DISCOVERY_LIMITS } from '../types';

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function sessionMeta(
  id: string,
  cwd: string,
  originator = 'codex_cli_rs',
): Record<string, unknown> {
  return {
    timestamp: '2026-03-12T21:08:11.457Z',
    type: 'session_meta',
    payload: {
      id,
      timestamp: '2026-03-12T21:08:11.415Z',
      cwd,
      originator,
      cli_version: '0.147.0',
      source: 'cli',
      base_instructions: { text: 'never surfaced' },
      git: { branch: 'main' },
    },
  };
}

function userMessage(message: string): Record<string, unknown> {
  return {
    timestamp: '2026-03-12T21:08:12.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message },
  };
}

describe('readCodexRolloutHeadMetadata', () => {
  it('reads thread id, cwd, originator, and the first real user line', () => {
    expect(
      readCodexRolloutHeadMetadata([
        sessionMeta('t1', '/Users/me/app', 'Codex Desktop'),
        userMessage(
          '<environment_context>x</environment_context>\n\nAdd tests',
        ),
      ]),
    ).toEqual({
      threadId: 't1',
      cwd: '/Users/me/app',
      originator: 'Codex Desktop',
      startedAt: '2026-03-12T21:08:11.415Z',
      title: 'Add tests',
    });
  });

  it('returns null without a session_meta record', () => {
    expect(readCodexRolloutHeadMetadata([userMessage('hi')])).toBeNull();
  });
});

describe('discoverCodexProjects', () => {
  let root: string;
  let sessionsDir: string;

  let originalCodexHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-discovery-'));
    sessionsDir = join(root, 'sessions');
    // Every path the adapter resolves on its own (the thread-name index
    // above all) must land in the fixture, never in the developer's real
    // store, whose contents would race the fixture's diagnostics.
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
  });

  afterEach(async () => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    await rm(root, { recursive: true, force: true });
  });

  it('reports nothing detected without a store', async () => {
    const result = await discoverCodexProjects({
      sessionsDir,
      globalStatePath: join(root, 'missing.json'),
    });
    expect(result).toEqual({ roots: [], diagnostics: [], detected: false });
  });

  it('walks day directories newest first, marks own threads, and reads local projects', async () => {
    const day1 = join(sessionsDir, '2026', '01', '05');
    const day2 = join(sessionsDir, '2026', '03', '12');
    await mkdir(day1, { recursive: true });
    await mkdir(day2, { recursive: true });
    await writeFile(
      join(day1, 'rollout-2026-01-05T10-00-00-old.jsonl'),
      jsonl([sessionMeta('old', '/Users/me/app'), userMessage('Old task')]),
    );
    await writeFile(
      join(day2, 'rollout-2026-03-12T14-08-11-new.jsonl'),
      jsonl([sessionMeta('new', '/Users/me/app'), userMessage('New task')]),
    );
    await writeFile(
      join(day2, 'rollout-2026-03-12T15-00-00-own.jsonl'),
      jsonl([sessionMeta('own', '/Users/me/app', 'unstoppable-code')]),
    );
    await writeFile(
      join(root, '.codex-global-state.json'),
      JSON.stringify({
        'electron-mac-push-deregistration-token': 'never-read',
        'local-projects': {
          'local-1': {
            id: 'local-1',
            name: 'Website',
            rootPaths: ['/Users/me/website', '/Users/me/website-assets'],
            createdAt: 1_757_000_000_000,
            updatedAt: 1_757_100_000_000,
          },
          'local-bad': { id: 'local-bad', rootPaths: 'nope' },
        },
      }),
    );

    const result = await discoverCodexProjects({
      sessionsDir,
      globalStatePath: join(root, '.codex-global-state.json'),
      ownOriginators: ['unstoppable-code'],
    });
    expect(result.detected).toBe(true);
    const byPath = new Map(
      result.roots.map((entry) => [entry.rootPath, entry]),
    );
    expect(Array.from(byPath.keys()).sort()).toEqual([
      '/Users/me/app',
      '/Users/me/website',
      '/Users/me/website-assets',
    ]);
    const app = byPath.get('/Users/me/app');
    // Same-day files tie on mtime, so the rollout name's timestamp orders them.
    expect(app?.sessions.map((session) => session.id)).toEqual([
      'own',
      'new',
      'old',
    ]);
    expect(app?.sessions.map((session) => session.native)).toEqual([
      false,
      true,
      true,
    ]);
    expect(app?.sessions[1]).toMatchObject({
      kind: 'codex-rollout',
      surface: 'codex-cli',
      title: 'New task',
    });
    expect(byPath.get('/Users/me/website')).toMatchObject({
      surface: 'codex-desktop',
      displayName: 'Website',
      lastActivityAt: new Date(1_757_100_000_000).toISOString(),
    });
    expect(byPath.get('/Users/me/website-assets')?.displayName).toBeUndefined();
  });

  it('dates a rollout by its last message, reading the tail of a large file', async () => {
    const day = join(sessionsDir, '2026', '03', '12');
    await mkdir(day, { recursive: true });
    const file = join(day, 'rollout-2026-03-12T14-08-11-long.jsonl');
    await writeFile(
      file,
      jsonl([
        sessionMeta('long', '/Users/me/app'),
        userMessage('Start'),
        // Pushes the last records past the head the scan reads.
        {
          timestamp: '2026-03-12T21:09:00.000Z',
          type: 'response_item',
          payload: { type: 'reasoning', text: 'x'.repeat(40_000) },
        },
        {
          timestamp: '2026-03-14T09:30:00.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Done' },
        },
        {
          timestamp: '2026-10-12T15:00:00.000Z',
          type: 'turn_context',
          payload: {},
        },
      ]),
    );
    const touched = new Date('2026-10-12T15:19:31.000Z');
    await utimes(file, touched, touched);

    const result = await discoverCodexProjects({
      sessionsDir,
      globalStatePath: join(root, 'missing.json'),
    });
    expect(result.roots[0]?.sessions[0]?.lastActivityAt).toBe(
      '2026-03-14T09:30:00.000Z',
    );
  });

  it('does not date a rollout by a later developer message', async () => {
    const day = join(sessionsDir, '2026', '03', '12');
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, 'rollout-2026-03-12T14-08-11-resumed.jsonl'),
      jsonl([
        sessionMeta('resumed', '/Users/me/app'),
        {
          timestamp: '2026-03-14T09:30:00.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Done' },
        },
        // A resume writes instructions, not a turn anyone took.
        {
          timestamp: '2026-10-12T15:00:00.000Z',
          type: 'response_item',
          payload: { type: 'message', role: 'developer', content: [] },
        },
      ]),
    );

    const result = await discoverCodexProjects({
      sessionsDir,
      globalStatePath: join(root, 'missing.json'),
    });
    expect(result.roots[0]?.sessions[0]?.lastActivityAt).toBe(
      '2026-03-14T09:30:00.000Z',
    );
  });

  it('prefers the thread name Codex keeps in its session index over the first user line', async () => {
    const day = join(sessionsDir, '2026', '03', '12');
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, 'rollout-2026-03-12T14-08-11-named.jsonl'),
      jsonl([sessionMeta('named', '/Users/me/app'), userMessage('First line')]),
    );
    await writeFile(
      join(day, 'rollout-2026-03-12T15-08-11-unnamed.jsonl'),
      jsonl([
        sessionMeta('unnamed', '/Users/me/app'),
        userMessage('Only line'),
      ]),
    );
    // `session_index.jsonl` is the name Codex itself shows in its resume
    // picker, so it wins over a summary of the first prompt. Torn or
    // unrelated rows are ignored, never fatal.
    await writeFile(
      join(root, 'session_index.jsonl'),
      [
        JSON.stringify({
          id: 'named',
          thread_name: '  Fix the login bug  ',
          updated_at: '2026-03-12T14:10:00Z',
        }),
        '{not json',
        JSON.stringify({ id: 'other', thread_name: 'Unrelated' }),
        JSON.stringify({ id: 'unnamed', thread_name: '   ' }),
        '',
      ].join('\n'),
    );
    const result = await discoverCodexProjects({
      sessionsDir,
      globalStatePath: join(root, 'missing.json'),
      sessionIndexPath: join(root, 'session_index.jsonl'),
    });
    const app = result.roots.find(
      (entry) => entry.rootPath === '/Users/me/app',
    );
    const titles = new Map(
      app?.sessions.map((session) => [session.id, session.title]),
    );
    expect(titles.get('named')).toBe('Fix the login bug');
    expect(titles.get('unnamed')).toBe('Only line');
  });

  it('reads only the newest rows of a thread name list that outgrew the scan', async () => {
    const day = join(sessionsDir, '2026', '03', '12');
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, 'rollout-2026-03-12T14-08-11-old.jsonl'),
      jsonl([sessionMeta('old', '/Users/me/app'), userMessage('Old line')]),
    );
    await writeFile(
      join(day, 'rollout-2026-03-12T15-08-11-new.jsonl'),
      jsonl([sessionMeta('new', '/Users/me/app'), userMessage('New line')]),
    );
    // Append-only: the oldest thread's row sits first, past the window the
    // scan bound retains, so it keeps its first-line title.
    await writeFile(
      join(root, 'session_index.jsonl'),
      [
        JSON.stringify({ id: 'old', thread_name: 'Old name' }),
        JSON.stringify({ id: 'other', thread_name: 'Unrelated' }),
        JSON.stringify({ id: 'new', thread_name: 'New name' }),
        '',
      ].join('\n'),
    );
    const result = await discoverCodexProjects({
      sessionsDir,
      globalStatePath: join(root, 'missing.json'),
      sessionIndexPath: join(root, 'session_index.jsonl'),
      limits: { ...DEFAULT_DISCOVERY_LIMITS, maxSessionFiles: 2 },
    });
    const titles = new Map(
      result.roots.flatMap((entry) =>
        entry.sessions.map((session) => [session.id, session.title]),
      ),
    );
    expect(titles.get('new')).toBe('New name');
    expect(titles.get('old')).toBe('Old line');
  });

  it('skips an oversized desktop project list with a diagnostic', async () => {
    await writeFile(
      join(root, '.codex-global-state.json'),
      JSON.stringify({
        'local-projects': { one: { rootPaths: ['/Users/me/x'] } },
      }),
    );
    const result = await discoverCodexProjects({
      sessionsDir,
      globalStatePath: join(root, '.codex-global-state.json'),
      limits: { ...DEFAULT_DISCOVERY_LIMITS, maxGlobalConfigBytes: 8 },
    });
    expect(result.roots).toEqual([]);
    expect(result.diagnostics[0]?.message).toMatch(
      /Codex desktop project list is larger/,
    );
  });

  it('stops listing day directories once the scan budget is met', async () => {
    // Newest day first; each day holds two rollouts. Days are listed in
    // groups of `maxConcurrentReads`, so with a group of two the newest two
    // days are listed together and exhaust the budget of two, and the
    // oldest day must not even have its files stat'ed.
    const days = ['2026/03/12', '2026/03/11', '2026/03/10'];
    for (const { day, index } of days.map((day, index) => ({ day, index }))) {
      const dir = join(sessionsDir, day);
      await mkdir(dir, { recursive: true });
      for (const n of [1, 2]) {
        await writeFile(
          join(
            dir,
            `rollout-2026-03-1${2 - index}T1${n}-00-00-t${index}${n}.jsonl`,
          ),
          jsonl([
            sessionMeta(`t${index}${n}`, '/Users/me/app'),
            userMessage('hi'),
          ]),
        );
      }
    }
    mockStatTracker.paths = [];
    const result = await discoverCodexProjects({
      sessionsDir,
      globalStatePath: join(root, 'missing.json'),
      limits: {
        ...DEFAULT_DISCOVERY_LIMITS,
        maxSessionFiles: 2,
        maxConcurrentReads: 2,
      },
    });
    const ids = result.roots.flatMap((entry) =>
      entry.sessions.map((session) => session.id),
    );
    expect(ids.sort()).toEqual(['t01', 't02']);
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      'Only the 2 most recent Codex threads were scanned.',
    ]);
    const oldest = join(sessionsDir, '2026/03/10');
    expect(
      mockStatTracker.paths.filter((entry) => entry.startsWith(oldest)),
    ).toEqual([]);
  });

  it('stops before listing another group when the budget is met exactly at a group boundary', async () => {
    // Two rollouts per day and a budget of four: the newest group of two
    // days fills the budget exactly, with no further file seen to flag it.
    // The next group must not be listed or stat'ed, and the scan still
    // says it was bounded because days remained.
    const days = ['2026/03/12', '2026/03/11', '2026/03/10'];
    for (const { day, index } of days.map((day, index) => ({ day, index }))) {
      const dir = join(sessionsDir, day);
      await mkdir(dir, { recursive: true });
      for (const n of [1, 2]) {
        await writeFile(
          join(
            dir,
            `rollout-2026-03-1${2 - index}T1${n}-00-00-t${index}${n}.jsonl`,
          ),
          jsonl([
            sessionMeta(`t${index}${n}`, '/Users/me/app'),
            userMessage('hi'),
          ]),
        );
      }
    }
    mockStatTracker.paths = [];
    const result = await discoverCodexProjects({
      sessionsDir,
      globalStatePath: join(root, 'missing.json'),
      limits: {
        ...DEFAULT_DISCOVERY_LIMITS,
        maxSessionFiles: 4,
        maxConcurrentReads: 2,
      },
    });
    const ids = result.roots.flatMap((entry) =>
      entry.sessions.map((session) => session.id),
    );
    expect(ids.sort()).toEqual(['t01', 't02', 't11', 't12']);
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      'Only the 4 most recent Codex threads were scanned.',
    ]);
    const oldest = join(sessionsDir, '2026/03/10');
    expect(
      mockStatTracker.paths.filter((entry) => entry.startsWith(oldest)),
    ).toEqual([]);
  });

  it('bounds the rollout scan and says so', async () => {
    const day = join(sessionsDir, '2026', '03', '12');
    await mkdir(day, { recursive: true });
    for (let index = 0; index < 3; index += 1) {
      await writeFile(
        join(day, `rollout-2026-03-12T1${index}-00-00-t${index}.jsonl`),
        jsonl([sessionMeta(`t${index}`, '/Users/me/app')]),
      );
    }
    const result = await discoverCodexProjects({
      sessionsDir,
      globalStatePath: join(root, 'missing.json'),
      limits: { ...DEFAULT_DISCOVERY_LIMITS, maxSessionFiles: 1 },
    });
    expect(result.roots[0]?.sessions).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toMatch(/most recent Codex threads/);
  });
});

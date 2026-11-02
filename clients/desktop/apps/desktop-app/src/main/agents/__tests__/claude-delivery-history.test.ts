import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProjectDirCandidates } from '../../lib/claude-project-paths';
import { readClaudeDeliveryHistory } from '../claude-delivery-history';
import type { AgentProvider } from '../types';

interface ClaudeCodeSessionModule {
  ClaudeCodeProvider: new () => AgentProvider;
}

const mockQuery = jest.fn();
let claudeCodeSessionModule: ClaudeCodeSessionModule;

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

const SESSION_ID = 'claude-session';
const ATTEMPT_ID = 'attempt-id';
const ROW_ID = 'row-id';

describe('readClaudeDeliveryHistory', () => {
  let root: string;
  let configDir: string;
  let cwd: string;
  let transcriptPath: string;

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), 'claude-history-test-')));
    configDir = join(root, 'claude-home');
    cwd = join(root, 'project');
    const candidates = await claudeProjectDirCandidates(cwd);
    transcriptPath = join(
      configDir,
      'projects',
      candidates[0] ?? 'missing-project',
      `${SESSION_ID}.jsonl`,
    );
    await mkdir(join(transcriptPath, '..'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function query(
    overrides: Partial<Parameters<typeof readClaudeDeliveryHistory>[0]> = {},
  ): Parameters<typeof readClaudeDeliveryHistory>[0] {
    return {
      sessionId: SESSION_ID,
      cwd,
      attemptId: ATTEMPT_ID,
      rowId: ROW_ID,
      rowAttemptCount: 1,
      previousRun: true,
      configDir,
      ...overrides,
    };
  }

  async function writeRecords(records: unknown[]): Promise<void> {
    await writeFile(
      transcriptPath,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
  }

  it('finds the SDK attempt uuid on a root user record', async () => {
    await writeRecords([
      { type: 'system', subtype: 'init', sessionId: SESSION_ID },
      { type: 'user', sessionId: SESSION_ID, uuid: ATTEMPT_ID },
    ]);

    await expect(readClaudeDeliveryHistory(query())).resolves.toBe('found');
  });

  it('uses the row uuid only when the row has exactly one attempt', async () => {
    await writeRecords([
      { type: 'system', sessionId: SESSION_ID },
      { type: 'user', sessionId: SESSION_ID, uuid: ROW_ID },
    ]);

    await expect(readClaudeDeliveryHistory(query())).resolves.toBe('found');
  });

  it('returns not-found only for a previous run with a matching session identity', async () => {
    await writeRecords([
      { type: 'system', sessionId: SESSION_ID },
      { type: 'assistant', sessionId: SESSION_ID, uuid: 'other-id' },
    ]);

    await expect(readClaudeDeliveryHistory(query())).resolves.toBe('not-found');
  });

  it('does not call a live run not-found', async () => {
    await writeRecords([{ type: 'system', sessionId: SESSION_ID }]);

    await expect(
      readClaudeDeliveryHistory(query({ previousRun: false })),
    ).resolves.toBe('unreadable');
  });

  it('rejects an ambiguous multi-attempt row-id match', async () => {
    await writeRecords([
      { type: 'system', sessionId: SESSION_ID },
      { type: 'user', sessionId: SESSION_ID, uuid: ROW_ID },
    ]);

    await expect(
      readClaudeDeliveryHistory(query({ rowAttemptCount: 2 })),
    ).resolves.toBe('unreadable');
  });

  it('does not treat queue-operation mentions as delivery evidence', async () => {
    await writeRecords([
      { type: 'system', sessionId: SESSION_ID },
      { type: 'queue-operation', sessionId: SESSION_ID, uuid: ATTEMPT_ID },
    ]);

    await expect(readClaudeDeliveryHistory(query())).resolves.toBe(
      'unreadable',
    );
  });

  it('rejects a sidechain uuid match', async () => {
    await writeRecords([
      { type: 'system', sessionId: SESSION_ID },
      {
        type: 'user',
        sessionId: SESSION_ID,
        isSidechain: true,
        uuid: ATTEMPT_ID,
      },
    ]);

    await expect(readClaudeDeliveryHistory(query())).resolves.toBe(
      'unreadable',
    );
  });

  it('returns unreadable when the transcript is missing', async () => {
    await expect(readClaudeDeliveryHistory(query())).resolves.toBe(
      'unreadable',
    );
  });

  it('returns unreadable when multiple transcript candidates exist', async () => {
    await writeRecords([{ type: 'system', sessionId: SESSION_ID }]);
    const duplicate = join(
      configDir,
      'projects',
      'another-project',
      `${SESSION_ID}.jsonl`,
    );
    await mkdir(join(duplicate, '..'), { recursive: true });
    await writeFile(
      duplicate,
      `{\"type\":\"system\",\"sessionId\":\"${SESSION_ID}\"}\n`,
    );

    await expect(readClaudeDeliveryHistory(query())).resolves.toBe(
      'unreadable',
    );
  });

  it('rejects transcripts containing a foreign session id', async () => {
    await writeRecords([
      { type: 'system', sessionId: SESSION_ID },
      { type: 'system', sessionId: 'different-session' },
      { type: 'user', sessionId: SESSION_ID, uuid: ATTEMPT_ID },
    ]);

    await expect(readClaudeDeliveryHistory(query())).resolves.toBe(
      'unreadable',
    );
  });

  it('requires at least one record to identify the requested session', async () => {
    await writeRecords([{ type: 'system' }]);

    await expect(readClaudeDeliveryHistory(query())).resolves.toBe(
      'unreadable',
    );
  });

  it.each(['{not-json}', '{"type":"user"}\n{'])(
    'rejects invalid or torn lines: %s',
    async (body) => {
      await writeFile(transcriptPath, `{"sessionId":"${SESSION_ID}"}\n${body}`);

      await expect(readClaudeDeliveryHistory(query())).resolves.toBe(
        'unreadable',
      );
    },
  );

  it('rejects transcripts that exceed the byte budget', async () => {
    await writeFile(transcriptPath, Buffer.alloc(64 * 1024 * 1024 + 1, 32));

    await expect(readClaudeDeliveryHistory(query())).resolves.toBe(
      'unreadable',
    );
  }, 30_000);

  it('rejects transcripts that exceed the line budget', async () => {
    const line = `{"sessionId":"${SESSION_ID}"}\n`;
    await writeFile(transcriptPath, line.repeat(200_001));

    await expect(readClaudeDeliveryHistory(query())).resolves.toBe(
      'unreadable',
    );
  });
});

describe('ClaudeCodeProvider steering target', () => {
  beforeAll(async () => {
    claudeCodeSessionModule = await import('../claude-session');
  });

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns the known SDK session id as the steering target', async () => {
    async function* emptyStream(): AsyncGenerator<unknown, void> {}
    mockQuery.mockReturnValue(emptyStream());
    const session =
      new claudeCodeSessionModule.ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'known-session-id',
          sdkSessionId: SESSION_ID,
        },
        jest.fn(),
        () => null,
      );

    expect(session.getSteeringTarget?.()).toEqual({ sessionId: SESSION_ID });
    await expect(
      session.submitSteeringInput?.('steer', ATTEMPT_ID, ROW_ID, {
        sessionId: 'stale-session-id',
        turnId: 'ignored-turn-id',
      }),
    ).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'No active turn to steer',
    });
    await session.destroy();
  });

  it('returns undefined until the SDK session id is known', async () => {
    async function* emptyStream(): AsyncGenerator<unknown, void> {}
    mockQuery.mockReturnValue(emptyStream());
    const session =
      new claudeCodeSessionModule.ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'unknown-session-id',
        },
        jest.fn(),
        () => null,
      );

    expect(session.getSteeringTarget?.()).toBeUndefined();
    await session.destroy();
  });
});

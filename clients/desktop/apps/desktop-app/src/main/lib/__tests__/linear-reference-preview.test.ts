import { LinearError, LinearErrorType, LinearGraphQLError } from '@linear/sdk';
import {
  createLinearReferencePreviewReader,
  type LinearReferencePreviewDeps,
} from '../linear-reference-preview';

const ANY_STRING: unknown = expect.any(String);

const ISSUE = {
  identifier: 'CAN-7',
  title: 'Preview tickets in transcripts',
  description:
    '## Goal\n\nShow **compact** cards. ![shot](https://x/y.png) See [docs](https://d).',
  url: 'https://linear.app/acme/issue/CAN-7/preview-tickets',
  updatedAt: '2026-10-01T12:00:00.000Z',
  state: { name: 'In Progress' },
  assignee: { displayName: 'Rowan', name: 'Rowan Doe' },
  project: null,
};

function reader(
  overrides: Partial<LinearReferencePreviewDeps> = {},
): ReturnType<typeof createLinearReferencePreviewReader> {
  return createLinearReferencePreviewReader({
    resolveToken: () => Promise.resolve('lin_api_token'),
    resolveAccountId: () => Promise.resolve('account-1'),
    requestIssue: () => Promise.resolve({ issue: ISSUE }),
    requestTeams: () => Promise.resolve(teamPage(['CAN'], null)),
    now: () => 1_000,
    ...overrides,
  });
}

function teamPage(
  keys: unknown[],
  endCursor: string | null,
): { teams: { nodes: { key: unknown }[]; pageInfo: object } } {
  return {
    teams: {
      nodes: keys.map((key) => ({ key })),
      pageInfo: { hasNextPage: endCursor !== null, endCursor },
    },
  };
}

function pagedTeams(
  pages: unknown[][],
): jest.Mock<Promise<unknown>, [string, string | null]> {
  return jest.fn((_token: string, after: string | null) => {
    const index = after === null ? 0 : Number(after);
    return Promise.resolve(
      teamPage(
        pages[index] ?? [],
        index + 1 < pages.length ? String(index + 1) : null,
      ),
    );
  });
}

describe('createLinearReferencePreviewReader', () => {
  it('returns a bounded preview and an opaque scope without the token', async () => {
    const requestIssue = jest.fn(() => Promise.resolve({ issue: ISSUE }));
    const result = await reader({ requestIssue }).readIssue({
      identifier: 'CAN-7',
    });
    expect(requestIssue).toHaveBeenCalledWith('lin_api_token', 'CAN-7');
    expect(result).toEqual({
      status: 'ok',
      scope: ANY_STRING,
      preview: {
        identifier: 'CAN-7',
        title: 'Preview tickets in transcripts',
        url: ISSUE.url,
        description: 'Goal Show compact cards. See docs.',
        status: 'In Progress',
        assignee: 'Rowan',
        project: null,
        updatedAt: ISSUE.updatedAt,
      },
    });
    expect(JSON.stringify(result)).not.toContain('lin_api_token');
  });

  it('scopes by Canopy account and credential', async () => {
    const first = await reader().readScope();
    expect(first.scope).toEqual(ANY_STRING);
    expect((await reader().readScope()).scope).toBe(first.scope);
    expect(
      (
        await reader({
          resolveAccountId: () => Promise.resolve('account-2'),
        }).readScope()
      ).scope,
    ).not.toBe(first.scope);
    expect(
      (
        await reader({
          resolveToken: () => Promise.resolve('other'),
        }).readScope()
      ).scope,
    ).not.toBe(first.scope);
  });

  it('reports a missing connection without a provider call', async () => {
    const requestIssue = jest.fn();
    const missing = reader({
      resolveToken: () => Promise.resolve(' '),
      requestIssue,
    });
    expect(await missing.readScope()).toEqual({ scope: null });
    expect(await missing.readIssue({ identifier: 'CAN-7' })).toEqual({
      status: 'disconnected',
    });
    expect(requestIssue).not.toHaveBeenCalled();
  });

  it('never substitutes an issue from another workspace', async () => {
    expect(
      await reader().readIssue({ identifier: 'CAN-7', workspaceSlug: 'other' }),
    ).toEqual({ status: 'unavailable', scope: ANY_STRING });
    expect(
      (await reader().readIssue({ identifier: 'CAN-7', workspaceSlug: 'acme' }))
        .status,
    ).toBe('ok');
  });

  it.each([
    [
      new LinearError(
        undefined,
        undefined,
        LinearErrorType.AuthenticationError,
      ),
      { status: 'disconnected' },
    ],
    [
      new LinearError(undefined, undefined, LinearErrorType.Forbidden),
      { status: 'unavailable', scope: ANY_STRING },
    ],
    [
      new LinearError(
        undefined,
        [
          Object.assign(new LinearGraphQLError(), {
            message: 'Entity not found: Issue',
          }),
        ],
        LinearErrorType.GraphqlError,
      ),
      { status: 'unavailable', scope: ANY_STRING },
    ],
    [
      Object.assign(
        new LinearError(undefined, undefined, LinearErrorType.Ratelimited),
        { retryAfter: 30 },
      ),
      { status: 'rate-limited', retryAfterMs: 30_000 },
    ],
    [
      new LinearError(undefined, undefined, LinearErrorType.NetworkError),
      { status: 'failed' },
    ],
    [new Error('socket hang up'), { status: 'failed' }],
  ])('maps provider failure %#', async (error, expected) => {
    expect(
      await reader({
        requestIssue: () => Promise.reject(error),
      }).readIssue({ identifier: 'CAN-7' }),
    ).toEqual(expected);
  });

  it('treats a malformed or empty payload as unavailable', async () => {
    expect(
      (
        await reader({
          requestIssue: () => Promise.resolve({ issue: null }),
        }).readIssue({ identifier: 'CAN-7' })
      ).status,
    ).toBe('unavailable');
    expect(
      (
        await reader({
          requestIssue: () =>
            Promise.resolve({
              issue: { ...ISSUE, url: 'https://evil.example/acme/issue/CAN-7' },
            }),
        }).readIssue({ identifier: 'CAN-7' })
      ).status,
    ).toBe('unavailable');
  });

  it('bounds a long title by code point and marks the cut', async () => {
    const title = '😀'.repeat(600);
    const result = await reader({
      requestIssue: () => Promise.resolve({ issue: { ...ISSUE, title } }),
    }).readIssue({ identifier: 'CAN-7' });
    expect(result.status).toBe('ok');
    const shown = result.status === 'ok' ? result.preview.title : '';
    expect(Array.from(shown)).toHaveLength(512);
    expect(shown.endsWith('😀…')).toBe(true);
  });

  it('coalesces identical concurrent issue reads across callers', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const requestIssue = jest.fn(
      () =>
        new Promise<unknown>((done) => {
          resolve = done;
        }),
    );
    const shared = reader({ requestIssue });
    const first = shared.readIssue({ identifier: 'CAN-7' });
    const second = shared.readIssue({ identifier: 'CAN-7' });
    await new Promise((done) => setImmediate(done));
    resolve({ issue: ISSUE });
    expect((await first).status).toBe('ok');
    expect(await second).toEqual(await first);
    expect(requestIssue).toHaveBeenCalledTimes(1);
  });
});

describe('readTeamKeys', () => {
  it('follows every page and publishes deduplicated, validated keys', async () => {
    const requestTeams = pagedTeams([
      ['CAN', 'ecw'],
      ['REG', 'CAN', 'bad key', 42, ''],
      ['ZED9'],
    ]);
    const result = await reader({ requestTeams }).readTeamKeys();
    expect(result).toEqual({
      status: 'ok',
      scope: ANY_STRING,
      keys: ['CAN', 'ECW', 'REG', 'ZED9'],
      fetchedAt: 1_000,
    });
    expect(requestTeams.mock.calls.map(([, after]) => after)).toEqual([
      null,
      '1',
      '2',
    ]);
    expect(JSON.stringify(result)).not.toContain('lin_api_token');
  });

  it('publishes an empty catalog as complete', async () => {
    expect(
      await reader({
        requestTeams: () => Promise.resolve(teamPage([], null)),
      }).readTeamKeys(),
    ).toMatchObject({ status: 'ok', keys: [] });
  });

  it('fails closed when a later page fails or is malformed', async () => {
    const failing = jest.fn((_token: string, after: string | null) =>
      after === null
        ? Promise.resolve(teamPage(['CAN'], '1'))
        : Promise.reject(new Error('socket hang up')),
    );
    expect(await reader({ requestTeams: failing }).readTeamKeys()).toEqual({
      status: 'failed',
      scope: ANY_STRING,
    });
    expect(
      await reader({
        requestTeams: () =>
          Promise.resolve({
            teams: { nodes: [{ key: 'CAN' }], pageInfo: { hasNextPage: true } },
          }),
      }).readTeamKeys(),
    ).toEqual({ status: 'failed', scope: ANY_STRING });
  });

  it('fails closed past the page bound instead of publishing a prefix', async () => {
    const requestTeams = jest.fn((_token: string, after: string | null) =>
      Promise.resolve(teamPage(['CAN'], String(Number(after ?? 0) + 1))),
    );
    expect((await reader({ requestTeams }).readTeamKeys()).status).toBe(
      'failed',
    );
    expect(requestTeams).toHaveBeenCalledTimes(20);
  });

  it('maps disconnection and rate limits', async () => {
    const requestTeams = jest.fn();
    expect(
      await reader({
        resolveToken: () => Promise.resolve(''),
        requestTeams,
      }).readTeamKeys(),
    ).toEqual({ status: 'disconnected' });
    expect(requestTeams).not.toHaveBeenCalled();
    expect(
      await reader({
        requestTeams: () =>
          Promise.reject(
            new LinearError(
              undefined,
              undefined,
              LinearErrorType.AuthenticationError,
            ),
          ),
      }).readTeamKeys(),
    ).toEqual({ status: 'disconnected' });
    expect(
      await reader({
        requestTeams: () =>
          Promise.reject(
            Object.assign(
              new LinearError(
                undefined,
                undefined,
                LinearErrorType.Ratelimited,
              ),
              { retryAfter: 12 },
            ),
          ),
      }).readTeamKeys(),
    ).toEqual({
      status: 'rate-limited',
      scope: ANY_STRING,
      retryAfterMs: 12_000,
    });
  });

  it('shares one load and a fresh catalog across callers, per credential', async () => {
    let now = 1_000;
    let token = 'lin_api_token';
    const requestTeams = pagedTeams([['CAN'], ['ECW']]);
    const shared = reader({
      requestTeams,
      now: () => now,
      resolveToken: () => Promise.resolve(token),
    });
    const [first, second] = await Promise.all([
      shared.readTeamKeys(),
      shared.readTeamKeys(),
    ]);
    expect(second).toEqual(first);
    expect(requestTeams).toHaveBeenCalledTimes(2);
    now += 4 * 60 * 1000;
    expect(await shared.readTeamKeys()).toEqual(first);
    expect(requestTeams).toHaveBeenCalledTimes(2);
    now += 2 * 60 * 1000;
    expect(await shared.readTeamKeys()).toMatchObject({ fetchedAt: now });
    expect(requestTeams).toHaveBeenCalledTimes(4);
    token = 'rotated';
    const rotated = await shared.readTeamKeys();
    expect(requestTeams).toHaveBeenCalledTimes(6);
    expect(rotated.status === 'ok' && rotated.scope).not.toBe(
      first.status === 'ok' && first.scope,
    );
  });

  it('holds back retries during the cooldown or provider retry-after', async () => {
    let now = 1_000;
    const requestTeams = jest
      .fn<Promise<unknown>, [string, string | null]>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(
        Object.assign(
          new LinearError(undefined, undefined, LinearErrorType.Ratelimited),
          { retryAfter: 120 },
        ),
      )
      .mockResolvedValue(teamPage(['CAN'], null));
    const shared = reader({ requestTeams, now: () => now });
    expect((await shared.readTeamKeys()).status).toBe('failed');
    now += 59_000;
    expect((await shared.readTeamKeys()).status).toBe('failed');
    expect(requestTeams).toHaveBeenCalledTimes(1);
    now += 1_000;
    expect(await shared.readTeamKeys()).toMatchObject({
      status: 'rate-limited',
      retryAfterMs: 120_000,
    });
    now += 60_000;
    expect(await shared.readTeamKeys()).toMatchObject({
      status: 'rate-limited',
      retryAfterMs: 60_000,
    });
    now += 60_000;
    expect((await shared.readTeamKeys()).status).toBe('ok');
    expect(requestTeams).toHaveBeenCalledTimes(3);
  });

  it('stops calling Linear with a rejected credential until it changes or the window passes', async () => {
    let now = 1_000;
    let token = 'lin_api_token';
    const requestIssue = jest.fn((): Promise<unknown> => {
      throw new LinearError(
        undefined,
        undefined,
        LinearErrorType.AuthenticationError,
      );
    });
    const requestTeams = jest.fn(() =>
      Promise.resolve(teamPage(['CAN'], null)),
    );
    const linear = reader({
      requestIssue,
      requestTeams,
      resolveToken: () => Promise.resolve(token),
      now: () => now,
    });
    expect((await linear.readTeamKeys()).status).toBe('ok');
    expect(await linear.readIssue({ identifier: 'CAN-7' })).toEqual({
      status: 'disconnected',
    });
    // The fresh catalog no longer answers `ok`; nothing reaches Linear.
    expect(await linear.readTeamKeys()).toEqual({ status: 'disconnected' });
    expect(await linear.readScope()).toEqual({ scope: null });
    expect(await linear.readIssue({ identifier: 'CAN-8' })).toEqual({
      status: 'disconnected',
    });
    expect(requestIssue).toHaveBeenCalledTimes(1);
    expect(requestTeams).toHaveBeenCalledTimes(1);

    token = 'lin_api_new';
    expect((await linear.readTeamKeys()).status).toBe('ok');
    token = 'lin_api_token';
    now += 5 * 60 * 1000;
    expect((await linear.readScope()).scope).toEqual(ANY_STRING);
  });
});

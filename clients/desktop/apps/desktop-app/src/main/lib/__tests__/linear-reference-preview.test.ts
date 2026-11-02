import { LinearApiError, type LinearIssuePreviewNode } from '../linear-api';
import {
  createLinearReferencePreviewReader,
  type LinearReferencePreviewDeps,
} from '../linear-reference-preview';

const ANY_STRING: unknown = expect.any(String);

const ISSUE: LinearIssuePreviewNode = {
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
    requestIssue: () => Promise.resolve(ISSUE),
    requestTeamKeys: () => Promise.resolve(['CAN']),
    now: () => 1_000,
    ...overrides,
  });
}

describe('createLinearReferencePreviewReader', () => {
  it('returns a bounded preview and an opaque scope without the token', async () => {
    const requestIssue = jest.fn(() => Promise.resolve(ISSUE));
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
      new LinearApiError(
        'referencePreviewIssue',
        'authentication',
        401,
        null,
        false,
      ),
      { status: 'disconnected' },
    ],
    [
      new LinearApiError(
        'referencePreviewIssue',
        'forbidden',
        403,
        null,
        false,
      ),
      { status: 'unavailable', scope: ANY_STRING },
    ],
    [
      new LinearApiError(
        'referencePreviewIssue',
        'feature_not_accessible',
        200,
        null,
        false,
      ),
      { status: 'unavailable', scope: ANY_STRING },
    ],
    [
      new LinearApiError(
        'referencePreviewIssue',
        'invalid_input',
        null,
        null,
        false,
      ),
      { status: 'unavailable', scope: ANY_STRING },
    ],
    [
      new LinearApiError(
        'referencePreviewIssue',
        'ratelimited',
        429,
        30_000,
        false,
      ),
      { status: 'rate-limited', retryAfterMs: 30_000 },
    ],
    [
      new LinearApiError('referencePreviewIssue', 'unknown', 200, null, true),
      { status: 'unavailable', scope: ANY_STRING },
    ],
    [
      new LinearApiError('referencePreviewIssue', 'network', null, null, false),
      { status: 'failed' },
    ],
    [new Error('socket hang up'), { status: 'failed' }],
  ])('maps issue preview failure %#', async (error, expected) => {
    expect(
      await reader({
        requestIssue: () => Promise.reject(error),
      }).readIssue({ identifier: 'CAN-7' }),
    ).toEqual(expected);
  });

  it('treats a null or mismatched payload as unavailable', async () => {
    expect(
      (
        await reader({
          requestIssue: () => Promise.resolve(null),
        }).readIssue({ identifier: 'CAN-7' })
      ).status,
    ).toBe('unavailable');
    expect(
      (
        await reader({
          requestIssue: () =>
            Promise.resolve({
              ...ISSUE,
              url: 'https://evil.example/acme/issue/CAN-7',
            }),
        }).readIssue({ identifier: 'CAN-7' })
      ).status,
    ).toBe('unavailable');
  });

  it('bounds a long title by code point and marks the cut', async () => {
    const title = '😀'.repeat(600);
    const result = await reader({
      requestIssue: () => Promise.resolve({ ...ISSUE, title }),
    }).readIssue({ identifier: 'CAN-7' });
    expect(result.status).toBe('ok');
    const shown = result.status === 'ok' ? result.preview.title : '';
    expect(Array.from(shown)).toHaveLength(512);
    expect(shown.endsWith('😀…')).toBe(true);
  });

  it('coalesces identical concurrent issue reads across callers', async () => {
    let resolve: (value: LinearIssuePreviewNode | null) => void = () =>
      undefined;
    const requestIssue = jest.fn(
      () =>
        new Promise<LinearIssuePreviewNode | null>((done) => {
          resolve = done;
        }),
    );
    const shared = reader({ requestIssue });
    const first = shared.readIssue({ identifier: 'CAN-7' });
    const second = shared.readIssue({ identifier: 'CAN-7' });
    await new Promise((done) => setImmediate(done));
    resolve(ISSUE);
    expect((await first).status).toBe('ok');
    expect(await second).toEqual(await first);
    expect(requestIssue).toHaveBeenCalledTimes(1);
  });
});

describe('readTeamKeys', () => {
  it('normalizes, deduplicates and sorts validated keys', async () => {
    const requestTeamKeys = jest.fn(() =>
      Promise.resolve(['CAN', 'ecw', 'REG', 'CAN', 'bad key', '', 'ZED9']),
    );
    const result = await reader({ requestTeamKeys }).readTeamKeys();
    expect(requestTeamKeys).toHaveBeenCalledWith('lin_api_token');
    expect(result).toEqual({
      status: 'ok',
      scope: ANY_STRING,
      keys: ['CAN', 'ECW', 'REG', 'ZED9'],
      fetchedAt: 1_000,
    });
    expect(JSON.stringify(result)).not.toContain('lin_api_token');
  });

  it('publishes an empty catalog as complete', async () => {
    expect(
      await reader({
        requestTeamKeys: () => Promise.resolve([]),
      }).readTeamKeys(),
    ).toMatchObject({ status: 'ok', keys: [] });
  });

  it('fails closed on an unknown team-key error without publishing keys', async () => {
    const requestTeamKeys = jest.fn(() =>
      Promise.reject(
        new LinearApiError('referencePreviewTeams', 'unknown', 200, null, true),
      ),
    );
    expect(await reader({ requestTeamKeys }).readTeamKeys()).toEqual({
      status: 'failed',
      scope: ANY_STRING,
    });
    expect(requestTeamKeys).toHaveBeenCalledWith('lin_api_token');
  });

  it.each([
    new LinearApiError('referencePreviewTeams', 'forbidden', 403, null, false),
    new LinearApiError(
      'referencePreviewTeams',
      'invalid_input',
      null,
      null,
      false,
    ),
    new LinearApiError('referencePreviewTeams', 'unknown', 200, null, true),
    new Error('socket hang up'),
  ])('maps team-key failure %# to failed with scope', async (error) => {
    expect(
      await reader({
        requestTeamKeys: () => Promise.reject(error),
      }).readTeamKeys(),
    ).toEqual({ status: 'failed', scope: ANY_STRING });
  });

  it('maps disconnection and rate limits', async () => {
    const requestTeamKeys = jest.fn();
    expect(
      await reader({
        resolveToken: () => Promise.resolve(''),
        requestTeamKeys,
      }).readTeamKeys(),
    ).toEqual({ status: 'disconnected' });
    expect(requestTeamKeys).not.toHaveBeenCalled();
    expect(
      await reader({
        requestTeamKeys: () =>
          Promise.reject(
            new LinearApiError(
              'referencePreviewTeams',
              'authentication',
              401,
              null,
              false,
            ),
          ),
      }).readTeamKeys(),
    ).toEqual({ status: 'disconnected' });
    expect(
      await reader({
        requestTeamKeys: () =>
          Promise.reject(
            new LinearApiError(
              'referencePreviewTeams',
              'ratelimited',
              429,
              12_000,
              false,
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
    const requestTeamKeys = jest.fn(() => Promise.resolve(['CAN', 'ECW']));
    const shared = reader({
      requestTeamKeys,
      now: () => now,
      resolveToken: () => Promise.resolve(token),
    });
    const [first, second] = await Promise.all([
      shared.readTeamKeys(),
      shared.readTeamKeys(),
    ]);
    expect(second).toEqual(first);
    expect(requestTeamKeys).toHaveBeenCalledTimes(1);
    now += 4 * 60 * 1000;
    expect(await shared.readTeamKeys()).toEqual(first);
    expect(requestTeamKeys).toHaveBeenCalledTimes(1);
    now += 2 * 60 * 1000;
    expect(await shared.readTeamKeys()).toMatchObject({ fetchedAt: now });
    expect(requestTeamKeys).toHaveBeenCalledTimes(2);
    token = 'rotated';
    const rotated = await shared.readTeamKeys();
    expect(requestTeamKeys).toHaveBeenCalledTimes(3);
    expect(rotated.status === 'ok' && rotated.scope).not.toBe(
      first.status === 'ok' && first.scope,
    );
  });

  it('holds back retries during the cooldown or provider retry-after', async () => {
    let now = 1_000;
    const requestTeamKeys = jest
      .fn<Promise<string[]>, [string]>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(
        new LinearApiError(
          'referencePreviewTeams',
          'ratelimited',
          429,
          120_000,
          false,
        ),
      )
      .mockResolvedValue(['CAN']);
    const shared = reader({ requestTeamKeys, now: () => now });
    expect((await shared.readTeamKeys()).status).toBe('failed');
    now += 59_000;
    expect((await shared.readTeamKeys()).status).toBe('failed');
    expect(requestTeamKeys).toHaveBeenCalledTimes(1);
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
    expect(requestTeamKeys).toHaveBeenCalledTimes(3);
  });

  it('stops calling Linear with a rejected credential until it changes or the window passes', async () => {
    let now = 1_000;
    let token = 'lin_api_token';
    const requestIssue = jest.fn((): Promise<LinearIssuePreviewNode | null> => {
      throw new LinearApiError(
        'referencePreviewIssue',
        'authentication',
        401,
        null,
        false,
      );
    });
    const requestTeamKeys = jest.fn(() => Promise.resolve(['CAN']));
    const linear = reader({
      requestIssue,
      requestTeamKeys,
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
    expect(requestTeamKeys).toHaveBeenCalledTimes(1);

    token = 'lin_api_new';
    expect((await linear.readTeamKeys()).status).toBe('ok');
    token = 'lin_api_token';
    now += 5 * 60 * 1000;
    expect((await linear.readScope()).scope).toEqual(ANY_STRING);
  });
});

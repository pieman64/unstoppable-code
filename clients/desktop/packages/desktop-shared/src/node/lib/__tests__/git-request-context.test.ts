import {
  getGitRequestContext,
  runWithGitRequestContext,
  withGitRequestContextEnv,
  type GitRequestContext,
} from '../../git-request-context';

describe('git request context', () => {
  it('propagates source and request id across async work without leaking', async () => {
    const baseEnv = { PATH: '/usr/bin' };
    expect(getGitRequestContext()).toBeUndefined();
    expect(withGitRequestContextEnv(baseEnv)).toBe(baseEnv);

    const tagged = await runWithGitRequestContext(
      { source: 'desktop-session-snapshot', requestId: 'request-123' },
      async () => {
        await Promise.resolve();
        expect(getGitRequestContext()).toEqual({
          source: 'desktop-session-snapshot',
          requestId: 'request-123',
        });
        return withGitRequestContextEnv(baseEnv);
      },
    );

    expect(tagged).toEqual({
      PATH: '/usr/bin',
      CANOPY_GIT_REQUEST_SOURCE: 'desktop-session-snapshot',
      CANOPY_GIT_REQUEST_ID: 'request-123',
    });
    expect(baseEnv).toEqual({ PATH: '/usr/bin' });
    expect(getGitRequestContext()).toBeUndefined();
  });

  it('keeps concurrent logical requests isolated', async () => {
    const readAfterYield = async (
      source: 'renderer-global-poll' | 'renderer-targeted',
      requestId: string,
    ): Promise<GitRequestContext | undefined> =>
      runWithGitRequestContext({ source, requestId }, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return getGitRequestContext();
      });

    await expect(
      Promise.all([
        readAfterYield('renderer-global-poll', 'global-1'),
        readAfterYield('renderer-targeted', 'targeted-1'),
      ]),
    ).resolves.toEqual([
      { source: 'renderer-global-poll', requestId: 'global-1' },
      { source: 'renderer-targeted', requestId: 'targeted-1' },
    ]);
  });
});

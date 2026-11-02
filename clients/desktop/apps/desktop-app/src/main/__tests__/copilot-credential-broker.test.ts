import { DeviceFlowRefreshRejectedError } from '@canopy/desktop-shared/node/copilot/device-flow';
import type { DeviceFlowGrant } from '@canopy/desktop-shared/node/copilot/device-flow';
import {
  CopilotCredentialUnreadableError,
  CopilotSignInChangedError,
  CopilotSignInExpiredError,
  createCopilotCredentialBroker,
  type CopilotCredentialBrokerDeps,
} from '../copilot/credential-broker';
import type {
  CopilotCredential,
  CopilotCredentialDelete,
  CopilotCredentialRead,
  CopilotCredentialReplace,
  CopilotCredentialRevision,
  CopilotGrant,
} from '../copilot/credential-store';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-05T00:00:00.000Z');
const pin = { host: 'https://github.com', login: 'octocat' };
const ENTRY = 'a'.repeat(32);
const OTHER_ENTRY = 'b'.repeat(32);

function credential(
  overrides: Partial<CopilotCredential> = {},
): CopilotCredential {
  return {
    version: 1,
    clientId: 'Iv23test',
    host: 'https://github.com',
    login: 'octocat',
    id: '1',
    accessToken: 'ghu_old',
    accessTokenExpiresAt: new Date(NOW + 5 * HOUR).toISOString(),
    refreshToken: 'ghr_old',
    refreshTokenExpiresAt: new Date(NOW + 100 * HOUR).toISOString(),
    entryId: ENTRY,
    revision: 1,
    ...overrides,
  };
}

const sameRevision = (
  left: CopilotCredentialRevision,
  right: CopilotCredentialRevision,
): boolean =>
  left.entryId === right.entryId && left.revision === right.revision;

interface Deps extends CopilotCredentialBrokerDeps {
  read: jest.Mock<Promise<CopilotCredentialRead>, []>;
  save: jest.Mock<
    Promise<CopilotCredentialReplace>,
    [CopilotCredentialRevision, CopilotGrant]
  >;
  clear: jest.Mock<
    Promise<CopilotCredentialDelete>,
    [CopilotCredentialRevision]
  >;
  refresh: jest.Mock<
    ReturnType<CopilotCredentialBrokerDeps['refresh']>,
    Parameters<CopilotCredentialBrokerDeps['refresh']>
  >;
  /** Another writer: Disconnect. */
  disconnect(): Promise<void>;
  /** Another writer: Connect or Change account. */
  replace(next: CopilotCredential): Promise<void>;
}

/** A compare-and-swap store, as `credential-store` provides. */
function deps(stored: CopilotCredential | null): Deps {
  const state = { stored };
  return {
    pin,
    read: jest.fn(
      (): Promise<CopilotCredentialRead> =>
        Promise.resolve(
          state.stored
            ? { status: 'present', credential: state.stored }
            : { status: 'absent' },
        ),
    ),
    save: jest.fn(
      (
        from: CopilotCredentialRevision,
        grant: CopilotGrant,
      ): Promise<CopilotCredentialReplace> => {
        const landed =
          state.stored?.entryId === from.entryId &&
          state.stored.revision === from.revision + 1 &&
          state.stored.refreshToken === grant.refreshToken;
        // A retry of a save that already landed reports it written.
        if (landed && state.stored)
          return Promise.resolve({
            status: 'written',
            credential: state.stored,
          });
        if (!state.stored || !sameRevision(state.stored, from))
          return Promise.resolve({ status: 'conflict' });
        const credential: CopilotCredential = {
          version: 1,
          clientId: grant.clientId,
          host: grant.host,
          login: grant.login,
          id: grant.id,
          accessToken: grant.accessToken,
          accessTokenExpiresAt: grant.accessTokenExpiresAt,
          refreshToken: grant.refreshToken,
          refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
          entryId: from.entryId,
          revision: from.revision + 1,
        };
        state.stored = credential;
        return Promise.resolve({ status: 'written', credential });
      },
    ),
    clear: jest.fn(
      (from: CopilotCredentialRevision): Promise<CopilotCredentialDelete> => {
        if (!state.stored || !sameRevision(state.stored, from))
          return Promise.resolve({ status: 'conflict' });
        state.stored = null;
        return Promise.resolve({ status: 'deleted' });
      },
    ),
    disconnect: (): Promise<void> => {
      state.stored = null;
      return Promise.resolve();
    },
    replace: (next: CopilotCredential): Promise<void> => {
      state.stored = next;
      return Promise.resolve();
    },
    refresh: jest.fn<
      Promise<DeviceFlowGrant>,
      [refreshToken: string, signal: AbortSignal]
    >(() =>
      Promise.resolve({
        accessToken: 'ghu_new',
        accessTokenExpiresAt: new Date(NOW + 8 * HOUR).toISOString(),
        refreshToken: 'ghr_new',
        refreshTokenExpiresAt: new Date(NOW + 200 * HOUR).toISOString(),
      }),
    ),
    now: (): number => NOW,
  };
}
const signal = (): AbortSignal => new AbortController().signal;

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  if (!predicate()) throw new Error('condition never held');
}

describe('Copilot credential broker', () => {
  it('returns the stored token while more than an hour remains', async () => {
    const d = deps(credential());
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).resolves.toBe('ghu_old');
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('refreshes once for concurrent callers when under an hour remains', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    const broker = createCopilotCredentialBroker(d);
    const tokens = await Promise.all([
      broker.token(signal()),
      broker.token(signal()),
    ]);
    expect(tokens).toEqual(['ghu_new', 'ghu_new']);
    expect(d.refresh).toHaveBeenCalledTimes(1);
    expect(d.refresh).toHaveBeenCalledWith('ghr_old', expect.any(AbortSignal));
    expect(d.save).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: ENTRY, revision: 1 }),
      expect.objectContaining({
        accessToken: 'ghu_new',
        refreshToken: 'ghr_new',
        login: 'octocat',
      }),
    );
    await expect(d.read()).resolves.toMatchObject({
      credential: { entryId: ENTRY, revision: 2, refreshToken: 'ghr_new' },
    });
  });

  it('serves the rotated grant to a caller that read the retired one', async () => {
    // A stale read: the store keeps answering with the pre-rotation grant.
    const stale = credential({
      accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
    });
    const d = deps(stale);
    d.read.mockImplementation(() =>
      Promise.resolve({ status: 'present' as const, credential: stale }),
    );
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    expect(d.refresh).toHaveBeenCalledTimes(1);
  });

  it('finishes the rotation even when the caller that started it is cancelled', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    const broker = createCopilotCredentialBroker(d);
    const caller = new AbortController();
    const pending = broker.token(caller.signal);
    await Promise.resolve();
    caller.abort();
    // The cancelled caller stops waiting; the rotation GitHub already applied
    // still lands for the next caller.
    await expect(pending).rejects.toBeDefined();
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    expect(d.refresh).toHaveBeenCalledTimes(1);
    const refreshSignal = d.refresh.mock.calls[0]?.[1];
    expect(refreshSignal).not.toBe(caller.signal);
    expect(refreshSignal?.aborted).toBe(false);
  });

  it('hands back the stored token on a refresh request when it is still fresh', async () => {
    // Another session may already have rotated the grant; a second rotation
    // would only retire a token GitHub just issued.
    const d = deps(credential());
    const broker = createCopilotCredentialBroker(d);
    const result = await broker.tokenProvider({
      host: 'https://github.com',
      sessionId: 's',
      reason: 'refresh',
    });
    expect(result).toEqual({
      kind: 'token',
      accessToken: 'ghu_old',
      expiresIn: 5 * 60 * 60,
    });
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('rejects the provider call instead of handing the runtime a token under the threshold', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    d.refresh.mockRejectedValue(new Error('ECONNRESET'));
    const broker = createCopilotCredentialBroker(d);
    await expect(
      broker.tokenProvider({
        host: 'https://github.com',
        sessionId: 's',
        reason: 'initial',
      }),
    ).rejects.toThrow(
      "Couldn't refresh the Copilot sign-in. Check your connection and try again.",
    );
    // Per-call RPCs can still use the remaining half hour.
    await expect(broker.token(signal())).resolves.toBe('ghu_old');
  });

  it('refuses to hand the token to a different host', async () => {
    const d = deps(credential());
    const broker = createCopilotCredentialBroker(d);
    await expect(
      broker.tokenProvider({
        host: 'https://ghe.example.com',
        sessionId: 's',
        reason: 'initial',
      }),
    ).rejects.toThrow(
      'Copilot asked for a GitHub token for a different host than the connected account. Reconnect Copilot in Settings.',
    );
  });

  it('stops waiting when the caller is cancelled while a refresh is pending', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    d.refresh.mockImplementation(() => new Promise(() => undefined));
    const broker = createCopilotCredentialBroker(d);
    const controller = new AbortController();
    const pending = broker.token(controller.signal);
    controller.abort(new Error('caller left'));
    await expect(pending).rejects.toThrow('caller left');
  });

  it('clears the credential and reports expiry when GitHub rejects the refresh token', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    d.refresh.mockRejectedValueOnce(
      new DeviceFlowRefreshRejectedError('bad_refresh_token'),
    );
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).rejects.toBeInstanceOf(
      CopilotSignInExpiredError,
    );
    expect(d.clear).toHaveBeenCalledTimes(1);
    expect(d.clear).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: ENTRY, revision: 1 }),
    );
    await expect(d.read()).resolves.toEqual({ status: 'absent' });
  });

  it('keeps a still-valid token when the refresh fails for network reasons', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    d.refresh.mockRejectedValueOnce(new Error('ECONNRESET'));
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).resolves.toBe('ghu_old');
    expect(d.clear).not.toHaveBeenCalled();
  });

  it('fails when the refresh fails for network reasons and the token is already expired', async () => {
    const d = deps(
      credential({ accessTokenExpiresAt: new Date(NOW - 1).toISOString() }),
    );
    d.refresh.mockRejectedValueOnce(new Error('ECONNRESET'));
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).rejects.toThrow(
      "Couldn't refresh the Copilot sign-in. Check your connection and try again.",
    );
  });

  it('keeps serving a rotated grant that could not be saved and retries the write', async () => {
    // GitHub retired the old refresh token the moment it rotated; losing the
    // new one to a failed write would sign the user out for a disk hiccup.
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    d.save.mockRejectedValueOnce(new Error('disk full'));
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    expect(d.refresh).toHaveBeenCalledTimes(1);
    expect(d.save).toHaveBeenCalledTimes(2);
    expect(d.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ entryId: ENTRY, revision: 1 }),
      expect.objectContaining({ refreshToken: 'ghr_new' }),
    );
  });

  it('retries the save of a successor that landed before its save failed', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    const save = d.save.getMockImplementation();
    // The rename lands, then the directory sync fails.
    d.save.mockImplementationOnce(async (from, grant) => {
      await save?.(from, grant);
      throw new Error('EIO: directory sync failed');
    });
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    await expect(d.read()).resolves.toMatchObject({
      credential: { revision: 2, refreshToken: 'ghr_new' },
    });
    // D27: the successor stays in use while its save keeps failing.
    d.save.mockRejectedValueOnce(new Error('EIO: directory sync failed'));
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    expect(d.save).toHaveBeenCalledTimes(3);
    expect(d.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ entryId: ENTRY, revision: 1 }),
      expect.objectContaining({ refreshToken: 'ghr_new' }),
    );
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    expect(d.save).toHaveBeenCalledTimes(3);
    expect(d.refresh).toHaveBeenCalledTimes(1);
  });

  it('rereads the store when a landed successor is replaced before its retried save', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    const save = d.save.getMockImplementation();
    d.save.mockImplementationOnce(async (from, grant) => {
      await save?.(from, grant);
      throw new Error('EIO: directory sync failed');
    });
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    const reconnected = credential({
      accessToken: 'ghu_reconnected',
      refreshToken: 'ghr_reconnected',
      entryId: OTHER_ENTRY,
    });
    // Connect lands between the read of the successor and its retried save.
    d.save.mockImplementationOnce(async (from, grant) => {
      await d.replace(reconnected);
      return (await save?.(from, grant)) ?? { status: 'conflict' as const };
    });
    await expect(broker.token(signal())).resolves.toBe('ghu_reconnected');
    expect(d.save).toHaveBeenCalledTimes(2);
    await expect(broker.token(signal())).resolves.toBe('ghu_reconnected');
    expect(d.save).toHaveBeenCalledTimes(2);
  });

  it('discards a rotation when the credential was removed during the refresh', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    let finish: (grant: Awaited<ReturnType<Deps['refresh']>>) => void = () =>
      undefined;
    const refreshing = new Promise<void>((started) => {
      d.refresh.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
            started();
          }),
      );
    });
    const broker = createCopilotCredentialBroker(d);
    const pending = broker.token(signal());
    await refreshing;
    await d.disconnect();
    finish({
      accessToken: 'ghu_new',
      accessTokenExpiresAt: new Date(NOW + 8 * HOUR).toISOString(),
      refreshToken: 'ghr_new',
      refreshTokenExpiresAt: new Date(NOW + 200 * HOUR).toISOString(),
    });
    await expect(pending).rejects.toBeInstanceOf(CopilotSignInChangedError);
    expect(d.save).not.toHaveBeenCalled();
  });

  it('does not clear a replacement credential when a stale refresh is rejected', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    let fail: (error: Error) => void = () => undefined;
    const refreshing = new Promise<void>((started) => {
      d.refresh.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
            started();
          }),
      );
    });
    const broker = createCopilotCredentialBroker(d);
    const pending = broker.token(signal());
    await refreshing;
    await d.replace(
      credential({
        accessToken: 'ghu_other',
        refreshToken: 'ghr_other',
        entryId: OTHER_ENTRY,
      }),
    );
    fail(new DeviceFlowRefreshRejectedError('bad_refresh_token'));
    await expect(pending).rejects.toBeInstanceOf(CopilotSignInChangedError);
    expect(d.clear).not.toHaveBeenCalled();
  });

  it('T4: does not resurrect a grant cleared after the post-refresh check', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    const read = d.read.getMockImplementation();
    d.read.mockImplementation(() => {
      const result = read?.() ?? Promise.resolve({ status: 'absent' as const });
      // Disconnect lands once the check has read the grant, before the save.
      if (d.read.mock.calls.length === 2) void d.disconnect();
      return result;
    });
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).rejects.toBeInstanceOf(
      CopilotSignInChangedError,
    );
    expect(d.save).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: ENTRY, revision: 1 }),
      expect.objectContaining({ refreshToken: 'ghr_new' }),
    );
    d.read.mockImplementation(read);
    await expect(d.read()).resolves.toEqual({ status: 'absent' });
    // The discarded rotation is not served to the next caller either.
    await expect(broker.token(signal())).rejects.toBeInstanceOf(
      CopilotSignInExpiredError,
    );
    expect(d.refresh).toHaveBeenCalledTimes(1);
  });

  it('T4b: does not clear a grant that replaced the rejected one after the check', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    d.refresh.mockRejectedValueOnce(
      new DeviceFlowRefreshRejectedError('bad_refresh_token'),
    );
    const replacement = credential({
      accessToken: 'ghu_other',
      refreshToken: 'ghr_other',
      entryId: OTHER_ENTRY,
    });
    const read = d.read.getMockImplementation();
    d.read.mockImplementation(() => {
      const result = read?.() ?? Promise.resolve({ status: 'absent' as const });
      // Connect lands once the check has read the grant, before the clear.
      if (d.read.mock.calls.length === 2) void d.replace(replacement);
      return result;
    });
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).rejects.toBeInstanceOf(
      CopilotSignInChangedError,
    );
    expect(d.clear).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: ENTRY, revision: 1 }),
    );
    d.read.mockImplementation(read);
    await expect(d.read()).resolves.toEqual({
      status: 'present',
      credential: replacement,
    });
  });

  it('T4b: does not clear a later revision of the rejected entry', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    d.refresh.mockRejectedValueOnce(
      new DeviceFlowRefreshRejectedError('bad_refresh_token'),
    );
    const successor = credential({ refreshToken: 'ghr_next', revision: 2 });
    const read = d.read.getMockImplementation();
    d.read.mockImplementation(() => {
      const result = read?.() ?? Promise.resolve({ status: 'absent' as const });
      if (d.read.mock.calls.length === 2) void d.replace(successor);
      return result;
    });
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).rejects.toBeInstanceOf(
      CopilotSignInChangedError,
    );
    d.read.mockImplementation(read);
    await expect(d.read()).resolves.toEqual({
      status: 'present',
      credential: successor,
    });
  });

  it('reports unreadability found by the rejection clear without clearing', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    d.refresh.mockRejectedValueOnce(
      new DeviceFlowRefreshRejectedError('bad_refresh_token'),
    );
    d.clear.mockResolvedValueOnce({ status: 'unreadable' });
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).rejects.toBeInstanceOf(
      CopilotCredentialUnreadableError,
    );
    await expect(d.read()).resolves.toMatchObject({ status: 'present' });
  });

  it('uses a received successor while its save cannot read the store, then saves it', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    d.save.mockResolvedValueOnce({ status: 'unreadable' });
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    expect(d.refresh).toHaveBeenCalledTimes(1);
    expect(d.save).toHaveBeenCalledTimes(2);
    await expect(d.read()).resolves.toMatchObject({
      credential: { revision: 2, refreshToken: 'ghr_new' },
    });
  });

  it('drops an unsaved successor whose retried save finds the grant gone', async () => {
    const old = credential({
      accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
    });
    const d = deps(old);
    d.save.mockRejectedValueOnce(new Error('disk full'));
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    await d.disconnect();
    // A stale read still shows the old grant; the save must not recreate it.
    d.read.mockResolvedValueOnce({ status: 'present', credential: old });
    await expect(broker.token(signal())).rejects.toBeInstanceOf(
      CopilotSignInChangedError,
    );
    await expect(d.read()).resolves.toEqual({ status: 'absent' });
    expect(d.refresh).toHaveBeenCalledTimes(1);
  });

  it('drops an unsaved successor once Disconnect and Connect replace its entry', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    d.save.mockRejectedValueOnce(new Error('disk full'));
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    await d.disconnect();
    const reconnected = credential({
      accessToken: 'ghu_reconnected',
      refreshToken: 'ghr_reconnected',
      entryId: OTHER_ENTRY,
    });
    await d.replace(reconnected);
    await expect(broker.token(signal())).resolves.toBe('ghu_reconnected');
    await expect(d.read()).resolves.toEqual({
      status: 'present',
      credential: reconnected,
    });
    expect(d.save).toHaveBeenCalledTimes(1);
    expect(d.refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps serving a saved rotation to a caller that read its revision', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    expect(d.refresh).toHaveBeenCalledTimes(1);
    expect(d.save).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the stored identity does not match the pin', async () => {
    const d = deps(credential({ login: 'someone-else' }));
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).rejects.toBeInstanceOf(
      CopilotSignInChangedError,
    );
  });

  it('reports absent and unreadable credentials distinctly', async () => {
    const absent = createCopilotCredentialBroker(deps(null));
    await expect(absent.token(signal())).rejects.toBeInstanceOf(
      CopilotSignInExpiredError,
    );
    const d = deps(credential());
    d.read.mockResolvedValueOnce({ status: 'unreadable' });
    const unreadable = createCopilotCredentialBroker(d);
    await expect(unreadable.token(signal())).rejects.toBeInstanceOf(
      CopilotCredentialUnreadableError,
    );
  });

  it('passes a read failure through to the provider result', async () => {
    const d = deps(credential());
    const broker = createCopilotCredentialBroker(d);
    d.read.mockRejectedValueOnce(new Error('aborted'));
    await expect(
      broker.tokenProvider({ host: 'https://github.com', reason: 'initial' }),
    ).rejects.toThrow('aborted');
  });
  it('passes typed unreadability through without clearing the grant', async () => {
    const d = deps(credential());
    const secureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_DECRYPT_FAILED',
      operation: 'read',
      state: 'locked',
      backend: 'gnome_libsecret',
      retryable: true,
    } as const;
    d.read.mockResolvedValueOnce({
      status: 'unreadable',
      secureStorageFailure,
    });
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).rejects.toMatchObject({
      secureStorageFailure,
    });
    expect(d.clear).not.toHaveBeenCalled();
  });
  it('retains a successfully rotated grant across an unreadable post-refresh check', async () => {
    const old = credential({
      accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
    });
    const d = deps(old);
    const secureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_DECRYPT_FAILED',
      operation: 'read',
      state: 'locked',
      backend: 'gnome_libsecret',
      retryable: true,
    } as const;
    d.read
      .mockResolvedValueOnce({ status: 'present', credential: old })
      .mockResolvedValueOnce({ status: 'unreadable', secureStorageFailure });
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).rejects.toMatchObject({
      name: 'CopilotCredentialUnreadableError',
      secureStorageFailure,
    });
    expect(d.clear).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    expect(d.refresh).toHaveBeenCalledTimes(1);
    expect(d.save).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: ENTRY, revision: 1 }),
      expect.objectContaining({ refreshToken: 'ghr_new' }),
    );
    expect(d.clear).not.toHaveBeenCalled();
  });
});

describe('Copilot broker quiescence', () => {
  it('fences new reads immediately, including when there is no in-flight work', async () => {
    const d = deps(credential());
    const broker = createCopilotCredentialBroker(d);
    await broker.quiesce();
    await expect(broker.token(signal())).rejects.toBeInstanceOf(
      CopilotSignInChangedError,
    );
    await expect(
      broker.tokenProvider({ host: 'github.com', reason: 'refresh' }),
    ).rejects.toBeInstanceOf(CopilotSignInChangedError);
    expect(d.read).not.toHaveBeenCalled();
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('waits for a stalled durable save and does not present again', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    let release: () => void = () => undefined;
    let saving: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      saving = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = d.save.getMockImplementation();
    if (!save) throw new Error('missing save fake');
    d.save.mockImplementation(async (from, grant) => {
      saving();
      await gate;
      return save(from, grant);
    });
    const broker = createCopilotCredentialBroker(d);
    const token = broker.token(signal());
    await entered;
    let settled = false;
    const drain = broker.quiesce().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(broker.token(signal())).rejects.toBeInstanceOf(
      CopilotSignInChangedError,
    );
    release();
    await expect(token).resolves.toBe('ghu_new');
    await drain;
    expect(d.save).toHaveBeenCalledTimes(1);
    expect(d.refresh).toHaveBeenCalledTimes(1);
  });

  it('joins repeated drains and retries one unsaved successor, without refreshing', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    d.save.mockRejectedValueOnce(new Error('disk full'));
    const broker = createCopilotCredentialBroker(d);
    await expect(broker.token(signal())).resolves.toBe('ghu_new');
    await Promise.all([broker.quiesce(), broker.quiesce()]);
    expect(d.refresh).toHaveBeenCalledTimes(1);
    expect(d.save).toHaveBeenCalledTimes(2);
    expect(d.clear).not.toHaveBeenCalled();
  });

  it('fences lease access and waits for a rotation admitted before the fence', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    let answer: () => void = () => undefined;
    const refresh = d.refresh.getMockImplementation();
    if (!refresh) throw new Error('missing refresh fake');
    d.refresh.mockImplementationOnce(async (token, refreshSignal) => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return refresh(token, refreshSignal);
    });
    const broker = createCopilotCredentialBroker(d);
    const admit = jest.fn(() => Promise.resolve());
    const access = broker.access(signal(), admit);
    await until(() => d.refresh.mock.calls.length === 1);
    let settled = false;
    const drain = broker.quiesce().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(broker.access(signal(), admit)).rejects.toBeInstanceOf(
      CopilotSignInChangedError,
    );
    expect(admit).toHaveBeenCalledTimes(1);
    answer();
    await drain;
    await expect(access).resolves.toMatchObject({ accessToken: 'ghu_new' });
    expect(d.save).toHaveBeenCalledTimes(1);
    expect(d.refresh).toHaveBeenCalledTimes(1);
  });

  it('a refused admission ends the demand before any presentation', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    const broker = createCopilotCredentialBroker(d);
    await expect(
      broker.access(signal(), () =>
        Promise.reject(new Error('Copilot connection was revoked.')),
      ),
    ).rejects.toThrow('Copilot connection was revoked.');
    await broker.quiesce();
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('a caller cancelled during admission never starts a refresh', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    const broker = createCopilotCredentialBroker(d);
    let admitted: () => void = () => undefined;
    let entered = false;
    const caller = new AbortController();
    const access = broker.access(caller.signal, () => {
      entered = true;
      return new Promise<void>((resolve) => {
        admitted = resolve;
      });
    });
    await until(() => entered);
    caller.abort(new Error('caller left'));
    await expect(access).rejects.toThrow('caller left');
    admitted();
    await broker.quiesce();
    expect(d.refresh).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
  });
});

test('a failed Disconnect cannot reopen admission once quit has fenced the authority', async () => {
  const broker = createCopilotCredentialBroker(deps(credential()));
  await broker.quiesce();
  await broker.quiesce(true);
  broker.resume();
  await expect(broker.token(signal())).rejects.toBeInstanceOf(
    CopilotSignInChangedError,
  );
});

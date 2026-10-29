import { DeviceFlowRefreshRejectedError } from '@canopy/desktop-shared/node/copilot/device-flow';
import {
  CopilotCredentialUnreadableError,
  CopilotSignInChangedError,
  CopilotSignInExpiredError,
  createCopilotCredentialBroker,
  type CopilotCredentialBrokerDeps,
} from '../copilot/credential-broker';
import type {
  CopilotCredential,
  CopilotCredentialRead,
} from '../copilot/credential-store';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-05T00:00:00.000Z');
const pin = { host: 'https://github.com', login: 'octocat' };

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
    ...overrides,
  };
}

interface Deps extends CopilotCredentialBrokerDeps {
  read: jest.Mock<Promise<CopilotCredentialRead>, []>;
  save: jest.Mock<Promise<void>, [CopilotCredential]>;
  clear: jest.Mock<Promise<void>, []>;
  refresh: jest.Mock<
    ReturnType<CopilotCredentialBrokerDeps['refresh']>,
    Parameters<CopilotCredentialBrokerDeps['refresh']>
  >;
}

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
    save: jest.fn((next: CopilotCredential): Promise<void> => {
      state.stored = next;
      return Promise.resolve();
    }),
    clear: jest.fn((): Promise<void> => {
      state.stored = null;
      return Promise.resolve();
    }),
    refresh: jest.fn(() =>
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
      expect.objectContaining({
        accessToken: 'ghu_new',
        refreshToken: 'ghr_new',
        login: 'octocat',
      }),
    );
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
      expect.objectContaining({ refreshToken: 'ghr_new' }),
    );
  });

  it('discards a rotation when the credential was removed during the refresh', async () => {
    const d = deps(
      credential({
        accessTokenExpiresAt: new Date(NOW + HOUR / 2).toISOString(),
      }),
    );
    let finish: (grant: Awaited<ReturnType<Deps['refresh']>>) => void = () =>
      undefined;
    d.refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const broker = createCopilotCredentialBroker(d);
    const pending = broker.token(signal());
    await Promise.resolve();
    await d.clear();
    d.clear.mockClear();
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
    d.refresh.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const broker = createCopilotCredentialBroker(d);
    const pending = broker.token(signal());
    await Promise.resolve();
    await d.save(
      credential({ accessToken: 'ghu_other', refreshToken: 'ghr_other' }),
    );
    d.save.mockClear();
    fail(new DeviceFlowRefreshRejectedError('bad_refresh_token'));
    await expect(pending).rejects.toBeInstanceOf(CopilotSignInChangedError);
    expect(d.clear).not.toHaveBeenCalled();
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
      expect.objectContaining({ refreshToken: 'ghr_new' }),
    );
    expect(d.clear).not.toHaveBeenCalled();
  });
});

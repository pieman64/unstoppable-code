import { CopilotRecipient } from '../copilot/recipient';
import {
  CopilotCredentialUnreadableError,
  CopilotSignInChangedError,
  CopilotSignInExpiredError,
} from '../copilot/credential-broker';

const epoch = { host: 'https://github.com', id: '1', entryId: 'entry' };
const identity = { runtimeId: 'runtime', pid: 123, started: 1 };
const signal = (): AbortSignal => new AbortController().signal;
interface Fixture {
  recipient: CopilotRecipient;
  access: jest.Mock<Promise<{ accessToken: string; expiresAt: number }>, []>;
  binding: jest.Mock<Promise<typeof epoch>, []>;
  expire(): void;
  advance(ms: number): void;
  revoke(): void;
  close(): void;
  change(): void;
}
function fixture(): Fixture {
  let time = 10;
  let generation = 1;
  let binding = { ...epoch };
  let closed = false;
  const access = jest.fn(
    (): Promise<{ accessToken: string; expiresAt: number }> =>
      Promise.resolve({
        accessToken: 'synthetic',
        expiresAt: Date.now() + 8 * 3_600_000,
      }),
  );
  const readBinding = jest.fn(() => Promise.resolve(binding));
  const recipient = new CopilotRecipient({
    accountEpoch: epoch,
    generation: 1,
    recipient: identity,
    signal: signal(),
    binding: readBinding,
    access,
    assertGeneration: (expected): void => {
      if (expected !== generation) throw new Error('revoked');
    },
    isClosed: (): boolean => closed,
    now: (): number => time,
  });
  return {
    recipient,
    access,
    binding: readBinding,
    advance: (ms): void => {
      time += ms;
    },
    expire: (): void => {
      time += 8 * 3_600_000;
    },
    revoke: (): void => {
      generation++;
    },
    close: (): void => {
      closed = true;
    },
    change: (): void => {
      binding = { ...epoch, entryId: 'replacement' };
    },
  };
}
const request = {
  host: epoch.host,
  sessionId: 'session',
  reason: 'initial' as const,
};

describe('recipient admission (§3, D26)', () => {
  describe.each([
    new CopilotCredentialUnreadableError({
      version: 1,
      code: 'SECURE_STORAGE_READ_UNAVAILABLE',
      operation: 'read',
      state: 'locked',
      backend: 'keychain',
      retryable: true,
    }),
    new CopilotSignInExpiredError(),
  ])('binding failure %s', (failure) => {
    it.each([
      ['session', 'before'],
      ['session', 'after'],
      ['session', 'result'],
      ['models', 'before'],
      ['models', 'after'],
      ['models', 'result'],
    ] as const)(
      'preserves the error for %s admission %s delivery',
      async (purpose, stage) => {
        const f = fixture();
        const lease = f.recipient.issue(purpose);
        const deliver = (): Promise<unknown> =>
          purpose === 'session'
            ? Promise.resolve(lease.tokenProvider(request))
            : lease.token(signal());
        if (stage === 'result') await deliver();
        if (stage === 'after') f.binding.mockResolvedValueOnce(epoch);
        f.binding.mockRejectedValueOnce(failure);
        await expect(
          stage === 'result' ? f.recipient.admit(lease, purpose) : deliver(),
        ).rejects.toBe(failure);
        expect(f.access).toHaveBeenCalledTimes(stage === 'before' ? 0 : 1);
      },
    );

    it.each(['revoke', 'close', 'cancel'] as const)(
      'still prioritizes %s during a failed binding read',
      async (action) => {
        const f = fixture();
        const abort = new AbortController();
        const cancelled = new Error('cancelled during failed binding read');
        f.binding.mockImplementationOnce(() => {
          if (action === 'cancel') abort.abort(cancelled);
          else f[action]();
          return Promise.reject(failure);
        });
        const pending = f.recipient.issue('models').token(abort.signal);
        if (action === 'cancel') await expect(pending).rejects.toBe(cancelled);
        else
          await expect(pending).rejects.toMatchObject({ constructor: Error });
        expect(f.access).not.toHaveBeenCalled();
      },
    );
  });

  it('reports a retired authority epoch as plain revocation', async () => {
    const f = fixture();
    f.binding.mockRejectedValueOnce(new CopilotSignInChangedError());
    await expect(
      f.recipient.issue('models').token(signal()),
    ).rejects.toMatchObject({
      constructor: Error,
      message: 'Copilot connection was revoked.',
    });
    expect(f.access).not.toHaveBeenCalled();
  });

  it.each(['migration', '', 'SESSION', 'unknown'])(
    'refuses purpose %p without presentation',
    (purpose) => {
      const f = fixture();
      expect(() => f.recipient.issue(purpose)).toThrow();
      expect(f.access).not.toHaveBeenCalled();
    },
  );
  it('refuses forged and cross-recipient leases', async () => {
    const f = fixture();
    const lease = f.recipient.issue('session');
    await expect(f.recipient.admit({ ...lease }, 'session')).rejects.toThrow();
    await expect(fixture().recipient.admit(lease, 'session')).rejects.toThrow();
    expect(f.access).not.toHaveBeenCalled();
  });
  it.each(['session', 'models', 'quota', 'thinking-levels', 'setup-probe'])(
    'admits allowed purpose %s and refuses a changed purpose',
    async (purpose) => {
      const f = fixture();
      const lease = f.recipient.issue(purpose);
      await expect(f.recipient.admit(lease, purpose)).resolves.toBeUndefined();
      await expect(f.recipient.admit(lease, 'migration')).rejects.toThrow();
    },
  );
  it.each(['revoke', 'close', 'change', 'expire'] as const)(
    'refuses %s before presentation',
    async (action) => {
      const f = fixture();
      const lease = f.recipient.issue('session');
      f[action]();
      await expect(lease.token(signal())).rejects.toThrow();
      expect(f.access).not.toHaveBeenCalled();
    },
  );
  it('prebinds resume and checks host and audience before presenting', async () => {
    const f = fixture();
    const lease = f.recipient.issue('session', 'session');
    await expect(
      lease.tokenProvider({ ...request, sessionId: 'other' }),
    ).rejects.toThrow();
    await expect(
      lease.tokenProvider({ ...request, host: 'https://other.ghe.com' }),
    ).rejects.toThrow();
    await expect(
      lease.tokenProvider({ host: epoch.host, reason: 'initial' }),
    ).rejects.toThrow();
    expect(f.access).not.toHaveBeenCalled();
    await expect(lease.tokenProvider(request)).resolves.toMatchObject({
      accessToken: 'synthetic',
    });
  });
  it('adopts the first create audience and never accepts a second id', async () => {
    const f = fixture();
    const lease = f.recipient.issue('session');
    await lease.tokenProvider(request);
    expect(lease.audience).toBe('session');
    await expect(
      lease.tokenProvider({ ...request, sessionId: 'other' }),
    ).rejects.toThrow();
    expect(f.access).toHaveBeenCalledTimes(1);
  });
  it('rejects stale delivery after presentation with a plain Error', async () => {
    const f = fixture();
    const lease = f.recipient.issue('session');
    f.access.mockImplementation(
      (): Promise<{ accessToken: string; expiresAt: number }> => {
        f.revoke();
        return Promise.resolve({
          accessToken: 'synthetic',
          expiresAt: Date.now() + 8 * 3_600_000,
        });
      },
    );
    await expect(lease.tokenProvider(request)).rejects.toEqual(
      expect.any(Error),
    );
    try {
      await lease.token(signal());
    } catch (error) {
      expect(error?.constructor).toBe(Error);
    }
    expect(f.access).toHaveBeenCalledTimes(1);
  });
  it('bounds the deadline at token expiry despite a wall-clock reversal', async () => {
    const wall = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(wall);
    try {
      const f = fixture();
      f.access.mockResolvedValue({
        accessToken: 'synthetic',
        expiresAt: wall + 1_000,
      });
      const lease = f.recipient.issue('models');
      await lease.token(signal());
      expect(lease.expiry).toBe(1_010);
      f.advance(999);
      await expect(f.recipient.admit(lease, 'models')).resolves.toBeUndefined();
      clock.mockReturnValue(wall - 60_000);
      f.advance(1);
      await expect(f.recipient.admit(lease, 'models')).rejects.toThrow();
    } finally {
      clock.mockRestore();
    }
  });
  it.each([NaN, Infinity, -1])(
    'refuses invalid or expired token deadline %s',
    async (expiresAt) => {
      const f = fixture();
      f.access.mockResolvedValue({ accessToken: 'synthetic', expiresAt });
      await expect(
        f.recipient.issue('models').token(signal()),
      ).rejects.toThrow();
    },
  );
  it('push tokens are one-shot operation keys, never session callbacks', async () => {
    const f = fixture();
    const lease = f.recipient.issue('quota');
    await lease.token(signal());
    await expect(lease.token(signal())).rejects.toThrow();
    await expect(lease.tokenProvider(request)).rejects.toThrow();
    expect(f.access).toHaveBeenCalledTimes(1);
  });

  it('refuses cancellation during the final asynchronous binding read', async () => {
    const f = fixture();
    const requestAbort = new AbortController();
    const cancelled = new Error('operation cancelled during admission');
    f.binding.mockImplementationOnce(() => Promise.resolve(epoch));
    f.binding.mockImplementationOnce(() => {
      requestAbort.abort(cancelled);
      return Promise.resolve(epoch);
    });
    await expect(
      f.recipient.issue('models').token(requestAbort.signal),
    ).rejects.toBe(cancelled);
    expect(f.access).toHaveBeenCalledTimes(1);
    expect(f.binding).toHaveBeenCalledTimes(2);
  });

  it('does not wait for a stalled binding read after request cancellation', async () => {
    const f = fixture();
    const requestAbort = new AbortController();
    const cancelled = new Error('operation cancelled during admission');
    let releaseBinding: (value: typeof epoch) => void = () => undefined;
    const bindingRead = new Promise<typeof epoch>((resolve) => {
      releaseBinding = resolve;
    });
    let reading: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    f.binding.mockImplementationOnce(() => Promise.resolve(epoch));
    f.binding.mockImplementationOnce(() => {
      reading();
      return bindingRead;
    });
    let result: unknown = 'pending';
    const pending = f.recipient.issue('models').token(requestAbort.signal);
    void pending.then(
      (token) => {
        result = token;
      },
      (error: unknown) => {
        result = error;
      },
    );
    try {
      await started;
      requestAbort.abort(cancelled);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(result).toBe(cancelled);
    } finally {
      releaseBinding(epoch);
      await pending.catch(() => undefined);
    }
  });

  it.each(['revoke', 'close', 'change', 'expire'] as const)(
    'rechecks %s across the final asynchronous binding read',
    async (action) => {
      const f = fixture();
      f.binding.mockImplementationOnce(() => Promise.resolve(epoch));
      f.binding.mockImplementationOnce(() => {
        f[action]();
        return Promise.resolve(
          action === 'change' ? { ...epoch, entryId: 'replacement' } : epoch,
        );
      });
      await expect(
        f.recipient.issue('models').token(signal()),
      ).rejects.toThrow();
      expect(f.access).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { ...epoch, host: 'https://elsewhere.example' },
    { ...epoch, id: '2' },
    { ...epoch, entryId: 'replacement' },
  ])(
    'refuses the changed account epoch %p before presentation',
    async (binding) => {
      const f = fixture();
      f.binding.mockResolvedValue(binding);
      await expect(
        f.recipient.issue('models').token(signal()),
      ).rejects.toThrow();
      expect(f.access).not.toHaveBeenCalled();
    },
  );

  it('keeps concurrent push requests one-shot', async () => {
    const f = fixture();
    const lease = f.recipient.issue('quota');
    const results = await Promise.allSettled([
      lease.token(signal()),
      lease.token(signal()),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(f.access).toHaveBeenCalledTimes(1);
  });

  it('adopts only one audience across concurrent create callbacks', async () => {
    const f = fixture();
    const lease = f.recipient.issue('session');
    const first = lease.tokenProvider(request);
    await expect(
      lease.tokenProvider({ ...request, sessionId: 'other' }),
    ).rejects.toThrow();
    await expect(first).resolves.toMatchObject({ accessToken: 'synthetic' });
    expect(f.access).toHaveBeenCalledTimes(1);
  });
});

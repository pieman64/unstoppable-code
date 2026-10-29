const mockActiveCount = jest.fn(() => 0);
const mockRelease = jest.fn();
const mockPause = jest.fn(() => ({
  paused: Promise.resolve(0),
  release: mockRelease,
}));
const mockSession = {
  ready: Promise.resolve(),
  start: jest.fn(() =>
    Promise.resolve({
      type: 'chatgpt',
      loginId: 'login',
      authUrl: 'https://auth.openai.com/authorize',
    }),
  ),
  retireLogin: jest.fn(async () => {}),
  verifyAccount: jest.fn(() => Promise.resolve({})),
  close: jest.fn(async () => {}),
  resetLogin: jest.fn(async () => {}),
};
const mockBegin = jest.fn(() => mockSession);
const mockVerifiedStatus = jest.fn(() => ({
  authenticated: true,
  accountLabel: 'current@example.test',
  authFingerprint: 'current',
}));
const mockCommit = jest.fn(
  (status: {
    authenticated: boolean;
    accountLabel: string;
    authFingerprint: string;
  }) => status,
);
const mockCheckCodexAuthStatus = jest.fn(() =>
  Promise.resolve({
    authenticated: true,
    accountLabel: 'current@example.test',
    authFingerprint: 'current',
  }),
);
const mockFingerprint = jest.fn(() => 'current');
const mockRecordAuthenticationGrant = jest.fn().mockResolvedValue(undefined);
const mockRevokeAuthenticationGrant = jest.fn().mockResolvedValue(undefined);
const mockHasAuthenticationGrant = jest.fn().mockResolvedValue(true);
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn().mockReturnValue({
    beginAuthentication: mockBegin,
    admin: jest.fn().mockReturnValue({
      getResourceSnapshots: jest.fn().mockReturnValue([]),
    }),
  }),
}));
jest.mock('../agents/session-manager', () => ({
  getCodexAuthenticationActiveWorkCount: mockActiveCount,
  pauseCodexSessionsForAuthentication: mockPause,
}));
jest.mock('../pipelines/pipeline-execution-registry', () => ({
  getActivePipelineExecutionHandles: jest.fn().mockReturnValue([]),
}));
jest.mock('../auth/provider-auth-state', () => ({
  verifiedCodexAccountStatus: mockVerifiedStatus,
  commitVerifiedCodexAccount: mockCommit,
  checkCodexAuthStatus: mockCheckCodexAuthStatus,
  fingerprintCodexRecoveryIdentity: mockFingerprint,
}));
jest.mock('../lib/usage-limited-chats-registry', () => ({
  recordCodexAuthenticationGrant: mockRecordAuthenticationGrant,
  revokeCodexAuthenticationGrant: mockRevokeAuthenticationGrant,
  hasCodexAuthenticationGrant: mockHasAuthenticationGrant,
}));
import { CodexLoginManager, assertCodexLoginUrl } from '../auth/codex-login';

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockActiveCount.mockReturnValue(0);
  mockHasAuthenticationGrant.mockResolvedValue(false);
});

test('persists the verified account fingerprint for durable recovery', async () => {
  mockActiveCount.mockReturnValue(1);
  mockPause.mockReturnValueOnce({
    paused: Promise.resolve(1),
    release: mockRelease,
  });
  const manager = new CodexLoginManager();
  manager.start({ confirmPause: true, method: 'chatgpt' });
  await flush();
  await manager.finish('success');

  expect(mockRecordAuthenticationGrant).toHaveBeenCalledWith(
    expect.any(String),
    'current',
  );
});

test('never publishes the private browser authorization URL', async () => {
  const manager = new CodexLoginManager();
  const states: unknown[] = [];
  manager.onState((state) => states.push(state));
  manager.start({ confirmPause: true, method: 'chatgpt' });
  await flush();
  expect(states).toContainEqual(expect.objectContaining({ phase: 'waiting' }));
  expect(JSON.stringify(states)).not.toContain('auth.openai.com');
  expect(manager.browserUrl()).toBe('https://auth.openai.com/authorize');
});

test('authorizes a persisted attempt after manager reconstruction when the account still matches', async () => {
  const manager = new CodexLoginManager();
  mockHasAuthenticationGrant.mockResolvedValue(true);

  await expect(
    manager.assertResumeAllowed('00000000-0000-4000-8000-000000000000'),
  ).resolves.toBeUndefined();
  expect(mockCheckCodexAuthStatus).toHaveBeenCalledTimes(1);
  expect(mockHasAuthenticationGrant).toHaveBeenCalledWith(
    '00000000-0000-4000-8000-000000000000',
    'current',
  );
});

test('the active-work warning starts neither authentication nor interruption', () => {
  mockActiveCount.mockReturnValue(2);
  const manager = new CodexLoginManager();
  expect(
    manager.start({ confirmPause: false, method: 'chatgpt' }),
  ).toMatchObject({ phase: 'confirm', activeWorkCount: 2 });
  expect(mockBegin).not.toHaveBeenCalled();
  expect(mockPause).not.toHaveBeenCalled();
});

test('returns to confirmation and grants recovery when pausing discovers work late', async () => {
  mockPause.mockReturnValueOnce({
    paused: Promise.resolve(1),
    release: mockRelease,
  });
  const manager = new CodexLoginManager();

  manager.start({ confirmPause: false, method: 'chatgpt' });
  await flush();
  expect(mockSession.start).not.toHaveBeenCalled();
  expect(
    manager.start({ confirmPause: false, method: 'chatgpt' }),
  ).toMatchObject({ phase: 'confirm', activeWorkCount: 1 });

  manager.start({ confirmPause: true, method: 'chatgpt' });
  await flush();
  expect(mockSession.start).toHaveBeenCalledTimes(1);
  await manager.finish('success');
  expect(mockRecordAuthenticationGrant).toHaveBeenCalledWith(
    expect.any(String),
    'current',
  );
});

test.each(['success', 'cancelled', 'failed'])(
  'reconciles %s with a fresh account and never resumes work itself',
  async (outcome) => {
    if (
      outcome !== 'success' &&
      outcome !== 'cancelled' &&
      outcome !== 'failed'
    )
      throw new Error('Unexpected outcome');
    const manager = new CodexLoginManager();
    mockActiveCount.mockReturnValue(1);
    const state = manager.start({ confirmPause: true, method: 'chatgpt' });
    expect(state.phase).toBe('pausing');
    await flush();
    const settled = await manager.finish(outcome);
    expect(settled).toMatchObject({
      phase: 'complete',
      outcome,
      account: { accountLabel: 'current@example.test' },
    });
    expect(mockSession.retireLogin).toHaveBeenCalled();
    expect(mockSession.verifyAccount).toHaveBeenCalledTimes(1);
    expect(mockSession.close).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    mockHasAuthenticationGrant.mockImplementation((attemptId, fingerprint) =>
      Promise.resolve(
        attemptId === state.attemptId && fingerprint === 'current',
      ),
    );
    await expect(
      manager.assertResumeAllowed(state.attemptId ?? ''),
    ).resolves.toBeUndefined();
    await expect(
      manager.assertResumeAllowed('other-attempt'),
    ).rejects.toThrow();
  },
);

test('verification failure holds admission and disables resume until retry succeeds', async () => {
  mockSession.verifyAccount.mockRejectedValueOnce(new Error('probe failed'));
  const manager = new CodexLoginManager();
  const state = manager.start({ confirmPause: true, method: 'chatgpt' });
  await flush();
  expect(await manager.finish('cancelled')).toMatchObject({
    phase: 'verification-failed',
  });
  expect(mockRelease).not.toHaveBeenCalled();
  await expect(
    manager.assertResumeAllowed(state.attemptId ?? ''),
  ).rejects.toThrow();
  expect(await manager.retryVerification()).toMatchObject({
    phase: 'complete',
  });
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test('explicit cancel after verification failure abandons the attempt and releases admission', async () => {
  mockSession.verifyAccount.mockRejectedValueOnce(new Error('probe failed'));
  const manager = new CodexLoginManager();
  manager.start({ confirmPause: true, method: 'chatgpt' });
  await flush();
  expect(await manager.finish('success')).toMatchObject({
    phase: 'verification-failed',
  });

  expect(await manager.finish('cancelled')).toMatchObject({
    phase: 'complete',
    outcome: 'cancelled',
  });
  expect(mockSession.close).toHaveBeenCalledTimes(1);
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test('failed cancellation cleanup keeps the attempt retryable and admission closed', async () => {
  mockSession.verifyAccount.mockRejectedValueOnce(new Error('probe failed'));
  mockSession.close.mockRejectedValueOnce(new Error('worker still alive'));
  const manager = new CodexLoginManager();
  manager.start({ confirmPause: true, method: 'chatgpt' });
  await flush();
  await manager.finish('success');

  expect(await manager.finish('cancelled')).toMatchObject({
    phase: 'verification-failed',
  });
  expect(mockRelease).not.toHaveBeenCalled();

  expect(await manager.finish('cancelled')).toMatchObject({
    phase: 'complete',
    outcome: 'cancelled',
  });
  expect(mockSession.close).toHaveBeenCalledTimes(2);
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test('accepts only the managed HTTPS sign-in origin', () => {
  expect(() =>
    assertCodexLoginUrl('https://auth.openai.com/codex/device'),
  ).not.toThrow();
  for (const value of [
    'file:///tmp/a',
    'https://auth.openai.com.evil.test',
    'https://user:secret@auth.openai.com',
    'http://auth.openai.com',
  ])
    expect(() => assertCodexLoginUrl(value)).toThrow();
});

test('a pause failure never starts login and still verifies existing credentials', async () => {
  mockPause.mockReturnValueOnce({
    paused: Promise.reject(new Error('checkpoint failed')),
    release: mockRelease,
  });
  const manager = new CodexLoginManager();
  manager.start({ confirmPause: true, method: 'chatgpt' });
  await flush();
  expect(mockSession.start).not.toHaveBeenCalled();
  expect(mockSession.verifyAccount).toHaveBeenCalledTimes(1);
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test('a worker drain failure never starts login and still releases admission', async () => {
  const settledReady = mockSession.ready;
  const failedReady = Promise.reject(new Error('drain timed out'));
  void failedReady.catch(() => undefined);
  mockSession.ready = failedReady;
  try {
    const manager = new CodexLoginManager();
    const states: unknown[] = [];
    manager.onState((state) => states.push(state));
    manager.start({ confirmPause: true, method: 'chatgpt' });
    await flush();
    expect(mockSession.start).not.toHaveBeenCalled();
    expect(mockSession.verifyAccount).toHaveBeenCalledTimes(1);
    expect(mockSession.close).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(states).toContainEqual(
      expect.objectContaining({ phase: 'complete', outcome: 'failed' }),
    );
  } finally {
    mockSession.ready = settledReady;
  }
});

test('a synchronous pause reservation failure closes the runtime auth session', async () => {
  mockPause.mockImplementationOnce(() => {
    throw new Error('another authentication gate is active');
  });
  const manager = new CodexLoginManager();

  expect(() =>
    manager.start({ confirmPause: true, method: 'chatgpt' }),
  ).toThrow('another authentication gate is active');
  await flush();
  expect(mockSession.close).toHaveBeenCalledTimes(1);
});

test('rejects recovery when no durable grant matches the verified account', async () => {
  mockActiveCount.mockReturnValue(1);
  const manager = new CodexLoginManager();
  const state = manager.start({ confirmPause: true, method: 'chatgpt' });
  await flush();
  await manager.finish('success');

  await expect(
    manager.assertResumeAllowed(state.attemptId ?? ''),
  ).rejects.toThrow('same Codex account');
});

test('freshly revalidates the verified account before every resume', async () => {
  const manager = new CodexLoginManager();
  const state = manager.start({ confirmPause: true, method: 'chatgpt' });
  await flush();
  await manager.finish('success');
  mockCheckCodexAuthStatus.mockResolvedValueOnce({
    authenticated: true,
    accountLabel: 'switched@example.test',
    authFingerprint: 'switched',
  });
  mockFingerprint.mockReturnValueOnce('switched');
  mockHasAuthenticationGrant.mockResolvedValueOnce(false);

  await expect(
    manager.assertResumeAllowed(state.attemptId ?? ''),
  ).rejects.toThrow('same Codex account');
  expect(mockCheckCodexAuthStatus).toHaveBeenCalledTimes(1);
});

test('cancel interrupts verification and ignores its late result', async () => {
  let completeRead: ((value: object) => void) | undefined;
  mockSession.verifyAccount.mockReturnValueOnce(
    new Promise((resolve) => {
      completeRead = resolve;
    }),
  );
  const manager = new CodexLoginManager();
  const states: Array<{ phase: string }> = [];
  manager.onState((state) => states.push(state));
  manager.start({ confirmPause: true, method: 'chatgpt' });
  await flush();
  const verifying = manager.finish('success');
  await flush();
  const cancelled = manager.finish('cancelled');
  await flush();
  expect(mockSession.close).toHaveBeenCalledTimes(1);
  expect(await cancelled).toMatchObject({
    phase: 'complete',
    outcome: 'cancelled',
    account: undefined,
  });
  if (!completeRead) throw new Error('Account read did not start');
  completeRead({});
  await verifying;
  expect(mockVerifiedStatus).not.toHaveBeenCalled();
  expect(mockRecordAuthenticationGrant).not.toHaveBeenCalled();
  expect(states.at(-1)).toMatchObject({
    phase: 'complete',
    outcome: 'cancelled',
  });
});

test('cancelling during a grant write revokes the saved grant before resume', async () => {
  mockActiveCount.mockReturnValue(1);
  mockPause.mockReturnValueOnce({
    paused: Promise.resolve(1),
    release: mockRelease,
  });
  let finishWrite: (() => void) | undefined;
  let grantSaved = false;
  let pendingGrant: Promise<void> | undefined;
  mockRecordAuthenticationGrant.mockImplementationOnce(() => {
    pendingGrant = new Promise<void>((resolve) => {
      finishWrite = (): void => {
        grantSaved = true;
        resolve();
      };
    });
    return pendingGrant;
  });
  mockRevokeAuthenticationGrant.mockImplementationOnce(async () => {
    await pendingGrant;
    grantSaved = false;
  });
  mockHasAuthenticationGrant.mockImplementation(() =>
    Promise.resolve(grantSaved),
  );
  const manager = new CodexLoginManager();
  const state = manager.start({ confirmPause: true, method: 'chatgpt' });
  await flush();
  const verifying = manager.finish('success');
  await flush();
  expect(mockRecordAuthenticationGrant).toHaveBeenCalledTimes(1);
  const cancelling = manager.finish('cancelled');
  finishWrite?.();
  await Promise.all([verifying, cancelling]);
  expect(mockRevokeAuthenticationGrant).toHaveBeenCalledWith(state.attemptId);
  expect(mockCommit).not.toHaveBeenCalled();
  await expect(
    manager.assertResumeAllowed(state.attemptId ?? ''),
  ).rejects.toThrow('same Codex account');
});

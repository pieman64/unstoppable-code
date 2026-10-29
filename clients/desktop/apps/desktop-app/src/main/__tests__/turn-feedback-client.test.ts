/**
 * CAN-1521 turn-feedback transport — account scoping of the local outbox.
 *
 * This is the regression harness for the cross-account disclosure the review
 * caught: `subscribeTurnFeedbackFlush` fires on account change, so without an
 * account binding the *whole* outbox uploads to whoever signs in next. On a
 * shared machine that posts user A's ratings — and their free-text comments —
 * under user B, who can then read them back through
 * `GET /api/v1/feedback/turns/{feedbackId}`.
 *
 * The second, equally silent case is the opposite failure: binding too
 * eagerly. A "signed out" desktop user is normally a minted guest with a real
 * account id, so binding to that id would strand the feature's headline
 * rate-as-guest → sign-in flow until the 30-day prune quietly dropped it.
 */

/**
 * Every POSTed `clientUserMessageId`, recorded as the request is made.
 *
 * Read from a typed sink rather than by digging through `mock.calls`, whose
 * elements are `any` and would need unsafe member access to unpack.
 */
const mockPostedMessageIds: string[] = [];
let mockLastRequestOptions: MockRequestOptions | undefined;

interface MockRequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

function recordRequest(path: unknown, options: unknown): void {
  if (typeof options !== 'object' || options === null) return;
  const opts: MockRequestOptions = options;
  mockLastRequestOptions = opts;
  if (opts.method !== 'POST' || typeof opts.body !== 'string') return;
  const parsed: unknown = JSON.parse(opts.body);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'clientUserMessageId' in parsed &&
    typeof parsed.clientUserMessageId === 'string'
  ) {
    mockPostedMessageIds.push(parsed.clientUserMessageId);
  }
  void path;
}

const mockRequestCanopyCloudJson = jest.fn();
const mockLoadCanopyCloudAccount = jest.fn();
const mockResolveAiCreditsScopeOwner = jest.fn();

jest.mock('electron', () => ({ app: { getVersion: (): string => '1.2.3' } }));

jest.mock('../canopy-cloud/client', () => ({
  // Signature mirrors the real class exactly — `(code, message, status?)`.
  // A mock with a shorter parameter list would let a future
  // `new CanopyCloudClientError('http-error', 400)` pass here while setting
  // `message: '400'` and `status: undefined` in production.
  CanopyCloudClientError: class CanopyCloudClientError extends Error {
    code: string;
    status?: number;
    constructor(code: string, message: string, status?: number) {
      super(status === undefined ? message : `HTTP ${status}: ${message}`);
      this.code = code;
      this.status = status;
      this.name = 'CanopyCloudClientError';
    }
  },
  requestCanopyCloudJson: (path: unknown, options: unknown): unknown => {
    recordRequest(path, options);
    return mockRequestCanopyCloudJson(path, options);
  },
}));

let mockAccountConfirmed: (() => void) | undefined;

jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): unknown => mockLoadCanopyCloudAccount(),
  subscribeCanopyCloudAccountChanges: (): (() => void) => (): void => undefined,
  subscribeCanopyCloudAccountConfirmations: (
    listener: () => void,
  ): (() => void) => {
    mockAccountConfirmed = listener;
    return (): void => {
      mockAccountConfirmed = undefined;
    };
  },
}));

jest.mock('../agents/work-owner', () => ({
  resolveAiCreditsScopeOwner: (...args: unknown[]): unknown =>
    mockResolveAiCreditsScopeOwner(...args),
}));

const mockOutbox: TurnFeedbackOutboxEntry[] = [];
const mockRemovedBatches: string[][] = [];
const mockEnqueued: TurnFeedbackOutboxEntry[] = [];

jest.mock('../feedback/turn-feedback-outbox', () => ({
  readTurnFeedbackOutbox: (): Promise<TurnFeedbackOutboxEntry[]> =>
    Promise.resolve([...mockOutbox]),
  enqueueTurnFeedback: (queued: TurnFeedbackOutboxEntry): Promise<void> => {
    mockEnqueued.push(queued);
    return Promise.resolve();
  },
  amendQueuedTurnFeedback: (): Promise<boolean> => Promise.resolve(true),
  removeQueuedTurnFeedback: (id: string): Promise<void> => {
    mockRemovedBatches.push([id]);
    return Promise.resolve();
  },
  removeQueuedTurnFeedbackBatch: (ids: readonly string[]): Promise<void> => {
    mockRemovedBatches.push([...ids]);
    return Promise.resolve();
  },
}));

import type { TurnFeedbackOutboxEntry } from '@canopy/desktop-shared/types';
import { AI_CREDITS_WORK_OWNER_HEADER } from '@canopy/protocol';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import {
  belongsToAccount,
  flushTurnFeedbackOutbox,
  listTurnFeedback,
  rateTurnFeedback,
  subscribeTurnFeedbackFlush,
} from '../feedback/turn-feedback-client';

function entry(
  overrides: Partial<TurnFeedbackOutboxEntry> = {},
): TurnFeedbackOutboxEntry {
  return {
    clientUserMessageId: 'msg-1-1700000000000',
    clientChatId: 'chat-1',
    rating: 'down',
    queuedAt: 1700000000000,
    ...overrides,
  };
}

/** A real signed-in account (not a guest). */
function signedInAs(id: string): void {
  mockLoadCanopyCloudAccount.mockResolvedValue({
    apiKey: 'csk_real',
    authMode: 'oauth',
    account: { id, name: 'A', email: 'a@example.com', role: 'DEVELOPER' },
  });
}

/** A minted guest — has an account id, but must NOT bind. */
function signedInAsGuest(id: string): void {
  mockLoadCanopyCloudAccount.mockResolvedValue({
    apiKey: 'csk_guest',
    authMode: 'guest',
    account: { id, name: 'Guest', email: 'g@example.com', role: 'VIEWER' },
  });
}

function postedMessageIds(): string[] {
  return mockPostedMessageIds;
}

describe('turn feedback client — outbox account scoping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOutbox.length = 0;
    mockRemovedBatches.length = 0;
    mockEnqueued.length = 0;
    mockPostedMessageIds.length = 0;
    mockLastRequestOptions = undefined;
    mockResolveAiCreditsScopeOwner.mockResolvedValue({ kind: 'personal' });
    mockRequestCanopyCloudJson.mockResolvedValue({
      feedbackId: 'fb-1',
      clientUserMessageId: 'msg-1-1700000000000',
      rating: 'down',
      createdAt: '2026-08-12T10:00:00.000Z',
      updatedAt: '2026-08-12T10:00:00.000Z',
    });
  });

  describe('belongsToAccount', () => {
    it('lets an unbound entry flush to whoever is signed in', () => {
      expect(belongsToAccount({ accountId: undefined }, 'acct-a')).toBe(true);
      expect(belongsToAccount({ accountId: undefined }, undefined)).toBe(true);
    });

    it('keeps a bound entry with its own account only', () => {
      expect(belongsToAccount({ accountId: 'acct-a' }, 'acct-a')).toBe(true);
      expect(belongsToAccount({ accountId: 'acct-a' }, 'acct-b')).toBe(false);
      expect(belongsToAccount({ accountId: 'acct-a' }, undefined)).toBe(false);
    });
  });

  describe('flushTurnFeedbackOutbox', () => {
    it('never uploads account A-s queued feedback to account B', async () => {
      // The disclosure case. A's comment must not reach B's account.
      mockOutbox.push(
        entry({
          clientUserMessageId: 'msg-a',
          accountId: 'acct-a',
          comment: 'A private note about my repo',
        }),
      );
      signedInAs('acct-b');

      await flushTurnFeedbackOutbox();

      expect(postedMessageIds()).not.toContain('msg-a');
      expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();
      // Retained, not dropped: A may sign back in on this machine.
      expect(mockRemovedBatches.flat()).not.toContain('msg-a');
    });

    it('uploads an entry bound to the account that is signed in now', async () => {
      mockOutbox.push(
        entry({ clientUserMessageId: 'msg-a', accountId: 'acct-a' }),
      );
      signedInAs('acct-a');

      await flushTurnFeedbackOutbox();

      expect(postedMessageIds()).toContain('msg-a');
      expect(mockRemovedBatches.flat()).toContain('msg-a');
    });

    it('uploads an unbound (rate-as-guest) entry to the account that signs in', async () => {
      mockOutbox.push(entry({ clientUserMessageId: 'msg-guest' }));
      signedInAs('acct-a');

      await flushTurnFeedbackOutbox();

      expect(postedMessageIds()).toContain('msg-guest');
      expect(mockRemovedBatches.flat()).toContain('msg-guest');
    });

    it('retries the outbox when a refresh confirms the unchanged account', async () => {
      // Offline ratings used to retry on every routine account refresh; an
      // unchanged refresh no longer notifies account changes.
      mockOutbox.push(entry({ clientUserMessageId: 'msg-offline' }));
      signedInAs('acct-a');
      const unsubscribe = subscribeTurnFeedbackFlush();
      try {
        mockAccountConfirmed?.();
        await new Promise((resolve) => setImmediate(resolve));
        expect(postedMessageIds()).toContain('msg-offline');
      } finally {
        unsubscribe();
      }
    });

    it('settles the whole flushed batch in one removal write', async () => {
      mockOutbox.push(
        entry({ clientUserMessageId: 'msg-1' }),
        entry({ clientUserMessageId: 'msg-2' }),
      );
      signedInAs('acct-a');

      await flushTurnFeedbackOutbox();

      expect(mockRemovedBatches).toHaveLength(1);
      expect(mockRemovedBatches[0]).toEqual(['msg-1', 'msg-2']);
    });
  });

  describe('what rateTurnFeedback binds when it queues', () => {
    /** Force the POST to fail retryably so the rating lands in the outbox. */
    function makeServerUnreachable(): void {
      mockRequestCanopyCloudJson.mockRejectedValue(
        new CanopyCloudClientError('network-error', 'offline'),
      );
    }

    it('leaves a guest-queued rating UNBOUND so it survives sign-in', async () => {
      // A minted guest HAS a real account id (`mintGuest` saves
      // `{ authMode: 'guest', account }`). Binding to it would strand the
      // feature's headline flow: on sign-in the id becomes the real user's and
      // the guest row is deleted by `mergeGuestIntoUser`, so the entry could
      // never match again and would sit until the 30-day prune dropped it.
      makeServerUnreachable();
      signedInAsGuest('guest-123');

      const result = await rateTurnFeedback({
        clientUserMessageId: 'msg-guest',
        clientChatId: 'chat-1',
        rating: 'down',
      });

      expect(result).toEqual({ recorded: false, queued: true });
      expect(mockEnqueued).toHaveLength(1);
      expect(mockEnqueued[0].accountId).toBeUndefined();
    });

    it('binds a rating queued under a real signed-in account', async () => {
      makeServerUnreachable();
      signedInAs('acct-a');

      await rateTurnFeedback({
        clientUserMessageId: 'msg-a',
        clientChatId: 'chat-1',
        rating: 'down',
      });

      expect(mockEnqueued).toHaveLength(1);
      expect(mockEnqueued[0].accountId).toBe('acct-a');
    });

    it('captures the resolved work owner when the rating is queued', async () => {
      makeServerUnreachable();
      signedInAs('acct-a');
      mockResolveAiCreditsScopeOwner.mockResolvedValue({
        kind: 'organization',
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });

      await rateTurnFeedback({
        clientUserMessageId: 'msg-a',
        clientChatId: 'chat-1',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        rating: 'down',
      });

      expect(mockEnqueued[0].workOwner).toBe(
        'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
    });

    it('leaves a fully signed-out rating unbound', async () => {
      makeServerUnreachable();
      mockLoadCanopyCloudAccount.mockResolvedValue(null);

      await rateTurnFeedback({
        clientUserMessageId: 'msg-out',
        clientChatId: 'chat-1',
        rating: 'up',
      });

      expect(mockEnqueued).toHaveLength(1);
      expect(mockEnqueued[0].accountId).toBeUndefined();
    });

    it('end-to-end: a guest-queued rating flushes to the real account on sign-in', async () => {
      makeServerUnreachable();
      signedInAsGuest('guest-123');
      await rateTurnFeedback({
        clientUserMessageId: 'msg-guest',
        clientChatId: 'chat-1',
        rating: 'down',
      });
      // Whatever it queued is what the outbox now holds.
      mockOutbox.push(...mockEnqueued);

      // Drop the failed POST attempt from the log, so the assertion below can
      // only be satisfied by a POST the *flush* made.
      mockPostedMessageIds.length = 0;

      // The user signs in for real; the queued rating must still upload.
      mockRequestCanopyCloudJson.mockResolvedValue({
        feedbackId: 'fb-1',
        clientUserMessageId: 'msg-guest',
        rating: 'down',
        createdAt: '2026-08-12T10:00:00.000Z',
        updatedAt: '2026-08-12T10:00:00.000Z',
      });
      signedInAs('acct-real');
      await flushTurnFeedbackOutbox();

      expect(postedMessageIds()).toContain('msg-guest');
    });
  });

  it('sends the work owner header without leaking local ids into the body', async () => {
    signedInAs('acct-a');
    mockResolveAiCreditsScopeOwner.mockResolvedValue({
      kind: 'organization',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    await rateTurnFeedback({
      clientUserMessageId: 'msg-a',
      clientChatId: 'chat-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      rating: 'up',
    });

    const options = mockLastRequestOptions;
    expect(options).toEqual(
      expect.objectContaining({
        headers: {
          [AI_CREDITS_WORK_OWNER_HEADER]:
            'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      }),
    );
    if (
      typeof options !== 'object' ||
      options === null ||
      !('body' in options)
    ) {
      throw new Error('Expected request body');
    }
    const body: unknown = JSON.parse(String(options.body));
    if (typeof body !== 'object' || body === null) {
      throw new Error('Expected parsed request body');
    }
    expect('projectId' in body).toBe(false);
    expect('worktreeId' in body).toBe(false);
  });

  it('sends the queued work owner when flushing', async () => {
    mockOutbox.push(entry({ workOwner: 'personal' }));
    signedInAs('acct-a');

    await flushTurnFeedbackOutbox();

    expect(mockRequestCanopyCloudJson).toHaveBeenCalledWith(
      '/api/v1/feedback/turns',
      expect.objectContaining({
        headers: { [AI_CREDITS_WORK_OWNER_HEADER]: 'personal' },
      }),
    );
  });

  describe('listTurnFeedback', () => {
    it('hides another account-s queued rating from the current account', async () => {
      // Same threat model as the flush: B must not see (or be able to clear)
      // A's pending feedback just by opening the chat.
      mockRequestCanopyCloudJson.mockResolvedValue({ feedback: [] });
      mockOutbox.push(
        entry({
          clientUserMessageId: 'msg-a',
          clientChatId: 'chat-1',
          accountId: 'acct-a',
        }),
      );
      signedInAs('acct-b');

      const result = await listTurnFeedback({ clientChatId: 'chat-1' });

      expect(
        result.feedback.map((row) => row.clientUserMessageId),
      ).not.toContain('msg-a');
    });

    it('still surfaces the current account-s own queued rating', async () => {
      mockRequestCanopyCloudJson.mockResolvedValue({ feedback: [] });
      mockOutbox.push(
        entry({
          clientUserMessageId: 'msg-a',
          clientChatId: 'chat-1',
          accountId: 'acct-a',
        }),
      );
      signedInAs('acct-a');

      const result = await listTurnFeedback({ clientChatId: 'chat-1' });

      expect(result.feedback.map((row) => row.clientUserMessageId)).toContain(
        'msg-a',
      );
    });
  });
});

describe('turn feedback client — guest detection and retry policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOutbox.length = 0;
    mockRemovedBatches.length = 0;
    mockEnqueued.length = 0;
    mockPostedMessageIds.length = 0;
    mockLastRequestOptions = undefined;
  });

  function unreachable(): void {
    mockRequestCanopyCloudJson.mockRejectedValue(
      new CanopyCloudClientError('network-error', 'offline'),
    );
  }

  describe('canonical guest signal', () => {
    // `isGuestAccount` ORs `credentialSource` with `authMode` because a
    // normalized entry can carry one without the other. A single-field check
    // would let these entries bind and re-strand the rate-as-guest flow.
    it.each([
      ['both fields set', { credentialSource: 'guest', authMode: 'guest' }],
      ['authMode only', { credentialSource: 'manual', authMode: 'guest' }],
      [
        'credentialSource only',
        { credentialSource: 'guest', authMode: 'api_key' },
      ],
    ])(
      'leaves a rating unbound for a guest with %s',
      async (_label, fields) => {
        unreachable();
        mockLoadCanopyCloudAccount.mockResolvedValue({
          apiKey: 'csk_guest',
          ...fields,
          account: {
            id: 'guest-123',
            name: 'Guest',
            email: 'g@guest.canopy.invalid',
            role: 'VIEWER',
          },
        });

        await rateTurnFeedback({
          clientUserMessageId: 'msg-guest',
          clientChatId: 'chat-1',
          rating: 'down',
        });

        expect(mockEnqueued).toHaveLength(1);
        expect(mockEnqueued[0].accountId).toBeUndefined();
      },
    );
  });

  describe('mid-flush account switch', () => {
    it('stops rather than uploading the rest under a newly signed-in account', async () => {
      // The entry list is filtered once, but credentials resolve per request.
      // If the account changes mid-drain the remaining POSTs would go out under
      // the new key while carrying the old account's entries.
      mockOutbox.push(
        entry({ clientUserMessageId: 'msg-1', accountId: 'acct-a' }),
        entry({ clientUserMessageId: 'msg-2', accountId: 'acct-a' }),
      );
      signedInAs('acct-a');
      let calls = 0;
      mockRequestCanopyCloudJson.mockImplementation(() => {
        calls += 1;
        // After the first upload, the user switches accounts.
        if (calls >= 1) signedInAs('acct-b');
        return Promise.resolve({
          feedbackId: 'fb',
          clientUserMessageId: 'msg-1',
          rating: 'down',
          createdAt: '2026-08-12T10:00:00.000Z',
          updatedAt: '2026-08-12T10:00:00.000Z',
        });
      });

      await flushTurnFeedbackOutbox();

      expect(postedMessageIds()).toContain('msg-1');
      expect(postedMessageIds()).not.toContain('msg-2');
      // What did upload is still settled, so it is not replayed later.
      expect(mockRemovedBatches.flat()).toContain('msg-1');
      expect(mockRemovedBatches.flat()).not.toContain('msg-2');
    });
  });

  describe('shouldQueue HTTP policy', () => {
    it('queues on 401 so a rotated key does not silently drop ratings', async () => {
      mockLoadCanopyCloudAccount.mockResolvedValue(null);
      mockRequestCanopyCloudJson.mockRejectedValue(
        new CanopyCloudClientError('http-error', 'unauthorized', 401),
      );

      const result = await rateTurnFeedback({
        clientUserMessageId: 'msg-401',
        clientChatId: 'chat-1',
        rating: 'up',
      });

      expect(result).toEqual({ recorded: false, queued: true });
      expect(mockEnqueued).toHaveLength(1);
    });

    it('drops on 400, since that payload will never be accepted', async () => {
      mockLoadCanopyCloudAccount.mockResolvedValue(null);
      mockRequestCanopyCloudJson.mockRejectedValue(
        new CanopyCloudClientError('http-error', 'bad request', 400),
      );

      const result = await rateTurnFeedback({
        clientUserMessageId: 'msg-400',
        clientChatId: 'chat-1',
        rating: 'up',
      });

      expect(result).toEqual({ recorded: false, queued: false });
      expect(mockEnqueued).toHaveLength(0);
    });

    it('queues on a 5xx, which is transient', async () => {
      mockLoadCanopyCloudAccount.mockResolvedValue(null);
      mockRequestCanopyCloudJson.mockRejectedValue(
        new CanopyCloudClientError('http-error', 'server error', 503),
      );

      const result = await rateTurnFeedback({
        clientUserMessageId: 'msg-503',
        clientChatId: 'chat-1',
        rating: 'up',
      });

      expect(result).toEqual({ recorded: false, queued: true });
    });
  });
});

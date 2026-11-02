import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';
import type { PortalAdapterContext } from '../types';

const mockInspect = jest.fn();
const mockQuarantine = jest.fn();
jest.mock('../../../lib/w5-lifecycle-journal-quarantine', () => {
  class LifecycleJournalQuarantineRefusedError extends Error {
    constructor(
      readonly reason: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    LifecycleJournalQuarantineRefusedError,
    inspectLifecycleJournal: (...args: unknown[]): unknown =>
      mockInspect(...args),
    quarantineLifecycleJournalEntry: (...args: unknown[]): unknown =>
      mockQuarantine(...args),
  };
});

import {
  handlePortalLifecycleJournalInspect,
  handlePortalLifecycleJournalQuarantine,
} from '../lifecycle-journal-adapter';
import { LifecycleJournalQuarantineRefusedError } from '../../../lib/w5-lifecycle-journal-quarantine';

type TestContext = Omit<PortalAdapterContext, 'complete' | 'fail'> & {
  complete: jest.Mock<void, [PortalCommandEnvelope, unknown?]>;
  fail: jest.Mock<void, [PortalCommandEnvelope, string, string, boolean?]>;
};
function context(
  overrides: Partial<Omit<PortalAdapterContext, 'complete' | 'fail'>> = {},
): TestContext {
  return {
    sessionId: 'session',
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete: jest.fn<void, [PortalCommandEnvelope, unknown?]>(),
    fail: jest.fn<void, [PortalCommandEnvelope, string, string, boolean?]>(),
    ...overrides,
  };
}
const request = { name: `${'a'.repeat(64)}.json`, identity: '1:2:3' };
const quarantine: PortalCommandEnvelope<typeof request> = {
  id: 'command',
  sequence: 1,
  type: 'portal.lifecycle_journal.quarantine',
  payload: request,
  createdAt: '2026-10-30T00:00:00.000Z',
  expiresAt: null,
};
const inspect: PortalCommandEnvelope<Record<string, never>> = {
  id: 'command',
  sequence: 2,
  type: 'portal.lifecycle_journal.inspect',
  payload: {},
  createdAt: '2026-10-30T00:00:00.000Z',
  expiresAt: null,
};
const agent = {
  kind: 'external_agent' as const,
  connectionId: '12345678-1234-4234-8234-123456789abc',
  clientName: 'Agent',
  verified: true,
  userId: '12345678-1234-4234-8234-123456789abd',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockInspect.mockResolvedValue({
    status: 'clear',
    locationLabel: '<data>/w5/destructive-lifecycles',
  });
  mockQuarantine.mockResolvedValue({ status: 'quarantined' });
});

it('refuses agent-originated and sessionless commands before touching the journal', async () => {
  for (const ctx of [
    context({ origin: agent }),
    context({ sessionId: null }),
  ]) {
    await handlePortalLifecycleJournalQuarantine(quarantine, ctx);
    await handlePortalLifecycleJournalInspect(inspect, ctx);
    expect(ctx.fail).toHaveBeenCalledTimes(2);
    expect(ctx.fail.mock.calls.map((call) => call[1])).toEqual([
      'forbidden',
      'forbidden',
    ]);
    expect(ctx.complete).not.toHaveBeenCalled();
  }
  expect(mockQuarantine).not.toHaveBeenCalled();
  expect(mockInspect).not.toHaveBeenCalled();
});

it('a paired person inspects and moves through the shared service', async () => {
  const ctx = context();
  await handlePortalLifecycleJournalInspect(inspect, ctx);
  await handlePortalLifecycleJournalQuarantine(quarantine, ctx);
  // No projector: the service's portable, path-free labels reach the Portal.
  expect(mockInspect.mock.calls).toEqual([[]]);
  expect(mockQuarantine.mock.calls).toEqual([[request]]);
  expect(ctx.complete.mock.calls.map((call) => call[1])).toEqual([
    { status: 'clear', locationLabel: '<data>/w5/destructive-lifecycles' },
    { status: 'quarantined' },
  ]);
});

it('forwards a refusal in its user-facing copy', async () => {
  mockQuarantine.mockRejectedValue(
    new LifecycleJournalQuarantineRefusedError('missing', 'It is gone.'),
  );
  const ctx = context();
  await handlePortalLifecycleJournalQuarantine(quarantine, ctx);
  expect(ctx.fail).toHaveBeenCalledWith(quarantine, 'not_found', 'It is gone.');
});

it('reports a failed inspection without the underlying host path', async () => {
  mockInspect.mockRejectedValue(
    new Error("EIO: i/o error, scandir '/Users/me/Library/w5'"),
  );
  const ctx = context();
  await handlePortalLifecycleJournalInspect(inspect, ctx);
  expect(ctx.fail).toHaveBeenCalledWith(
    inspect,
    'execution_failed',
    "Couldn't review the operation records. Try again.",
  );
});

import {
  ChildMessageAdmissionRefusedError,
  ManagedChildMessageInbox,
} from '../agents/delegation/child-messages';

it('orders trusted messages for the same retained child', async () => {
  let releaseFirst: () => void = () => undefined;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const calls: string[] = [];
  const broker = {
    deliverHostMessage: jest.fn(
      async (_delegationId: string, message: string, deliveryId: string) => {
        calls.push(`${deliveryId}:${message}:start`);
        if (deliveryId === 'first') await firstHeld;
        calls.push(`${deliveryId}:${message}:finish`);
        return { ok: true as const, value: {} };
      },
    ),
    waitHostMessage: jest.fn(() => Promise.resolve()),
  };
  const inbox = new ManagedChildMessageInbox(() => broker);

  const first = inbox.deliver('child', 'one', 'first', 'failed');
  const second = inbox.deliver('child', 'two', 'second', 'failed');
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(calls).toEqual(['first:one:start']);
  releaseFirst();
  await Promise.all([first, second]);

  expect(calls).toEqual([
    'first:one:start',
    'first:one:finish',
    'second:two:start',
    'second:two:finish',
  ]);
});

it('does not block messages for different child recipients', async () => {
  let releaseFirst: () => void = () => undefined;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const calls: string[] = [];
  const broker = {
    deliverHostMessage: jest.fn(
      async (delegationId: string, _message: string, deliveryId: string) => {
        calls.push(`${delegationId}:${deliveryId}`);
        if (deliveryId === 'first') await firstHeld;
        return { ok: true as const, value: {} };
      },
    ),
    waitHostMessage: jest.fn(() => Promise.resolve()),
  };
  const inbox = new ManagedChildMessageInbox(() => broker);

  const first = inbox.deliver('one', 'one', 'first', 'failed');
  const second = inbox.deliver('two', 'two', 'second', 'failed');
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(calls).toEqual(['one:first', 'two:second']);
  releaseFirst();
  await Promise.all([first, second]);
});

it('holds a recipient until the admitted host control settles', async () => {
  let settleFirst: () => void = () => undefined;
  const firstSettled = new Promise<void>((resolve) => {
    settleFirst = resolve;
  });
  const calls: string[] = [];
  const broker = {
    deliverHostMessage: jest.fn(
      (_delegationId: string, _message: string, deliveryId: string) => {
        calls.push(`admit:${deliveryId}`);
        return Promise.resolve({
          ok: true as const,
          value: { attemptId: deliveryId },
        });
      },
    ),
    waitHostMessage: jest.fn(
      async (_delegationId: string, deliveryId: string) => {
        if (deliveryId === 'first') await firstSettled;
        calls.push(`settled:${deliveryId}`);
      },
    ),
  };
  const inbox = new ManagedChildMessageInbox(() => broker);
  const first = inbox.deliver('child', 'one', 'first', 'failed');
  const second = inbox.deliver('child', 'two', 'second', 'failed');
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(calls).toEqual(['admit:first']);
  settleFirst();
  await Promise.all([first, second]);
  expect(calls).toEqual([
    'admit:first',
    'settled:first',
    'admit:second',
    'settled:second',
  ]);
});

it('refuses a queued message whose admission check fails after the wait', async () => {
  let releaseFirst: () => void = () => undefined;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const broker = {
    deliverHostMessage: jest.fn(
      async (_delegationId: string, _message: string, deliveryId: string) => {
        if (deliveryId === 'first') await firstHeld;
        return { ok: true as const, value: {} };
      },
    ),
    waitHostMessage: jest.fn(() => Promise.resolve()),
  };
  const inbox = new ManagedChildMessageInbox(() => broker);
  let admitted = true;
  const first = inbox.deliver('child', 'one', 'first', 'failed');
  const second = inbox.deliver(
    'child',
    'two',
    'second',
    'failed',
    () => admitted,
  );
  // Authority is revoked while the second message waits behind the first.
  admitted = false;
  releaseFirst();
  await first;
  await expect(second).rejects.toBeInstanceOf(
    ChildMessageAdmissionRefusedError,
  );
  expect(broker.deliverHostMessage).toHaveBeenCalledTimes(1);
});

import { createPushForwarder } from '../host/push-forwarder';

describe('createPushForwarder', () => {
  it('forwards a broadcast seen from two windows once per tick', () => {
    const forwarded: Array<[string, unknown[]]> = [];
    let clear: () => void = () => undefined;
    const forwarder = createPushForwarder(
      (channel, args) => forwarded.push([channel, args]),
      (callback) => {
        clear = callback;
      },
    );
    const payload = { id: 1 };
    forwarder.offer('chat:event', [payload]);
    forwarder.offer('chat:event', [payload]);
    forwarder.offer('chat:event', [{ id: 1 }]);
    expect(forwarded).toHaveLength(2);
    clear();
    forwarder.offer('chat:event', [payload]);
    expect(forwarded).toHaveLength(3);
  });

  it('counts duplicates only when no controller window remains to receive the push', () => {
    const forwarded = jest.fn();
    const duplicateDropped = jest.fn();
    const forwarder = createPushForwarder(
      forwarded,
      () => undefined,
      () => ['main', 'app-advisor'],
      duplicateDropped,
    );
    const payload = { id: 1 };
    forwarder.offer('chat:event', [payload], 'app-advisor');
    forwarder.offer('chat:event', [payload], 'main');
    expect(duplicateDropped).not.toHaveBeenCalled();
    forwarder.offer('chat:event', [payload]);
    forwarder.offer('chat:event', [payload], 'app-advisor');
    expect(forwarded).toHaveBeenCalledTimes(2);
    expect(duplicateDropped).toHaveBeenCalledTimes(2);
  });

  it('keeps pushes on different channels apart', () => {
    const forwarded: string[] = [];
    const forwarder = createPushForwarder(
      (channel) => forwarded.push(channel),
      () => undefined,
    );
    forwarder.offer('a', ['x']);
    forwarder.offer('b', ['x']);
    expect(forwarded).toEqual(['a', 'b']);
  });
});

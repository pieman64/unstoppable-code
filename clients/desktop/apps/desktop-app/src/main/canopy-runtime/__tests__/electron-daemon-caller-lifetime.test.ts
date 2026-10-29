import { createElectronDaemonCallerLifetime } from '../electron-daemon-caller-lifetime';
import { FakeSender } from './daemon-files-route-harness';

describe('Electron daemon caller lifetime', () => {
  it('returns one owner per sender object until its document retires', () => {
    const lifetime = createElectronDaemonCallerLifetime();
    const first = new FakeSender(1);
    const second = new FakeSender(2);
    const owner = lifetime.ownerFor(first);
    expect(lifetime.ownerFor(first)).toBe(owner);
    expect(lifetime.ownerFor(second)).not.toBe(owner);
    expect(first.retiringListeners()).toBe(3);
  });

  it.each(['destroyed', 'render-process-gone', 'did-navigate'] as const)(
    'retires on %s and detaches its listeners',
    (event) => {
      const lifetime = createElectronDaemonCallerLifetime();
      const sender = new FakeSender(1);
      const other = new FakeSender(2);
      const owner = lifetime.ownerFor(sender);
      const untouched = lifetime.ownerFor(other);
      sender.emit(event);
      expect(owner.aborted).toBe(true);
      expect(sender.retiringListeners()).toBe(0);
      expect(untouched.aborted).toBe(false);
      // A committed reload starts a new document with a new owner.
      if (event === 'did-navigate') {
        const next = lifetime.ownerFor(sender);
        expect(next).not.toBe(owner);
        expect(next.aborted).toBe(false);
      }
    },
  );

  it.each([
    'did-start-navigation',
    'will-navigate',
    'did-navigate-in-page',
    'did-frame-navigate',
    'did-fail-load',
  ])('keeps the document current on %s', (event) => {
    const lifetime = createElectronDaemonCallerLifetime();
    const sender = new FakeSender(1);
    const owner = lifetime.ownerFor(sender);
    sender.emit(event);
    expect(owner.aborted).toBe(false);
    expect(lifetime.ownerFor(sender)).toBe(owner);
  });

  it('gives a destroyed sender an already-closed owner without listening to it', () => {
    const lifetime = createElectronDaemonCallerLifetime();
    const sender = new FakeSender(1);
    sender.destroy();
    expect(lifetime.ownerFor(sender).aborted).toBe(true);
    expect(sender.retiringListeners()).toBe(0);
  });

  it('keys by sender object, so a reused numeric id gets its own owner', () => {
    const lifetime = createElectronDaemonCallerLifetime();
    const first = new FakeSender(9);
    const owner = lifetime.ownerFor(first);
    first.destroy();
    const second = new FakeSender(9);
    const next = lifetime.ownerFor(second);
    expect(owner.aborted).toBe(true);
    expect(next.aborted).toBe(false);
  });

  it('renews every owner without retiring documents', () => {
    const lifetime = createElectronDaemonCallerLifetime();
    const sender = new FakeSender(1);
    const owner = lifetime.ownerFor(sender);
    lifetime.renewAll();
    expect(owner.aborted).toBe(true);
    const renewed = lifetime.ownerFor(sender);
    expect(renewed).not.toBe(owner);
    expect(renewed.aborted).toBe(false);
    // Listeners stay attached once, and still retire the renewed owner.
    expect(sender.retiringListeners()).toBe(3);
    sender.emit('did-navigate');
    expect(renewed.aborted).toBe(true);
  });

  it('closes every owner at quit and refuses new ones', () => {
    const lifetime = createElectronDaemonCallerLifetime();
    const sender = new FakeSender(1);
    const owner = lifetime.ownerFor(sender);
    lifetime.disposeAll();
    expect(owner.aborted).toBe(true);
    expect(sender.retiringListeners()).toBe(0);
    const late = new FakeSender(2);
    expect(lifetime.ownerFor(late).aborted).toBe(true);
    expect(late.retiringListeners()).toBe(0);
  });
});

import {
  createPostHogAccountTracker,
  getPostHogEmailDomain,
  normalizePostHogEmailDomain,
} from '../posthog-account';

describe('PostHog account domain', () => {
  it.each([
    ['  anhan@UnstoppableDomains.com  ', 'unstoppabledomains.com'],
    ['a+b@sub.example.test', 'sub.example.test'],
    [undefined, null],
    ['', null],
    ['@example.test', null],
    ['user@example.test@other.test', null],
    ['user name@example.test', null],
    ['user@example.test/path', null],
    ['user@-example.test', null],
    ['user@example..test', null],
  ])('extracts only a valid domain from %s', (email, expected) => {
    expect(getPostHogEmailDomain(email)).toBe(expected);
  });

  it('rejects full emails and arbitrary content supplied as domains', () => {
    expect(normalizePostHogEmailDomain('User@Example.test')).toBeNull();
    expect(normalizePostHogEmailDomain('private prose')).toBeNull();
    expect(normalizePostHogEmailDomain('EXAMPLE.TEST')).toBe('example.test');
    expect(normalizePostHogEmailDomain(`${'x'.repeat(64)}.test`)).toBeNull();
  });

  it('lets account pushes win over a delayed startup read and ignores updates after disposal', async () => {
    let resolveSnapshot: (domain: string | null) => void = () => undefined;
    let push: (domain: string | null) => void = () => undefined;
    const unsubscribe = jest.fn();
    const changed = jest.fn();
    const tracker = createPostHogAccountTracker(
      {
        getSnapshot: () =>
          new Promise((resolve) => {
            resolveSnapshot = resolve;
          }),
        onSnapshotChanged: (listener) => {
          push = listener;
          return unsubscribe;
        },
      },
      changed,
    );
    expect(tracker.domain).toBeUndefined();
    await Promise.resolve();
    push('new.test');
    resolveSnapshot('old.test');
    await tracker.ready;
    expect(tracker.domain).toBe('new.test');
    expect(changed).toHaveBeenCalledTimes(1);
    push(null);
    expect(tracker.domain).toBeNull();
    tracker.dispose();
    tracker.dispose();
    push('old.test');
    expect(tracker.domain).toBeNull();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('clears metadata when the account read fails', async () => {
    const tracker = createPostHogAccountTracker(
      {
        getSnapshot: () => Promise.reject(new Error('unavailable')),
        onSnapshotChanged: () => (): void => undefined,
      },
      jest.fn(),
    );
    await tracker.ready;
    expect(tracker.domain).toBeNull();
    tracker.dispose();
  });

  it('does not publish a delayed read after disposal', async () => {
    let resolveSnapshot: (domain: string | null) => void = () => undefined;
    const changed = jest.fn();
    const tracker = createPostHogAccountTracker(
      {
        getSnapshot: () =>
          new Promise((resolve) => {
            resolveSnapshot = resolve;
          }),
        onSnapshotChanged: () => (): void => undefined,
      },
      changed,
    );
    await Promise.resolve();
    tracker.dispose();
    resolveSnapshot('example.test');
    await tracker.ready;
    expect(changed).not.toHaveBeenCalled();
  });
});

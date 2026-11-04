import {
  currentDaemonCodeGraphRoute,
  withDaemonCodeGraphRoute,
} from '../daemon-code-graph-route-context';

describe('daemon code-graph route context (CAN-5089)', () => {
  it('opens no route unless selected', async () => {
    const seen = await withDaemonCodeGraphRoute(false, () =>
      Promise.resolve(currentDaemonCodeGraphRoute()),
    );
    expect(seen).toEqual({ value: undefined, daemon: false });
  });

  it('serves one build, never work that build schedules later', async () => {
    let later: Promise<boolean | undefined> = Promise.resolve(undefined);
    const { value, daemon } = await withDaemonCodeGraphRoute(true, () => {
      const route = currentDaemonCodeGraphRoute();
      const first = route?.claim() ?? false;
      route?.servedByDaemon();
      // A follow-up the build schedules inherits the context, not the route.
      later = new Promise((resolve) => {
        setTimeout(() => resolve(currentDaemonCodeGraphRoute()?.claim()), 0);
      });
      return Promise.resolve(first);
    });
    expect(value).toBe(true);
    expect(daemon).toBe(true);
    await expect(later).resolves.toBe(false);
  });
});

import {
  acquireW4Within,
  settleW4LateReleases,
  w4Gate,
} from './w4-acquisition';
import {
  W4_CHAT_RESTART_SCENARIO,
  runW4ChatControlChecks,
  runW4ChatParity,
  runW4ChatScenario,
} from './w4-chat-parity';
import {
  createW4FakeDaemonBinding,
  inMemoryParityBinding,
  type W4ParityBackend,
  type W4ParityBinding,
} from './w4-parity-harness';

runW4ChatParity(inMemoryParityBinding);
runW4ChatParity(createW4FakeDaemonBinding().binding);
runW4ChatControlChecks(inMemoryParityBinding);

afterEach(() => settleW4LateReleases());
afterAll(() => settleW4LateReleases());

describe('W4 chat backend drivers', () => {
  it('drives commits and the restart through the selected backend', async () => {
    const fake = createW4FakeDaemonBinding();
    await runW4ChatScenario(fake.binding, W4_CHAT_RESTART_SCENARIO);
    expect(Object.fromEntries(fake.hookCalls)).toEqual({
      'chat.commit': 2,
      'chat.restart': 1,
    });
  });

  it('releases a backend that finishes starting after the runner timeout', async () => {
    const started = w4Gate<W4ParityBackend>();
    const released = w4Gate();
    const late: W4ParityBinding = {
      name: 'late start',
      start: () => started.promise,
    };
    await expect(
      runW4ChatScenario(late, W4_CHAT_RESTART_SCENARIO),
    ).rejects.toThrow('Timed out: backend start');
    const backend = await inMemoryParityBinding.start();
    started.resolve({
      ...backend,
      shutdown: async (): Promise<void> => {
        await backend.shutdown();
        released.resolve();
      },
    });
    await acquireW4Within(
      released.promise,
      () => undefined,
      'late backend release',
    );
  });

  it('reports a late backend whose release fails after the runner timeout', async () => {
    const started = w4Gate<W4ParityBackend>();
    const sentinel = new Error('late backend shutdown sentinel');
    const late: W4ParityBinding = {
      name: 'late failing start',
      start: () => started.promise,
    };
    await expect(
      runW4ChatScenario(late, W4_CHAT_RESTART_SCENARIO),
    ).rejects.toThrow('Timed out: backend start');
    const backend = await inMemoryParityBinding.start();
    started.resolve({
      ...backend,
      shutdown: async (): Promise<void> => {
        await backend.shutdown();
        throw sentinel;
      },
    });
    await expect(settleW4LateReleases()).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          message: 'W4 late release after "Timed out: backend start" failed.',
          cause: sentinel,
        }),
      ],
    });
  });

  it('reports the scenario failure together with every cleanup failure', async () => {
    const cleanup = new Error('backend shutdown failed');
    const failing: W4ParityBinding = {
      name: 'failing cleanup',
      async start(): Promise<W4ParityBackend> {
        const backend = await inMemoryParityBinding.start();
        return {
          ...backend,
          chat: { ...backend.chat, commit: () => Promise.resolve() },
          shutdown: async (): Promise<void> => {
            await backend.shutdown();
            throw cleanup;
          },
        };
      },
    };
    const run = runW4ChatScenario(failing, W4_CHAT_RESTART_SCENARIO);
    await expect(run).rejects.toThrow(
      /^W4 chat scenario failed \(Condition not met: first handled\) and cleanup failed$/,
    );
    await expect(run).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          message: 'Condition not met: first handled',
        }),
        cleanup,
      ],
    });
  });
});

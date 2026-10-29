import { selectSessionInstructions } from '../session';

it('preserves empty and legacy snapshots without file reads', async () => {
  const compose = jest.fn(() => Promise.resolve('new'));
  for (const saved of ['', undefined]) {
    expect(
      await selectSessionInstructions({
        provider: 'claude',
        isInteractiveCode: true,
        resumed: true,
        saved,
        currentGlobal: 'new preferences',
        compose,
      }),
    ).toBe('');
  }
  expect(compose).not.toHaveBeenCalled();
});
it('preserves an active session and excludes Cursor on a provider switch', async () => {
  const compose = jest.fn(() => Promise.resolve('rules'));
  expect(
    await selectSessionInstructions({
      provider: 'claude',
      isInteractiveCode: true,
      resumed: false,
      active: 'original',
      activeProvider: 'claude',
      currentGlobal: 'changed',
      compose,
    }),
  ).toBe('original');
  expect(
    await selectSessionInstructions({
      provider: 'cursor',
      isInteractiveCode: true,
      resumed: false,
      active: 'non-Cursor rules',
      activeProvider: 'codex',
      currentGlobal: 'current',
      compose,
    }),
  ).toBe('current');
  expect(
    await selectSessionInstructions({
      provider: 'claude',
      isInteractiveCode: false,
      resumed: false,
      active: 'interactive rules',
      activeProvider: 'claude',
      currentGlobal: 'current',
      compose,
    }),
  ).toBe('interactive rules');
  expect(
    await selectSessionInstructions({
      provider: 'claude',
      isInteractiveCode: false,
      resumed: false,
      currentGlobal: 'current',
      compose,
    }),
  ).toBe('current');
  expect(
    await selectSessionInstructions({
      provider: 'cursor',
      isInteractiveCode: true,
      resumed: false,
      saved: 'non-Cursor rules',
      currentGlobal: 'current',
      compose,
    }),
  ).toBe('current');
  expect(compose).not.toHaveBeenCalled();
});
it('composes fresh instructions when replacing another provider session', async () => {
  expect(
    await selectSessionInstructions({
      provider: 'codex',
      isInteractiveCode: true,
      resumed: false,
      active: 'Claude snapshot',
      activeProvider: 'claude',
      currentGlobal: 'preferences',
      compose: () => Promise.resolve('rules'),
    }),
  ).toBe('preferences\n\nrules');
});
it('keeps preference ordering and tolerates optional read failure', async () => {
  expect(
    await selectSessionInstructions({
      provider: 'codex',
      isInteractiveCode: true,
      resumed: false,
      currentGlobal: 'preferences',
      compose: () => Promise.resolve('rules'),
    }),
  ).toBe('preferences\n\nrules');
  expect(
    await selectSessionInstructions({
      provider: 'codex',
      isInteractiveCode: true,
      resumed: false,
      currentGlobal: 'preferences',
      compose: () => Promise.reject(new Error('missing')),
    }),
  ).toBe('preferences');
});

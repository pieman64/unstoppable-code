import {
  resolveAppActivationTarget,
  resolveTrayOpenTarget,
  type ActivationWindow,
} from '../lifecycle/app-activation';

class FakeWindow implements ActivationWindow {
  destroyed = false;

  constructor(readonly name: string) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function focusHistory(
  ...windows: FakeWindow[]
): (window: FakeWindow) => number | undefined {
  return (window) => {
    const index = windows.indexOf(window);
    return index === -1 ? undefined : index + 1;
  };
}

describe('resolveAppActivationTarget', () => {
  it('recreates the main window when no window is open', () => {
    expect(
      resolveAppActivationTarget<FakeWindow>({
        mainWindow: null,
        remoteWindows: [],
        lastFocusedAt: focusHistory(),
      }),
    ).toEqual({ kind: 'recreate-main' });
  });

  it('focuses the open remote window when the main window was closed', () => {
    const remote = new FakeWindow('remote');

    expect(
      resolveAppActivationTarget({
        mainWindow: null,
        remoteWindows: [remote],
        lastFocusedAt: focusHistory(remote),
      }),
    ).toEqual({ kind: 'focus', window: remote });
  });

  it('focuses the open remote window when the main window is destroyed', () => {
    const main = new FakeWindow('main');
    main.destroyed = true;
    const remote = new FakeWindow('remote');

    expect(
      resolveAppActivationTarget({
        mainWindow: main,
        remoteWindows: [remote],
        lastFocusedAt: focusHistory(main),
      }),
    ).toEqual({ kind: 'focus', window: remote });
  });

  it('focuses the remote window when it was focused after the main window', () => {
    const main = new FakeWindow('main');
    const remote = new FakeWindow('remote');

    expect(
      resolveAppActivationTarget({
        mainWindow: main,
        remoteWindows: [remote],
        lastFocusedAt: focusHistory(main, remote),
      }),
    ).toEqual({ kind: 'focus', window: remote });
  });

  it('focuses the main window when it was focused after the remote window', () => {
    const main = new FakeWindow('main');
    const remote = new FakeWindow('remote');

    expect(
      resolveAppActivationTarget({
        mainWindow: main,
        remoteWindows: [remote],
        lastFocusedAt: focusHistory(remote, main),
      }),
    ).toEqual({ kind: 'focus', window: main });
  });

  it('ignores a destroyed window even when it was focused last', () => {
    const main = new FakeWindow('main');
    const older = new FakeWindow('older');
    const newer = new FakeWindow('newer');
    newer.destroyed = true;

    expect(
      resolveAppActivationTarget({
        mainWindow: main,
        remoteWindows: [older, newer],
        lastFocusedAt: focusHistory(main, older, newer),
      }),
    ).toEqual({ kind: 'focus', window: older });
  });

  it('prefers the main window when no window has focus history', () => {
    const main = new FakeWindow('main');
    const remote = new FakeWindow('remote');

    expect(
      resolveAppActivationTarget({
        mainWindow: main,
        remoteWindows: [remote],
        lastFocusedAt: focusHistory(),
      }),
    ).toEqual({ kind: 'focus', window: main });
  });

  it('prefers the newest remote window when none has focus history', () => {
    const older = new FakeWindow('older');
    const newer = new FakeWindow('newer');

    expect(
      resolveAppActivationTarget({
        mainWindow: null,
        remoteWindows: [older, newer],
        lastFocusedAt: focusHistory(),
      }),
    ).toEqual({ kind: 'focus', window: newer });
  });
});

describe('resolveTrayOpenTarget', () => {
  it('brings back a live main window hidden to the tray, even when a remote window was focused later', () => {
    const main = new FakeWindow('main');
    const remote = new FakeWindow('remote');

    expect(
      resolveTrayOpenTarget({
        mainWindow: main,
        remoteWindows: [remote],
        lastFocusedAt: focusHistory(main, remote),
      }),
    ).toEqual({ kind: 'focus', window: main });
  });

  it('focuses the most recently focused remote window when the main window is gone', () => {
    const older = new FakeWindow('older');
    const newer = new FakeWindow('newer');

    expect(
      resolveTrayOpenTarget({
        mainWindow: null,
        remoteWindows: [older, newer],
        lastFocusedAt: focusHistory(newer, older),
      }),
    ).toEqual({ kind: 'focus', window: older });
  });

  it('recreates the main window when no window is open', () => {
    expect(
      resolveTrayOpenTarget<FakeWindow>({
        mainWindow: null,
        remoteWindows: [],
        lastFocusedAt: focusHistory(),
      }),
    ).toEqual({ kind: 'recreate-main' });
  });
});

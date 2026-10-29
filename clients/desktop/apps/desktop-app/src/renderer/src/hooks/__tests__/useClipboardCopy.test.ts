import type * as ClipboardModule from '../../lib/clipboard';
import type * as UseClipboardCopyModule from '../useClipboardCopy';

type CopyTextToClipboard = typeof ClipboardModule.copyTextToClipboard;
type ClipboardCopyOptions = Parameters<
  typeof UseClipboardCopyModule.useClipboardCopy
>[0];
type ClipboardCopyResult = ReturnType<
  typeof UseClipboardCopyModule.useClipboardCopy
>;
type StateValue = boolean | string | null;
type StateSetter<T> = (value: T | ((previous: T) => T)) => void;
type TimerRef = { current: ReturnType<typeof setTimeout> | null };
type EffectCleanup = () => void;
type EffectCallback = () => void | EffectCleanup;
type Callback = (...args: never[]) => unknown;

const mockCopyTextToClipboard = jest.fn<
  ReturnType<CopyTextToClipboard>,
  Parameters<CopyTextToClipboard>
>();

interface ClipboardMockExports {
  copyTextToClipboard: CopyTextToClipboard;
}

interface ReactMockExports {
  useCallback: <T extends Callback>(callback: T) => T;
  useEffect: (effect: EffectCallback) => void;
  useRef: (initialValue: ReturnType<typeof setTimeout> | null) => TimerRef;
  useState: (initialValue: StateValue) => [StateValue, StateSetter<StateValue>];
}

class HookHarness {
  private effectCleanups: EffectCleanup[] = [];
  private refIndex = 0;
  private refs: Array<TimerRef | undefined> = [];
  private stateIndex = 0;
  private states: Array<StateValue | undefined> = [];

  beginRender(): void {
    this.refIndex = 0;
    this.stateIndex = 0;
  }

  unmount(): void {
    for (const cleanup of this.effectCleanups) {
      cleanup();
    }
    this.effectCleanups = [];
  }

  readonly useCallback = <T extends Callback>(callback: T): T => callback;

  readonly useEffect = (effect: EffectCallback): void => {
    const cleanup = effect();
    if (cleanup) {
      this.effectCleanups.push(cleanup);
    }
  };

  readonly useRef = (
    initialValue: ReturnType<typeof setTimeout> | null,
  ): TimerRef => {
    const index = this.refIndex;
    this.refIndex += 1;

    const existingRef = this.refs[index];
    if (existingRef) {
      return existingRef;
    }

    const ref: TimerRef = { current: initialValue };
    this.refs[index] = ref;
    return ref;
  };

  readonly useState = (
    initialValue: StateValue,
  ): [StateValue, StateSetter<StateValue>] => {
    const index = this.stateIndex;
    this.stateIndex += 1;

    if (typeof this.states[index] === 'undefined') {
      this.states[index] = initialValue;
    }

    const setState: StateSetter<StateValue> = (value): void => {
      const previousValue = this.states[index] ?? null;
      this.states[index] =
        typeof value === 'function' ? value(previousValue) : value;
    };

    return [this.states[index] ?? null, setState];
  };
}

interface LoadedClipboardHook {
  render: (options?: ClipboardCopyOptions) => ClipboardCopyResult;
  unmount: () => void;
}

async function loadClipboardHook(): Promise<LoadedClipboardHook> {
  jest.resetModules();

  const harness = new HookHarness();
  jest.doMock('react', (): ReactMockExports => {
    return {
      useCallback: harness.useCallback,
      useEffect: harness.useEffect,
      useRef: harness.useRef,
      useState: harness.useState,
    };
  });
  jest.doMock('@/lib/clipboard', (): ClipboardMockExports => {
    return { copyTextToClipboard: mockCopyTextToClipboard };
  });

  const module = await import('../useClipboardCopy');

  return {
    render: (options?: ClipboardCopyOptions): ClipboardCopyResult => {
      harness.beginRender();
      return module.useClipboardCopy(options);
    },
    unmount: (): void => {
      harness.unmount();
    },
  };
}

describe('useClipboardCopy', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockCopyTextToClipboard.mockReset();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('sets copied state and copiedKey when clipboard copy succeeds', async () => {
    mockCopyTextToClipboard.mockResolvedValue(true);
    const onCopy = jest.fn<void, []>();
    const options: ClipboardCopyOptions = {
      copiedDurationMs: 1000,
      onCopy,
    };
    const hook = await loadClipboardHook();

    let result = hook.render(options);
    await expect(result.copy('message body', 'message-1')).resolves.toBe(true);

    result = hook.render(options);
    expect(mockCopyTextToClipboard).toHaveBeenCalledWith('message body');
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(result.copied).toBe(true);
    expect(result.copiedKey).toBe('message-1');

    hook.unmount();
  });

  it('leaves copied state unchanged when clipboard copy fails', async () => {
    mockCopyTextToClipboard.mockResolvedValue(false);
    const onCopy = jest.fn<void, []>();
    const options: ClipboardCopyOptions = {
      copiedDurationMs: 1000,
      onCopy,
    };
    const hook = await loadClipboardHook();

    let result = hook.render(options);
    await expect(result.copy('message body', 'message-1')).resolves.toBe(false);

    result = hook.render(options);
    expect(onCopy).not.toHaveBeenCalled();
    expect(result.copied).toBe(false);
    expect(result.copiedKey).toBeNull();

    hook.unmount();
  });

  it('resets the active timer when copy is called repeatedly', async () => {
    mockCopyTextToClipboard.mockResolvedValue(true);
    const options: ClipboardCopyOptions = { copiedDurationMs: 100 };
    const hook = await loadClipboardHook();

    let result = hook.render(options);
    await result.copy('first body', 'first');
    jest.advanceTimersByTime(50);

    result = hook.render(options);
    await result.copy('second body', 'second');
    jest.advanceTimersByTime(99);

    result = hook.render(options);
    expect(result.copied).toBe(true);
    expect(result.copiedKey).toBe('second');

    jest.advanceTimersByTime(1);
    result = hook.render(options);
    expect(result.copied).toBe(false);
    expect(result.copiedKey).toBeNull();

    hook.unmount();
  });

  it('automatically clears copied state after copiedDurationMs', async () => {
    mockCopyTextToClipboard.mockResolvedValue(true);
    const options: ClipboardCopyOptions = { copiedDurationMs: 25 };
    const hook = await loadClipboardHook();

    let result = hook.render(options);
    await result.copy('message body', 'message-1');

    result = hook.render(options);
    expect(result.copied).toBe(true);
    expect(result.copiedKey).toBe('message-1');

    jest.advanceTimersByTime(24);
    result = hook.render(options);
    expect(result.copied).toBe(true);
    expect(result.copiedKey).toBe('message-1');

    jest.advanceTimersByTime(1);
    result = hook.render(options);
    expect(result.copied).toBe(false);
    expect(result.copiedKey).toBeNull();

    hook.unmount();
  });
});

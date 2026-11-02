/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AUTOSAVE_DELAY_MS,
  AUTOSAVE_SAVED_HOLD_MS,
  combineSaveStates,
  useAutosave,
  type UseAutosaveOptions,
} from '../useAutosave';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface HookHarness<P, R> {
  readonly result: { current: R };
  readonly rerender: (props: P) => void;
}

function renderHook<P, R>(
  hook: (props: P) => R,
  options: { initialProps: P },
): HookHarness<P, R> {
  let latest: { readonly value: R } | null = null;
  function Probe({ props }: { props: P }): JSX.Element | null {
    latest = { value: hook(props) };
    return null;
  }
  const result = {
    get current(): R {
      if (latest === null) throw new Error('The hook has not rendered.');
      return latest.value;
    },
  };
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe props={options.initialProps} />));
  return {
    result,
    rerender: (props: P): void => {
      act(() => root.render(<Probe props={props} />));
    },
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve = (): void => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useAutosave', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('saves once the edits pause, then rests', async () => {
    const write = deferred();
    const save = jest.fn().mockReturnValue(write.promise);
    const { result, rerender } = renderHook<
      UseAutosaveOptions,
      ReturnType<typeof useAutosave>
    >((props: UseAutosaveOptions) => useAutosave(props), {
      initialProps: { pending: null, save },
    });
    expect(result.current.state).toBe('idle');

    rerender({ pending: 'a', save });
    await act(async () => {
      jest.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
      await Promise.resolve();
    });
    rerender({ pending: 'ab', save });
    await act(async () => {
      jest.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
      await Promise.resolve();
    });
    expect(save).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('saving');
    rerender({ pending: null, save });
    await act(async () => {
      write.resolve();
      await write.promise;
    });
    await flushMicrotasks();
    expect(result.current.state).toBe('saved');

    await act(async () => {
      jest.advanceTimersByTime(AUTOSAVE_SAVED_HOLD_MS);
      await Promise.resolve();
    });
    expect(result.current.state).toBe('idle');
  });

  it('holds a draft that cannot be written yet', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook<
      UseAutosaveOptions,
      ReturnType<typeof useAutosave>
    >((props: UseAutosaveOptions) => useAutosave(props), {
      initialProps: { pending: 'a', enabled: false, save },
    });
    await act(async () => {
      jest.advanceTimersByTime(AUTOSAVE_DELAY_MS * 3);
      await Promise.resolve();
    });
    expect(save).not.toHaveBeenCalled();
    rerender({ pending: 'a', enabled: true, save });
    await act(async () => {
      jest.advanceTimersByTime(AUTOSAVE_DELAY_MS);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('writes a change made during a save right after it', async () => {
    const first = deferred();
    const save = jest
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const { result, rerender } = renderHook<
      UseAutosaveOptions,
      ReturnType<typeof useAutosave>
    >((props: UseAutosaveOptions) => useAutosave(props), {
      initialProps: { pending: 'a', save },
    });
    await act(async () => {
      jest.advanceTimersByTime(AUTOSAVE_DELAY_MS);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);

    rerender({ pending: 'ab', save });
    await act(async () => {
      jest.advanceTimersByTime(AUTOSAVE_DELAY_MS);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve();
      await first.promise;
    });
    await flushMicrotasks();
    expect(save).toHaveBeenCalledTimes(2);
    rerender({ pending: null, save });
    await flushMicrotasks();
    expect(result.current.state).toBe('saved');
  });

  it('reports a failed write and keeps the draft for the next change', async () => {
    const save = jest
      .fn()
      .mockRejectedValueOnce(new Error('Disk full'))
      .mockResolvedValue(undefined);
    const { result, rerender } = renderHook<
      UseAutosaveOptions,
      ReturnType<typeof useAutosave>
    >((props: UseAutosaveOptions) => useAutosave(props), {
      initialProps: { pending: 'a', save },
    });
    await act(async () => {
      jest.advanceTimersByTime(AUTOSAVE_DELAY_MS);
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('Disk full');

    // No retry loop on the same draft.
    await act(async () => {
      jest.advanceTimersByTime(AUTOSAVE_DELAY_MS * 3);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);

    rerender({ pending: 'ab', save });
    await act(async () => {
      jest.advanceTimersByTime(AUTOSAVE_DELAY_MS);
      await Promise.resolve();
    });
    await flushMicrotasks();
    expect(save).toHaveBeenCalledTimes(2);
    expect(result.current.state).toBe('saved');
    expect(result.current.error).toBeNull();
  });

  it('flushes a pending draft without waiting for the delay', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook<
      UseAutosaveOptions,
      ReturnType<typeof useAutosave>
    >((props: UseAutosaveOptions) => useAutosave(props), {
      initialProps: { pending: 'a', save },
    });
    await act(async () => {
      await result.current.flush();
    });
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(AUTOSAVE_DELAY_MS);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('useAutosave flush result', () => {
  it('resolves true when the pending draft is written', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook<
      UseAutosaveOptions,
      ReturnType<typeof useAutosave>
    >((props: UseAutosaveOptions) => useAutosave(props), {
      initialProps: { pending: 'a', save },
    });
    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.flush();
    });
    expect(saved).toBe(true);
  });

  it('resolves false when the write fails, so the page can stay open', async () => {
    const save = jest.fn().mockRejectedValue(new Error('Disk full'));
    const { result } = renderHook<
      UseAutosaveOptions,
      ReturnType<typeof useAutosave>
    >((props: UseAutosaveOptions) => useAutosave(props), {
      initialProps: { pending: 'a', save },
    });
    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.flush();
    });
    expect(saved).toBe(false);
    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('Disk full');
  });

  it('resolves false for a held draft, without writing it', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook<
      UseAutosaveOptions,
      ReturnType<typeof useAutosave>
    >((props: UseAutosaveOptions) => useAutosave(props), {
      initialProps: { pending: 'a', enabled: false, save },
    });
    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.flush();
    });
    expect(saved).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('resolves false when a save already running fails, even if it dropped the draft', async () => {
    jest.useFakeTimers();
    const write = deferred();
    const save = jest.fn().mockReturnValue(write.promise);
    const { result, rerender } = renderHook<
      UseAutosaveOptions,
      ReturnType<typeof useAutosave>
    >((props: UseAutosaveOptions) => useAutosave(props), {
      initialProps: { pending: 'a', save },
    });
    await act(async () => {
      jest.advanceTimersByTime(AUTOSAVE_DELAY_MS);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
    // The refusal clears the draft (as a Private memory refusal does), so
    // nothing is pending once the running save settles.
    rerender({ pending: null, save });
    let saved: boolean | undefined;
    await act(async () => {
      const flushed = result.current.flush();
      write.reject(new Error('Refused'));
      saved = await flushed;
    });
    expect(saved).toBe(false);
    expect(result.current.state).toBe('error');
    jest.useRealTimers();
  });

  it('does not write the draft it just saved again while its reload is on the way', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook<
      UseAutosaveOptions,
      ReturnType<typeof useAutosave>
    >((props: UseAutosaveOptions) => useAutosave(props), {
      initialProps: { pending: 'a', save },
    });
    await act(async () => {
      await result.current.flush();
    });
    expect(save).toHaveBeenCalledTimes(1);
    // The saved value has not reloaded yet, so 'a' is still pending.
    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.flush();
    });
    expect(saved).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    // Once it reloads and the same draft is made again, it is written.
    rerender({ pending: null, save });
    rerender({ pending: 'a', save });
    await act(async () => {
      await result.current.flush();
    });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('resolves true when nothing is pending', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook<
      UseAutosaveOptions,
      ReturnType<typeof useAutosave>
    >((props: UseAutosaveOptions) => useAutosave(props), {
      initialProps: { pending: null, save },
    });
    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.flush();
    });
    expect(saved).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('combineSaveStates', () => {
  it('shows the most urgent state across writers', () => {
    expect(combineSaveStates(['idle', 'saved', 'saving'])).toBe('saving');
    expect(combineSaveStates(['saved', 'error'])).toBe('error');
    expect(combineSaveStates(['idle', 'saved'])).toBe('saved');
    expect(combineSaveStates([])).toBe('idle');
  });
});

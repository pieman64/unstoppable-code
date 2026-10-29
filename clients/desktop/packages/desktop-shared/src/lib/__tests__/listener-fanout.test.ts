import { createListenerFanout } from '../listener-fanout';

describe('createListenerFanout', () => {
  it('attaches one source listener for any number of subscribers', () => {
    let dispatch: ((value: number) => void) | undefined;
    const detach = jest.fn();
    const attach = jest.fn((next: (value: number) => void) => {
      dispatch = next;
      return detach;
    });
    const subscribe = createListenerFanout(attach);
    const first = jest.fn();
    const second = jest.fn();
    const third = jest.fn();
    const unsubscribeFirst = subscribe(first);
    const unsubscribeSecond = subscribe(second);
    const unsubscribeThird = subscribe(third);
    expect(attach).toHaveBeenCalledTimes(1);

    dispatch?.(1);
    unsubscribeSecond();
    unsubscribeSecond();
    dispatch?.(2);

    expect(first.mock.calls).toEqual([[1], [2]]);
    expect(second.mock.calls).toEqual([[1]]);
    expect(third.mock.calls).toEqual([[1], [2]]);
    expect(detach).not.toHaveBeenCalled();

    unsubscribeFirst();
    unsubscribeThird();
    expect(detach).toHaveBeenCalledTimes(1);

    subscribe(first);
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it('delivers to subscribers in subscription order, including the same function twice', () => {
    let dispatch: ((value: string) => void) | undefined;
    const subscribe = createListenerFanout<string>((next) => {
      dispatch = next;
      return (): void => undefined;
    });
    const seen: string[] = [];
    const twice = (value: string): void => {
      seen.push(`twice:${value}`);
    };
    subscribe(twice);
    subscribe((value) => seen.push(`other:${value}`));
    subscribe(twice);
    dispatch?.('a');
    expect(seen).toEqual(['twice:a', 'other:a', 'twice:a']);
  });

  it('keeps delivering to later subscribers when one throws, and reports the error', async () => {
    let dispatch: ((value: number) => void) | undefined;
    const subscribe = createListenerFanout<number>((next) => {
      dispatch = next;
      return (): void => undefined;
    });
    const later = jest.fn();
    subscribe(() => {
      throw new Error('subscriber failed');
    });
    subscribe(later);
    const reported = new Promise<unknown>((resolve) => {
      const original = globalThis.queueMicrotask;
      globalThis.queueMicrotask = (callback): void => {
        globalThis.queueMicrotask = original;
        try {
          callback();
        } catch (error) {
          resolve(error);
        }
      };
    });
    dispatch?.(1);
    expect(later).toHaveBeenCalledWith(1);
    await expect(reported).resolves.toEqual(new Error('subscriber failed'));
  });

  it('does not deliver to a subscriber added or removed during a dispatch until the next one', () => {
    let dispatch: ((value: number) => void) | undefined;
    const subscribe = createListenerFanout<number>((next) => {
      dispatch = next;
      return (): void => undefined;
    });
    const added = jest.fn();
    const removed = jest.fn();
    let unsubscribeRemoved: () => void = () => undefined;
    subscribe(() => {
      subscribe(added);
      unsubscribeRemoved();
    });
    unsubscribeRemoved = subscribe(removed);
    dispatch?.(1);
    expect(added).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledWith(1);
    dispatch?.(2);
    expect(added).toHaveBeenCalledWith(2);
    expect(removed).toHaveBeenCalledTimes(1);
  });
});

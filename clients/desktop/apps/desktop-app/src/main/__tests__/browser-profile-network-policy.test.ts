import type { Session } from 'electron';
import { BrowserProfileNetworkPolicy } from '../browser/network-policy';
it('keeps one network listener and admits only owned control targets while paused', () => {
  type Listener = (
    details: { webContentsId: number },
    callback: (response: { cancel?: boolean }) => void,
  ) => void;
  let listener: Listener | undefined;
  let registrations = 0;
  const policy = new BrowserProfileNetworkPolicy({
    webRequest: {
      onBeforeRequest: (value: Listener): void => {
        registrations++;
        listener = value;
      },
    },
  } as unknown as Session);
  const cancelled = (id: number): boolean | undefined => {
    let result: boolean | undefined;
    if (!listener) throw new Error('Missing policy listener');
    listener({ webContentsId: id }, (value) => {
      result = value.cancel;
    });
    return result;
  };
  expect(cancelled(1)).toBe(false);
  policy.fence();
  expect(cancelled(1)).toBe(true);
  const release = policy.allowControl(7);
  expect(cancelled(7)).toBe(false);
  expect(cancelled(0)).toBe(true);
  expect(() => policy.resume()).toThrow('verification');
  release();
  expect(cancelled(7)).toBe(true);
  policy.resume();
  expect(cancelled(1)).toBe(false);
  expect(registrations).toBe(1);
});

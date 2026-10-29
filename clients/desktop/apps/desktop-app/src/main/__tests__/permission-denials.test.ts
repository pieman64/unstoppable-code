import type { WebContents } from 'electron';
import {
  denyPermission,
  onPermissionDenied,
} from '../browser/permission-denials';

describe('denyPermission', () => {
  it('denies every request and reports it to each listener until it unsubscribes', () => {
    const contents = {} as WebContents;
    const seen: string[] = [];
    const stop = onPermissionDenied((from, permission) => {
      expect(from).toBe(contents);
      seen.push(permission);
    });
    const callback = jest.fn();
    denyPermission(contents, 'geolocation', callback);
    expect(callback).toHaveBeenCalledWith(false);
    stop();
    denyPermission(contents, 'notifications', callback);
    expect(seen).toEqual(['geolocation']);
  });
});

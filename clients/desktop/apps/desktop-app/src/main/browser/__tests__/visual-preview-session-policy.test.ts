/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/explicit-function-return-type, @typescript-eslint/unbound-method -- Jest mock callback slots are dynamically typed. */
import {
  getVisualPreviewSessionPolicy,
  isAllowedVisualPreviewRequest,
  VisualPreviewSessionPolicy,
} from '../visual-preview-session-policy';
import { session, type Session } from 'electron';

jest.mock('electron', () => ({ session: { fromPartition: jest.fn() } }));

describe('visual preview request policy', () => {
  it('accepts only exact HTTPS CDN origins', () => {
    expect(
      isAllowedVisualPreviewRequest('https://cdn.jsdelivr.net/npm/d3'),
    ).toBe(true);
    expect(isAllowedVisualPreviewRequest('https://unpkg.com/x')).toBe(true);
    expect(
      isAllowedVisualPreviewRequest('https://cdnjs.cloudflare.com/x'),
    ).toBe(true);
    expect(isAllowedVisualPreviewRequest('https://CDN.JSDELIVR.NET/x')).toBe(
      true,
    );
    for (const url of [
      'https://cdn.jsdelivr.net.evil.test/x',
      'https://cdn.jsdelivr.net@evil.test/x',
      'https://cdn.jsdelivr.net:444/x',
      'http://cdn.jsdelivr.net/x',
      'https://cdn.jsdelivr.net./x',
      'file:///etc/passwd',
      'https://127.0.0.1/x',
      'https://192.168.1.1/x',
      'data:text/plain,hello',
    ])
      expect(isAllowedVisualPreviewRequest(url)).toBe(false);
  });

  it('keeps the only listener and attributes blocked requests to active contents', () => {
    let listener:
      | ((
          details: { url: string; webContentsId?: number },
          callback: (decision: { cancel: boolean }) => void,
        ) => void)
      | undefined;
    let download: ((event: { preventDefault: () => void }) => void) | undefined;
    const native = {
      webRequest: {
        onBeforeRequest: jest.fn((callback) => {
          listener = callback;
        }),
      },
      setPermissionRequestHandler: jest.fn(),
      setPermissionCheckHandler: jest.fn(),
      setDevicePermissionHandler: jest.fn(),
      on: jest.fn((_name, callback) => {
        download = callback;
      }),
    };
    const policy = new VisualPreviewSessionPolicy(native as unknown as Session);
    const a = { urls: [], omitted: 0 };
    const b = { urls: [], omitted: 0 };
    const unregisterA = policy.register(1, a);
    policy.register(2, b);
    const callback = jest.fn();
    listener?.(
      { url: 'https://cdn.jsdelivr.net/npm/d3', webContentsId: 1 },
      callback,
    );
    expect(callback).toHaveBeenLastCalledWith({ cancel: false });
    listener?.(
      { url: 'https://user:pass@evil.test/x?secret=1', webContentsId: 1 },
      callback,
    );
    expect(callback).toHaveBeenLastCalledWith({ cancel: true });
    expect(a.urls).toEqual(['https://evil.test/x']);
    unregisterA();
    listener?.(
      { url: 'http://127.0.0.1/secret?token=abc', webContentsId: 2 },
      callback,
    );
    expect(b.urls).toEqual(['http://127.0.0.1/secret']);
    listener?.({ url: 'file:///tmp/x', webContentsId: 1 }, callback);
    expect(a.urls).toHaveLength(1);
    for (let index = 0; index < 55; index++) {
      listener?.(
        { url: `https://evil.test/${index}?secret=1`, webContentsId: 2 },
        callback,
      );
    }
    expect(b.urls).toHaveLength(50);
    expect(b.omitted).toBe(6);
    expect(b.urls.some((url) => url.includes('?'))).toBe(false);
    expect(native.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(native.webRequest.onBeforeRequest.mock.calls[0]).toHaveLength(1);
    expect(native.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
    expect(native.setDevicePermissionHandler.mock.calls[0][0]()).toBe(false);
    const permitted = jest.fn();
    native.setPermissionRequestHandler.mock.calls[0][0](
      null,
      'camera',
      permitted,
    );
    expect(permitted).toHaveBeenCalledWith(false);
    const preventDefault = jest.fn();
    download?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
  });

  it('creates one non-persistent partition and keeps its single listener', () => {
    const native = {
      webRequest: { onBeforeRequest: jest.fn() },
      setPermissionRequestHandler: jest.fn(),
      setPermissionCheckHandler: jest.fn(),
      setDevicePermissionHandler: jest.fn(),
      on: jest.fn(),
      isPersistent: () => false,
    };
    jest
      .mocked(session.fromPartition)
      .mockReturnValue(native as unknown as Session);
    expect(getVisualPreviewSessionPolicy()).toBe(
      getVisualPreviewSessionPolicy(),
    );
    expect(session.fromPartition).toHaveBeenCalledTimes(1);
    expect(session.fromPartition).toHaveBeenCalledWith('visual-preview');
    expect(native.isPersistent()).toBe(false);
    expect(native.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
  });
});

import { safeRemoteImageUrl } from '../remote-image';

describe('safeRemoteImageUrl', () => {
  it('allows only cached raster image data URLs', () => {
    expect(safeRemoteImageUrl('data:image/png;base64,aGVsbG8=')).toBe(
      'data:image/png;base64,aGVsbG8=',
    );
    expect(safeRemoteImageUrl('https://cdn.example.test/logo.png')).toBeNull();
    expect(safeRemoteImageUrl('http://cdn.example.test/logo.png')).toBeNull();
    expect(safeRemoteImageUrl('file:///etc/passwd')).toBeNull();
    expect(safeRemoteImageUrl('data:image/svg+xml,<svg/>')).toBeNull();
    expect(safeRemoteImageUrl('not a url')).toBeNull();
  });
});

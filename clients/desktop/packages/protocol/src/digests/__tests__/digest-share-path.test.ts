import { DIGEST_SHARE_PATH_PREFIX, digestSharePath } from '../index';

describe('digest share paths', () => {
  it('uses the reserved public-share segment', () => {
    expect(DIGEST_SHARE_PATH_PREFIX).toBe('/share/digests');
    expect(digestSharePath('digest-slug')).toBe('/share/digests/digest-slug');
  });
});

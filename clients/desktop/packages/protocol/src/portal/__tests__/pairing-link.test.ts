import {
  buildRemoteControlPairingUrl,
  PORTAL_PAIRING_CODE_PATTERN,
  readRemoteControlPairingCode,
  REMOTE_CONTROL_PAIRING_PATH,
} from '../index';

describe('buildRemoteControlPairingUrl (CAN-2938)', () => {
  it('carries the code in the fragment of the pairing page on the cloud origin', () => {
    expect(
      buildRemoteControlPairingUrl('https://app.example.test', '012345'),
    ).toBe('https://app.example.test/portal/pair#code=012345');
    expect(REMOTE_CONTROL_PAIRING_PATH).toBe('/portal/pair');
  });

  it('never puts the code in the path or query string', () => {
    const built = buildRemoteControlPairingUrl(
      'https://app.example.test',
      '987654',
    );
    if (built === null) throw new Error('expected a URL');
    const url = new URL(built);
    expect(url.pathname).toBe(REMOTE_CONTROL_PAIRING_PATH);
    expect(url.search).toBe('');
    expect(url.hash).toBe('#code=987654');
  });

  it('drops any path, query, or fragment already on the base URL', () => {
    expect(
      buildRemoteControlPairingUrl(
        'http://127.0.0.1:3100/some/path/?x=1#frag',
        '000000',
      ),
    ).toBe('http://127.0.0.1:3100/portal/pair#code=000000');
  });

  it('refuses malformed codes and non-web base URLs', () => {
    expect(buildRemoteControlPairingUrl('https://a.test', '12345')).toBeNull();
    expect(
      buildRemoteControlPairingUrl('https://a.test', '1234567'),
    ).toBeNull();
    expect(buildRemoteControlPairingUrl('https://a.test', 'abcdef')).toBeNull();
    expect(buildRemoteControlPairingUrl('not a url', '123456')).toBeNull();
    expect(buildRemoteControlPairingUrl('javascript:alert(1)', '123456')).toBe(
      null,
    );
    expect(buildRemoteControlPairingUrl('file:///tmp', '123456')).toBeNull();
  });
});

describe('readRemoteControlPairingCode (CAN-2938)', () => {
  it('reads the code from a fragment with or without the leading #', () => {
    expect(readRemoteControlPairingCode('#code=123456')).toBe('123456');
    expect(readRemoteControlPairingCode('code=654321')).toBe('654321');
  });

  it('returns null for a missing, empty, or malformed code', () => {
    expect(readRemoteControlPairingCode('')).toBeNull();
    expect(readRemoteControlPairingCode('#')).toBeNull();
    expect(readRemoteControlPairingCode('#code=')).toBeNull();
    expect(readRemoteControlPairingCode('#code=12345')).toBeNull();
    expect(readRemoteControlPairingCode('#code=12345a')).toBeNull();
    expect(readRemoteControlPairingCode('#other=123456')).toBeNull();
    expect(readRemoteControlPairingCode('#code=123456&code=654321')).toBeNull();
  });

  it('round-trips with the builder', () => {
    const built = buildRemoteControlPairingUrl('https://a.test', '424242');
    if (built === null) throw new Error('expected a URL');
    expect(readRemoteControlPairingCode(new URL(built).hash)).toBe('424242');
    expect(PORTAL_PAIRING_CODE_PATTERN.test('424242')).toBe(true);
  });
});

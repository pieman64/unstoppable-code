import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { linkUrlForLocalOpen } from '../client/local-links';

describe('linkUrlForLocalOpen', () => {
  it('opens http(s) links from remote windows locally', () => {
    expect(
      linkUrlForLocalOpen(IPC_CHANNELS.browserOpenLink, [
        { url: 'https://example.com/a' },
      ]),
    ).toBe('https://example.com/a');
    expect(
      linkUrlForLocalOpen(IPC_CHANNELS.browserOpenExternal, [
        { url: 'http://localhost:3000' },
      ]),
    ).toBe('http://localhost:3000');
  });

  it('ignores other channels and unsafe URLs', () => {
    expect(
      linkUrlForLocalOpen(IPC_CHANNELS.browserNavigate, [
        { url: 'https://example.com' },
      ]),
    ).toBeNull();
    expect(
      linkUrlForLocalOpen(IPC_CHANNELS.browserOpenLink, [
        { url: 'file:///etc/passwd' },
      ]),
    ).toBeNull();
    expect(linkUrlForLocalOpen(IPC_CHANNELS.browserOpenLink, [])).toBeNull();
  });
});

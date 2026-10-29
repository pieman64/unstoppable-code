import { findProviderAuthorizationUrl } from '../authAuthorizationUrl';

describe('findProviderAuthorizationUrl', () => {
  it('extracts the displayed Claude authorization URL from an OSC-8 terminal link', () => {
    const url =
      'https://claude.com/cai/oauth/authorize?client_id=client&state=state';
    const output = `Opening browser\r\n\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007\r\n`;

    expect(findProviderAuthorizationUrl('claude', output)).toBe(url);
  });

  it('waits for a URL delimiter so a split Codex output chunk is not opened early', () => {
    const partial = 'https://auth.openai.com/oauth/authorize?state=part';
    expect(findProviderAuthorizationUrl('codex', partial)).toBeNull();
    expect(findProviderAuthorizationUrl('codex', `${partial}ial\r\n`)).toBe(
      `${partial}ial`,
    );
  });

  it('rejects unrelated and lookalike authorization hosts', () => {
    expect(
      findProviderAuthorizationUrl(
        'codex',
        'https://auth.openai.com.evil.test/oauth/authorize?state=x\r\n',
      ),
    ).toBeNull();
    expect(
      findProviderAuthorizationUrl(
        'claude',
        'https://example.com/cai/oauth/authorize?state=x\r\n',
      ),
    ).toBeNull();
  });
});

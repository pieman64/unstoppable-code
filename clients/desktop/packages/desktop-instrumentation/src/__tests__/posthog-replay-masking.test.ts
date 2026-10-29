/** @jest-environment jsdom */
import {
  maskReplayAttribute,
  recordReplayText,
} from '../client/posthog-replay-masking';
import { POSTHOG_REPLAY_MASK_CLASS } from '../posthog-replay-privacy';

const secret = 'alice@example.com';

describe('replay text recording', () => {
  it('records ordinary text verbatim', () => {
    for (const text of [
      'Hello \n world!',
      secret,
      'https://github.com/acme/canopy/pull/12',
      'Basic plan',
      'Re-authenticate to continue',
      'npm run test -- --watch',
    ]) {
      expect(recordReplayText(text)).toBe(text);
    }
  });

  it.each([
    [
      'https://x-access-token:ghp_abc123@github.com/acme/repo.git',
      'https://***@github.com/acme/repo.git',
    ],
    [
      'http://localhost:8888/lab?token=abc123&path=x',
      'http://localhost:8888/lab?token=***&path=***',
    ],
    [
      'curl -H "Authorization: Bearer sk-live-abcdef123456" api',
      'curl -H "Authorization: ***" api',
    ],
    ['{"Authorization": "Basic dXNlcjpwYXNz"}', '{"Authorization": "***"}'],
    [
      'Authorization: AWS4-HMAC-SHA256 Credential=AKIA/20261006, Signature=abc123',
      'Authorization: ***',
    ],
    ['Bearer sk-live-abcdef123456', 'Bearer ***'],
    ['OPENAI_API_KEY=sk-abc123 npm start', 'OPENAI_API_KEY=*** npm start'],
    [
      'mcp-server --api-key sk-abc123 --port 3000',
      'mcp-server --api-key *** --port 3000',
    ],
    ['deploy --token="abc 123"', 'deploy --token=***'],
  ])('redacts credentials in %s', (text, redacted) => {
    expect(recordReplayText(text)).toBe(redacted);
  });
});

describe('replay title masking', () => {
  function titleInside(): HTMLElement {
    const title = document.createElement('span');
    title.className = POSTHOG_REPLAY_MASK_CLASS;
    const inner = document.createElement('b');
    title.append(inner);
    return inner;
  }

  it('replaces every visible character of a masked title, keeping spaces', () => {
    const title = document.createElement('span');
    title.className = `truncate ${POSTHOG_REPLAY_MASK_CLASS}`;
    expect(recordReplayText('Board thread q7x', title)).toBe(
      '***** ****** ***',
    );
  });

  it('masks text nested anywhere inside a masked title', () => {
    expect(recordReplayText('private/q7x-board', titleInside())).toBe(
      '*****************',
    );
  });

  it('records text outside a masked title', () => {
    const label = document.createElement('span');
    expect(recordReplayText('Board thread q7x', label)).toBe(
      'Board thread q7x',
    );
    expect(recordReplayText('Board thread q7x', null)).toBe('Board thread q7x');
    expect(recordReplayText('Board thread q7x')).toBe('Board thread q7x');
  });
});

describe('replay attribute masking', () => {
  const element = document.createElement('div');

  it.each([
    'class',
    'style',
    'id',
    'href',
    'src',
    'title',
    'alt',
    'placeholder',
    'aria-label',
    'data-testid',
    'data-state',
    'role',
    'rr_width',
  ])('records %s verbatim', (name) => {
    expect(maskReplayAttribute(name, secret, element)).toBe(secret);
  });

  it('masks value attributes, case-insensitively, without revealing length', () => {
    expect(maskReplayAttribute('value', secret, element)).toBe('********');
    expect(maskReplayAttribute('VALUE', secret, element)).toBe('********');
    expect(maskReplayAttribute('value', 'x'.repeat(1000), element)).toBe(
      '********',
    );
  });

  it('redacts credentials in recorded attributes', () => {
    expect(
      maskReplayAttribute(
        'title',
        'Open http://localhost:8888/?token=abc123',
        element,
      ),
    ).toBe('Open http://localhost:8888/?token=***');
  });

  it('passes empty and null values through', () => {
    expect(maskReplayAttribute('value', '', element)).toBe('');
    expect(maskReplayAttribute('src', null, element)).toBeNull();
  });

  it('drops local file URLs from any attribute', () => {
    expect(
      maskReplayAttribute(
        'src',
        'file:///Users/alice/Applications/Canopy.app/logo.png',
        element,
      ),
    ).toBe('');
    expect(
      maskReplayAttribute(
        'style',
        'background: url("file:///Users/alice/a.png"); color: red',
        element,
      ),
    ).toBe('background: url(); color: red');
    expect(
      maskReplayAttribute('srcset', 'file:///Users/alice/a.png 2x', element),
    ).not.toContain('file://');
    expect(maskReplayAttribute('href', 'https://example.test/a', element)).toBe(
      'https://example.test/a',
    );
  });

  it('keeps stylesheet CSS while removing local file URLs', () => {
    const css =
      '@font-face { src: url("file:///Users/alice/My App/font.woff2"); } .x { color: red }';
    const result = maskReplayAttribute('_cssText', css, element);
    expect(result).toContain('.x { color: red }');
    expect(result).not.toContain('file://');
    expect(maskReplayAttribute('_cssText', '.x{color:red}', element)).toBe(
      '.x{color:red}',
    );
    expect(
      maskReplayAttribute(
        '_cssText',
        '@import "file:///Users/alice/private.css";',
        element,
      ),
    ).not.toContain('file://');
  });
});

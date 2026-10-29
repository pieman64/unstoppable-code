import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { BRAND } from '@canopy/brand/current';
import {
  renderBrandedCallbackPage,
  writeBrandedCallbackPage,
} from '../lib/branded-callback-page';
import { writeMcpOAuthCallbackPage } from '../mcp/oauth-callback-page';

const HOSTILE = `<img src=x onerror="alert('xss')">`;

describe('renderBrandedCallbackPage', () => {
  it('renders the success tone with brand lockup and both token blocks', () => {
    const html = renderBrandedCallbackPage({
      tone: 'success',
      title: 'Desktop connected',
      message: [
        { text: `You're signed in as ` },
        { text: 'Ada Lovelace', emphasis: true },
        { text: `. ${BRAND.displayName} Desktop is ready to go.` },
      ],
      hint: 'You can close this tab.',
    });

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('<h1>Desktop connected</h1>');
    expect(html).toContain('<strong>Ada Lovelace</strong>');
    expect(html).toContain(BRAND.displayName);
    // Light tokens on :root, dark tokens behind the media query.
    expect(html).toContain(`--bg-base:${BRAND.theme.default.light.bgBase}`);
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain(`--bg-base:${BRAND.theme.default.dark.bgBase}`);
    // Success uses the accent tone, not destructive.
    expect(html).toContain('background:var(--bg-accent-subtle)');
    expect(html).not.toContain('background:var(--bg-destructive-subtle)');
  });

  it('renders the error tone with a detail line', () => {
    const html = renderBrandedCallbackPage({
      tone: 'error',
      title: `Couldn't connect`,
      message: 'Head back and try again.',
      detail: 'The sign-in response was incomplete.',
    });

    expect(html).toContain('background:var(--bg-destructive-subtle)');
    expect(html).toContain(
      '<p class="detail">The sign-in response was incomplete.</p>',
    );
    expect(html).toContain('Couldn&#39;t connect');
  });

  it('defaults the hint line when none is supplied', () => {
    const html = renderBrandedCallbackPage({
      tone: 'success',
      title: 'Connected',
      message: 'Done.',
    });

    expect(html).toContain('<p class="hint">You can close this tab.</p>');
  });

  it('escapes hostile emphasis and detail everywhere they appear', () => {
    const html = renderBrandedCallbackPage({
      tone: 'error',
      title: HOSTILE,
      message: [
        { text: 'Signed in as ' },
        { text: HOSTILE, emphasis: true },
        { text: ' somehow.' },
      ],
      detail: HOSTILE,
    });

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onerror="alert');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)');
    // The emphasis still wraps the (escaped) fragment inside the body.
    expect(html).toContain('<strong>&lt;img src=x');
  });

  it('renders a plain string message with no emphasis markup', () => {
    const html = renderBrandedCallbackPage({
      tone: 'success',
      title: 'Connected',
      message: 'All set.',
    });

    expect(html).toContain('<p class="message">All set.</p>');
    expect(html).not.toContain('<strong>');
  });

  it('escapes each segment independently so a value cannot collide with an entity', () => {
    const html = renderBrandedCallbackPage({
      tone: 'success',
      title: 'Connected',
      message: [
        { text: `You're signed in as ` },
        { text: '39', emphasis: true },
        { text: '.' },
      ],
    });

    expect(html).toContain(
      `<p class="message">You&#39;re signed in as <strong>39</strong>.</p>`,
    );
    expect(html).not.toContain('&#<strong>39</strong>;');
  });

  it('emphasizes by position, not by substring match', () => {
    // Regression: a substring search would bold the leading "in" of "signed in"
    // instead of the account name, producing "signed <strong>in</strong> as in".
    const html = renderBrandedCallbackPage({
      tone: 'success',
      title: 'Connected',
      message: [
        { text: `You're signed in as ` },
        { text: 'in', emphasis: true },
        { text: '. Ready to go.' },
      ],
    });

    expect(html).toContain(
      `<p class="message">You&#39;re signed in as <strong>in</strong>. Ready to go.</p>`,
    );
    expect(html).not.toContain('signed <strong>in</strong> as');
  });

  it('toggles the query-scrub script', () => {
    const base = {
      tone: 'success',
      title: 'Connected',
      message: 'Done.',
    } as const;

    expect(renderBrandedCallbackPage({ ...base, scrubQuery: true })).toContain(
      "history.replaceState({}, '', location.pathname)",
    );
    expect(renderBrandedCallbackPage(base)).not.toContain(
      'history.replaceState',
    );
  });

  it('includes the glyph backdrop with a reduced-motion opt-out', () => {
    const html = renderBrandedCallbackPage({
      tone: 'success',
      title: 'Connected',
      message: 'Done.',
    });

    expect(html).toContain('class="backdrop"');
    expect(html).toContain('@keyframes glyph-twinkle');
    expect(html).toContain(
      '@media (prefers-reduced-motion: reduce){.glyph-twinkle{animation:none}}',
    );
    // 20 rows x 36 chunks of deterministic glyph spans.
    expect(html.split('class="glyph-twinkle"').length - 1).toBe(20 * 36);
  });

  it('is deterministic across renders', () => {
    const options = {
      tone: 'success',
      title: 'Connected',
      message: 'Done.',
    } as const;

    expect(renderBrandedCallbackPage(options)).toBe(
      renderBrandedCallbackPage(options),
    );
  });
});

describe('writeBrandedCallbackPage', () => {
  it('sets no-store, no-referrer, nosniff, a CSP, and a charset', () => {
    const response = new ServerResponse(new IncomingMessage(new Socket()));
    const writeHead = jest.spyOn(response, 'writeHead').mockReturnThis();
    const end = jest.spyOn(response, 'end').mockReturnThis();

    writeBrandedCallbackPage(response, 200, {
      tone: 'success',
      title: 'Connected',
      message: 'Done.',
    });

    expect(writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    expect(end).toHaveBeenCalledTimes(1);
    expect(String(end.mock.calls[0][0])).toContain('<h1>Connected</h1>');
  });

  it('blocks every network subresource for a page holding an auth code', () => {
    const response = new ServerResponse(new IncomingMessage(new Socket()));
    const writeHead = jest.spyOn(response, 'writeHead').mockReturnThis();
    jest.spyOn(response, 'end').mockReturnThis();

    writeBrandedCallbackPage(response, 200, {
      tone: 'success',
      title: 'Connected',
      message: 'Done.',
      scrubQuery: true,
    });

    const headers: unknown = writeHead.mock.calls[0][1];
    if (typeof headers !== 'object' || headers === null) {
      throw new Error('Expected writeHead to receive a headers object.');
    }
    const csp = String(
      Object.entries(headers).find(
        ([name]) => name === 'Content-Security-Policy',
      )?.[1],
    );
    // The page is fully self-contained, so nothing may be fetched.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // ...but the inline style and the query-scrub script must still run.
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("script-src 'unsafe-inline'");
  });
});

describe('writeMcpOAuthCallbackPage', () => {
  it.each([
    {
      success: true,
      statusCode: 200,
      title: 'Connected',
      tone: 'background:var(--bg-accent-subtle)',
      message: `${BRAND.displayName} can now use this server.`,
    },
    {
      success: false,
      statusCode: 400,
      title: 'Couldn&#39;t connect',
      tone: 'background:var(--bg-destructive-subtle)',
      message: `Head back to ${BRAND.displayName} and try connecting again.`,
    },
  ])(
    'renders the shared MCP callback page when success is $success',
    ({ success, statusCode, title, tone, message }) => {
      const response = new ServerResponse(new IncomingMessage(new Socket()));
      const writeHead = jest.spyOn(response, 'writeHead').mockReturnThis();
      const end = jest.spyOn(response, 'end').mockReturnThis();

      writeMcpOAuthCallbackPage(response, statusCode, {
        success,
        message: 'OAuth result detail.',
      });

      expect(writeHead).toHaveBeenCalledWith(
        statusCode,
        expect.objectContaining({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        }),
      );
      const html = String(end.mock.calls[0][0]);
      expect(html).toContain(`<h1>${title}</h1>`);
      expect(html).toContain(tone);
      expect(html).toContain(`<p class="message">${message}</p>`);
      expect(html).toContain('<p class="detail">OAuth result detail.</p>');
      expect(html).toContain("history.replaceState({}, '', location.pathname)");
    },
  );
});

describe('HTML escaping', () => {
  it('escapes every HTML-significant character in caller-supplied copy', () => {
    const html = renderBrandedCallbackPage({
      tone: 'error',
      title: `&<>"'`,
      message: `&<>"'`,
      detail: `&<>"'`,
      hint: `&<>"'`,
    });

    // Every escapable character is escaped, and the raw sequence never
    // survives into the document from any of the four caller-supplied fields.
    expect(html).toContain('&amp;&lt;&gt;&quot;&#39;');
    expect(html).not.toContain(`&<>"'`);
  });

  it('escapes each emphasis segment independently', () => {
    const html = renderBrandedCallbackPage({
      tone: 'neutral',
      title: 'Title',
      message: [
        { text: `plain & ` },
        { text: `<script>`, emphasis: true },
        { text: ` tail'` },
      ],
    });

    expect(html).toContain('plain &amp; ');
    expect(html).toContain('<strong>&lt;script&gt;</strong>');
    expect(html).toContain(' tail&#39;');
    expect(html).not.toContain('<script>');
  });
});

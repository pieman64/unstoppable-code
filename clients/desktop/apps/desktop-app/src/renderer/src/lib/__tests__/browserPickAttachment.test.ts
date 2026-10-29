import type { BrowserElementSnapshot } from '@canopy/desktop-shared/types';
import {
  buildBrowserElementAttachment,
  markInAppBrowserResourceAttachment,
} from '../browserPickAttachment';

function snapshot(
  overrides: Partial<BrowserElementSnapshot> = {},
): BrowserElementSnapshot {
  return {
    browserId: 'b1',
    url: 'http://localhost:3000/login',
    title: 'Login',
    capturedAt: '2026-05-31T20:08:21.584Z',
    viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
    themeMode: 'dark',
    tagName: 'input',
    role: 'textbox',
    accessibleName: 'Email',
    value: 'user@example.com',
    attributes: { id: 'email', type: 'email' },
    bounds: { x: 10, y: 20, width: 200, height: 32 },
    preferredLocator: {
      kind: 'role',
      value: 'textbox',
      name: 'Email',
      unique: true,
      confidence: 'high',
      playwright: "page.getByRole('textbox', { name: 'Email' })",
    },
    locatorCandidates: [
      {
        kind: 'role',
        value: 'textbox',
        unique: true,
        confidence: 'high',
        playwright: "page.getByRole('textbox', { name: 'Email' })",
      },
      {
        kind: 'css',
        value: '#email',
        unique: false,
        confidence: 'low',
      },
    ],
    domPath: ['html', 'body', 'form', 'input#email'],
    outerHtml: '<input id="email" type="email" />',
    ...overrides,
  };
}

describe('buildBrowserElementAttachment', () => {
  it('produces a ui-selection-*.md filename derived from capturedAt', () => {
    const { markdownFilename } = buildBrowserElementAttachment(snapshot());
    expect(markdownFilename).toBe('ui-selection-20260531-200821.md');
  });

  it('includes header metadata, preferred locator, candidates and element', () => {
    const { markdown } = buildBrowserElementAttachment(snapshot());
    expect(markdown).toContain('# UI Element Selection');
    expect(markdown).toContain('URL: http://localhost:3000/login');
    expect(markdown).toContain('Title: Login');
    expect(markdown).toContain('Browser theme: dark');
    expect(markdown).toContain('Viewport: 1280x800 @ 2');
    expect(markdown).toContain('## Preferred Locator');
    expect(markdown).toContain("page.getByRole('textbox', { name: 'Email' })");
    expect(markdown).toContain('## Locator Candidates');
    expect(markdown).toContain('- high:');
    expect(markdown).toContain('- low:');
    expect(markdown).toContain('Tag: input');
    expect(markdown).toContain('Role: textbox');
    expect(markdown).toContain('Accessible name: Email');
    expect(markdown).toContain('Text/value: user@example.com');
    expect(markdown).toContain('Bounds: x=10, y=20, width=200, height=32');
    expect(markdown).toContain('## Attributes');
    expect(markdown).toContain('- id="email"');
    expect(markdown).toContain('## DOM Excerpt');
    expect(markdown).toContain('<input id="email" type="email" />');
  });

  it('renders recent diagnostics when provided', () => {
    const { markdown } = buildBrowserElementAttachment(snapshot(), {
      consoleErrors: [
        {
          id: 'c1',
          browserId: 'b1',
          timestamp: 1,
          level: 'error',
          text: 'Boom',
          url: 'http://localhost:3000/app.js',
          lineNumber: 12,
        },
      ],
      failedRequests: [
        {
          id: 'n1',
          browserId: 'b1',
          requestId: 'r1',
          timestamp: 1,
          method: 'GET',
          url: 'http://localhost:3000/api/me',
          failed: true,
          status: 500,
        },
      ],
    });
    expect(markdown).toContain('## Recent Browser Diagnostics');
    expect(markdown).toContain('- Boom (http://localhost:3000/app.js:12)');
    expect(markdown).toContain('- GET 500 http://localhost:3000/api/me');
  });

  it('falls back to "(none)" diagnostics when omitted', () => {
    const { markdown } = buildBrowserElementAttachment(snapshot());
    expect(markdown).toContain('Console errors:');
    expect(markdown).toContain('Failed network requests:');
    expect(markdown).toContain('(none)');
  });
});

describe('markInAppBrowserResourceAttachment', () => {
  it('marks staged browser selection attachments for the browser prompt', () => {
    expect(
      markInAppBrowserResourceAttachment({
        filename: 'ui-selection-20260531-200821.md',
        absolutePath: '/attachments/ui-selection-20260531-200821.md',
      }),
    ).toEqual({
      filename: 'ui-selection-20260531-200821.md',
      absolutePath: '/attachments/ui-selection-20260531-200821.md',
      promptKind: 'in-app-browser-resource',
    });
  });
});

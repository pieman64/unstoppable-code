/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { McpServerLogo } from '../McpServerLogo';
import { MCP_BRAND_LOGOS } from '../../lib/mcp-brand-logos';

describe('McpServerLogo', () => {
  it('falls back to the requested monogram when a brand renderer is unavailable', () => {
    const html = renderToStaticMarkup(
      <McpServerLogo
        brandMark
        size={20}
        fallback="monogram"
        fallbackTestId="brand-fallback"
        name="Canopy"
      />,
    );

    expect(html).toContain('data-testid="brand-fallback"');
    expect(html).toContain('>C</span>');
  });

  it.each(['notion', 'linear', 'airtable', 'mercury', 'sanity', 'vercel'])(
    'keeps a contrasting original backing for the monochrome %s mark',
    (key) => {
      const html = renderToStaticMarkup(
        <McpServerLogo curatedKey={key} size={20} chrome="transparent" />,
      );
      const src = html.match(/src="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
      expect(src).toBe(MCP_BRAND_LOGOS[key]);
    },
  );

  it('removes the baked avatar disc for floating prompt icons', () => {
    const html = renderToStaticMarkup(
      <McpServerLogo
        curatedKey="gmail-gmailmcp"
        size={20}
        chrome="transparent"
      />,
    );
    const src = html.match(/src="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
    expect(src).toBeDefined();
    const svg = atob(src?.split(',')[1] ?? '');
    expect(svg).toContain('viewBox="10 10 24 24"');
    expect(svg).not.toContain('<circle');
  });

  it('removes a full-canvas background from original floating marks', () => {
    const html = renderToStaticMarkup(
      <McpServerLogo curatedKey="slack" size={20} chrome="transparent" />,
    );
    const src = html.match(/src="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
    expect(src).toBeDefined();
    const svg = atob(src?.split(',')[1] ?? '');
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).not.toContain('<rect width="24" height="24"');
  });
});

it('uses the first-letter placeholder when the resolved app image fails', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => {
      root.render(
        <McpServerLogo
          size={16}
          fallback="monogram"
          name="delta-tool"
          fallbackTestId="plugin-placeholder"
          logoUrl="https://example.invalid/app.png"
          useRemoteLogo={() => 'data:image/png;base64,AAAA'}
        />,
      );
    });
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    act(() => {
      img?.dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('img')).toBeNull();
    expect(
      container.querySelector('[data-testid="plugin-placeholder"]'),
    ).toHaveProperty('textContent', 'D');
  } finally {
    act(() => root.unmount());
  }
});

it('uses the first-letter placeholder when no app image is supplied', () => {
  const html = renderToStaticMarkup(
    <McpServerLogo
      size={16}
      fallback="monogram"
      name="delta-tool"
      fallbackTestId="plugin-placeholder"
    />,
  );
  expect(html).not.toContain('<img');
  expect(html).toContain('data-testid="plugin-placeholder"');
  expect(html).toContain('>D</span>');
});

it('sends the page origin for first-party catalog logos only', () => {
  const sha = 'b'.repeat(64);
  const policy = (logoUrl: string): string | undefined => {
    const html = renderToStaticMarkup(
      <McpServerLogo
        size={20}
        logoUrl={logoUrl}
        useRemoteLogo={(url) => url}
      />,
    );
    return html.match(/referrerPolicy="([^"]+)"/i)?.[1];
  };

  expect(policy(`/api/v1/marketplace/plugins/m/p/logo?v=${sha}`)).toBe(
    'origin',
  );
  expect(
    policy(
      `https://gateway.example/agent/v1/marketplace/plugins/m/p/logo?v=${sha}`,
    ),
  ).toBe('origin');
  expect(policy('https://cdn.example/logo.png')).toBe('no-referrer');
});

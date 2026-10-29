/** @jest-environment jsdom */
import type { JSX } from 'react';
import { renderToString } from 'react-dom/server';
import type { McpServerLogoProps } from '@canopy/ui-shared';
import { MarketplaceEntityHeader } from '../MarketplaceEntityHeader';

function render(element: JSX.Element): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = renderToString(element);
  return container;
}

describe('MarketplaceEntityHeader', () => {
  it('renders a circular 40px monogram and default title id', () => {
    const container = render(
      <MarketplaceEntityHeader name="Research helper" />,
    );
    const header = container.querySelector('header');
    expect(header?.dataset.testid).toBe('marketplace-entity-header');
    expect(container.querySelector('h1')?.id).toBe('plugin-detail-title');
    expect(container.querySelector('h1')?.textContent).toBe('Research helper');
    const logo = header?.firstElementChild;
    expect(logo?.textContent).toBe('R');
    expect(logo?.className).toContain('rounded-full');
    expect(logo?.getAttribute('style')).toContain('width:40px;height:40px');
    expect(container.querySelector('p')).toBeNull();
  });

  it('renders description, custom title id, attribution, then host actions', () => {
    const container = render(
      <MarketplaceEntityHeader
        name="Research"
        titleId="research-title"
        description="Find sources"
        meta={
          <>
            Shared by <a href="/profile/ada">@ada</a>
          </>
        }
      >
        <button type="button">Install</button>
      </MarketplaceEntityHeader>,
    );
    expect(container.querySelector('h1')?.id).toBe('research-title');
    const description = container.querySelector(
      '[data-testid="share-description"]',
    );
    expect(description?.className).toContain('max-w-prose');
    expect(description?.textContent).toBe('Find sources');
    expect(container.querySelector('a')?.textContent).toBe('@ada');
    const meta = container.querySelector('a')?.parentElement;
    expect(meta?.className).toBe('mt-2 text-xs fg-tertiary');
    expect(meta?.nextElementSibling?.textContent).toBe('Install');
  });

  it('omits a description with no visible text', () => {
    const container = render(
      <MarketplaceEntityHeader name="Research" description="---" />,
    );
    expect(
      container.querySelector('[data-testid="share-description"]'),
    ).toBeNull();
  });

  it('renders a Markdown description with paragraphs and a numbered list', () => {
    const container = render(
      <MarketplaceEntityHeader
        name="Research"
        description={'# Overview\n\nFinds sources.\n\n1. Search\n2. Cite'}
      />,
    );
    const description = container.querySelector(
      '[data-testid="share-description"]',
    );
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(description?.querySelectorAll('ol > li')).toHaveLength(2);
    expect(description?.textContent).not.toContain('#');
  });

  it('passes the catalog logo recipe and source to a host adapter', () => {
    const received: McpServerLogoProps[] = [];
    function Logo(props: McpServerLogoProps): JSX.Element {
      received.push(props);
      return <span>Logo</span>;
    }
    render(
      <MarketplaceEntityHeader
        name="Research"
        logo={{
          logoUrl: 'https://example.com/logo.png',
          bundledLogo: '/logo.svg',
          brandMark: true,
        }}
        McpServerLogoComponent={Logo}
      />,
    );
    expect(received).toEqual([
      {
        name: 'Research',
        logoUrl: 'https://example.com/logo.png',
        bundledLogo: '/logo.svg',
        brandMark: true,
        size: 40,
        fallback: 'monogram',
        shape: 'circle',
        fit: 'contain',
      },
    ]);
  });
});

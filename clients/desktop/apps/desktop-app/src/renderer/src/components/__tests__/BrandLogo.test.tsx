/**
 * BrandLogo desktop renderer tests.
 *
 * The desktop brand SVG content is the `assets.logoSvg` value exposed by
 * `@canopy/brand/current` (resolved by jest's `moduleNameMapper` to the
 * materialized `.cache/brand/current/desktop-brand.ts` file).
 *
 * These tests verify:
 *   1. `BrandLogo` renders the brand's inline SVG artwork inside an
 *      accessible, size-owning wrapper `<span>`.
 *   2. The default-brand snapshot pins the rendered output so any future
 *      change to either the component shape or the brand-runtime SVG is
 *      caught (byte-for-byte assertion against the current brand cache).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { BRAND } from '@canopy/brand/current';
import { BrandLogo } from '@/components/BrandLogo';

describe('BrandLogo (desktop renderer)', () => {
  it('renders the brand SVG artwork inside the wrapper', () => {
    const html = renderToStaticMarkup(<BrandLogo />);
    const brandPath = BRAND.assets.logoSvg.match(/<path\b[^>]*>/)?.[0];
    expect(brandPath).toBeDefined();
    expect(html).toContain(brandPath);
  });

  it('normalizes brand SVG sizing to fit the wrapper', () => {
    const html = renderToStaticMarkup(<BrandLogo />);
    expect(html).toContain('width="100%"');
    expect(html).toContain('height="100%"');
    expect(html).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(html).toContain('style="display:block"');
  });

  it('exposes role=img and brand-derived aria-label by default', () => {
    const html = renderToStaticMarkup(<BrandLogo />);
    expect(html).toContain('role="img"');
    expect(html).toContain(`aria-label="${BRAND.displayName} logo"`);
  });

  it('forwards aria-hidden and drops role/aria-label when requested', () => {
    const html = renderToStaticMarkup(<BrandLogo aria-hidden={true} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain('aria-label=');
  });

  it('forwards size to wrapper width and height styles', () => {
    const html = renderToStaticMarkup(<BrandLogo size={14} />);
    expect(html).toContain('width:14px');
    expect(html).toContain('height:14px');
  });

  it('forwards className override to the wrapper after its own geometry', () => {
    const html = renderToStaticMarkup(
      <BrandLogo className="h-4 w-4 shrink-0" />,
    );
    expect(html).toContain(
      'class="inline-flex flex-none items-center justify-center overflow-hidden leading-0 h-4 w-4 shrink-0"',
    );
  });

  it('default-brand snapshot pins the rendered output', () => {
    expect(renderToStaticMarkup(<BrandLogo />)).toMatchSnapshot();
  });
});

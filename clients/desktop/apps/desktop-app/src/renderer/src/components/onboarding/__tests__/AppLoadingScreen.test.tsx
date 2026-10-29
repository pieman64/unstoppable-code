/**
 * Adaptation from spec: brand.logo does not exist on DesktopBrandRuntime.
 * The logo is brand.assets.logoSvg (inline SVG markup). BrandLogo renders it
 * as a <span role="img" aria-label="${displayName} logo"> via
 * dangerouslySetInnerHTML. Tests use renderToStaticMarkup (matching the repo's
 * renderer test pattern) rather than @testing-library/react, which is not
 * available in the node Jest environment.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { AppLoadingScreen } from '../AppLoadingScreen';

jest.mock('@/lib/brand', () => ({
  brand: {
    displayName: 'Mock App',
    assets: {
      logoSvg: '<svg><path d="M0 0"/></svg>',
    },
  },
  brandText: { appName: 'Mock App' },
}));

describe('AppLoadingScreen', () => {
  test('renders the brand logo with an aria-label', () => {
    const html = renderToStaticMarkup(<AppLoadingScreen />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Mock App logo"');
  });

  test('applies the pulsate animation class to the logo wrapper', () => {
    const html = renderToStaticMarkup(<AppLoadingScreen />);
    expect(html).toContain('onboarding-logo-pulse');
  });

  test('fills the viewport with background tokens', () => {
    const html = renderToStaticMarkup(<AppLoadingScreen />);
    expect(html).toContain('fixed');
    expect(html).toContain('inset-0');
    expect(html).toContain('bg-base');
  });
});

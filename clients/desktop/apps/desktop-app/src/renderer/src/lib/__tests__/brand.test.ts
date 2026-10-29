import { BRAND } from '@canopy/brand/current';
import { brand, brandText, formatBrandText } from '../brand';

describe('renderer brand helper', () => {
  it('re-exports the desktop brand runtime', () => {
    expect(brand).toBe(BRAND);
  });

  it('exposes the display, server, and CLI names as live getters', () => {
    expect(brandText.appName).toBe(BRAND.displayName);
    expect(brandText.serverName).toBe(BRAND.serverDisplayName);
    expect(brandText.cliName).toBe(BRAND.cliName);
    expect(brandText.shortName).toBe(BRAND.shortName);
  });

  it('substitutes {app}, {server}, {cli}, {short} tokens in formatBrandText', () => {
    expect(formatBrandText('Hello from {app}')).toBe(
      `Hello from ${BRAND.displayName}`,
    );
    expect(formatBrandText('Connect to {server} as {cli}')).toBe(
      `Connect to ${BRAND.serverDisplayName} as ${BRAND.cliName}`,
    );
    expect(formatBrandText('{short} mode')).toBe(`${BRAND.shortName} mode`);
  });

  it('leaves non-matching braces untouched', () => {
    expect(formatBrandText('Path is /tmp/{file}.log')).toBe(
      'Path is /tmp/{file}.log',
    );
  });
});

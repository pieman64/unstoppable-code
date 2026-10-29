/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { ProviderSupportIcons } from '../ProviderSupportIcons';

describe('ProviderSupportIcons', () => {
  it('renders Claude + Codex icons when both providers are native', () => {
    const html = renderToStaticMarkup(
      <ProviderSupportIcons support={{ claude: 'native', codex: 'native' }} />,
    );
    expect(html).toContain('provider-support-icon-claude');
    expect(html).toContain('provider-support-icon-codex-native');
    expect(html).not.toContain('provider-support-icon-codex-compat');
  });

  it('uses the muted color for enabled native provider icons', () => {
    const html = renderToStaticMarkup(
      <ProviderSupportIcons support={{ claude: 'native', codex: 'native' }} />,
    );
    expect(html).toContain('fg-secondary');
    expect(html).not.toContain('fg-accent');
  });

  it('renders the warning-tinted Codex compatibility icon when only Codex is in compat mode', () => {
    const html = renderToStaticMarkup(
      <ProviderSupportIcons support={{ claude: 'native', codex: 'compat' }} />,
    );
    expect(html).toContain('provider-support-icon-claude');
    expect(html).toContain('provider-support-icon-codex-compat');
    expect(html).toContain(
      'Generated from Claude plugin for Codex compatibility.',
    );
    expect(html).toContain('fg-warning');
  });

  it('keeps the warning-tinted compat icon when codexCompatDisabled is false', () => {
    const html = renderToStaticMarkup(
      <ProviderSupportIcons
        support={{ claude: 'native', codex: 'compat' }}
        codexCompatDisabled={false}
      />,
    );
    expect(html).toContain('provider-support-icon-codex-compat');
    expect(html).toContain('fg-warning');
    expect(html).toContain(
      'Generated from Claude plugin for Codex compatibility.',
    );
  });

  it('renders a faded disabled Codex compat icon when codexCompatDisabled is true', () => {
    const html = renderToStaticMarkup(
      <ProviderSupportIcons
        support={{ claude: 'native', codex: 'compat' }}
        codexCompatDisabled={true}
      />,
    );
    expect(html).toContain('provider-support-icon-codex-compat');
    expect(html).toContain('fg-secondary/40');
    expect(html).toContain('Codex compatibility mode is disabled');
    expect(html).not.toContain('text-amber-500');
  });

  it('preserves caller placement classes while fading a disabled Codex compat icon', () => {
    const html = renderToStaticMarkup(
      <ProviderSupportIcons
        support={{ claude: 'native', codex: 'compat' }}
        iconClassName="relative shrink-0"
        codexCompatDisabled={true}
      />,
    );
    expect(html).toContain('provider-support-icon-codex-compat');
    expect(html).toContain('relative shrink-0 opacity-40');
  });

  it('renders just the Codex icon for a Codex-only plugin', () => {
    const html = renderToStaticMarkup(
      <ProviderSupportIcons support={{ claude: 'none', codex: 'native' }} />,
    );
    expect(html).not.toContain('provider-support-icon-claude');
    expect(html).toContain('provider-support-icon-codex-native');
  });

  it('returns null when no providers support the plugin', () => {
    const html = renderToStaticMarkup(
      <ProviderSupportIcons support={{ claude: 'none', codex: 'none' }} />,
    );
    expect(html).toBe('');
  });

  it('uses the Codex-only tooltip when scope=claude and codex-only', () => {
    const html = renderToStaticMarkup(
      <ProviderSupportIcons
        support={{ claude: 'none', codex: 'native' }}
        scope="claude"
      />,
    );
    expect(html).toContain('Only available for Codex');
  });

  it('uses the Claude-available-via-compat tooltip when scope=codex and only compat is present', () => {
    const html = renderToStaticMarkup(
      <ProviderSupportIcons
        support={{ claude: 'native', codex: 'compat' }}
        scope="codex"
      />,
    );
    expect(html).toContain('Available for Codex through compatibility mode');
  });
});

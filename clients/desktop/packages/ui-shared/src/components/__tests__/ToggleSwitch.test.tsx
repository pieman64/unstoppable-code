import { renderToStaticMarkup } from 'react-dom/server';
import { CompactToggleIndicator, ToggleSwitch } from '../ToggleSwitch';

function render(size?: 'md' | 'sm', checked = false): string {
  return renderToStaticMarkup(
    <ToggleSwitch
      checked={checked}
      label="Auto save"
      onChange={() => undefined}
      size={size}
    />,
  );
}

describe('ToggleSwitch', () => {
  it('renders the setting-row switch with the house focus ring', () => {
    const html = render();
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="Auto save"');
    expect(html).toContain('focus-ring');
    expect(html).toContain('h-4.5 w-8');
    expect(html).toContain('h-3.5 w-3.5');
    expect(html).toContain('bg-fg-quaternary');
    expect(html).toContain('translate-x-0');
  });

  it('moves the knob to the end on the accent track when on', () => {
    const html = render('md', true);
    expect(html).toContain('bg-accent');
    expect(html).toContain('translate-x-3.5');
    expect(html).not.toContain('bg-fg-quaternary');
  });

  it('draws the compact size exactly like the Pipeline toggle indicator', () => {
    const switchHtml = render('sm', true);
    const indicatorHtml = renderToStaticMarkup(
      <CompactToggleIndicator checked />,
    );
    expect(switchHtml).toContain(indicatorHtml);
    expect(indicatorHtml).toContain('h-4 w-7');
    expect(indicatorHtml).toContain('h-3 w-3');
    expect(indicatorHtml).toContain('translate-x-3');
  });
});

describe('ToggleSwitch feedback', () => {
  it('changes color at once: no color transition on the track', () => {
    const markup = renderToStaticMarkup(
      <ToggleSwitch checked={false} label="Email me" onChange={() => {}} />,
    );
    expect(markup).not.toContain('background-color');
    expect(markup).not.toMatch(/transition-colors|transition-all/);
  });

  it('reaches a touch-sized hit area on a coarse pointer', () => {
    const markup = renderToStaticMarkup(
      <ToggleSwitch checked={false} label="Email me" onChange={() => {}} />,
    );
    expect(markup).toContain('pointer-coarse:before:-inset-y-3');
  });
});

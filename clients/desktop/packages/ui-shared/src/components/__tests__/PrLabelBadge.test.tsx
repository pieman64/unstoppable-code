import { renderToString } from 'react-dom/server';
import { PrLabelBadge } from '../PrLabelBadge';

describe('PrLabelBadge', () => {
  it('renders the label name and applies the mode-adaptive class', () => {
    const html = renderToString(<PrLabelBadge name="bug" color="d73a4a" />);

    expect(html).toContain('bug');
    expect(html).toContain('canopy-pr-label');
  });

  it('sets a solid fill and light-mode custom properties from the hex color', () => {
    const html = renderToString(<PrLabelBadge name="bug" color="d73a4a" />);

    expect(html).toContain('--pr-label-bg:rgb(215, 58, 74)');
    // Light-mode text uses YIQ contrast: a dark red needs white text.
    expect(html).toContain('--pr-label-fg:#ffffff');
  });

  it('uses dark text on a light label color in light mode', () => {
    const html = renderToString(
      <PrLabelBadge name="enhancement" color="a2eeef" />,
    );

    expect(html).toContain('--pr-label-fg:#000000');
  });

  it('derives a translucent tint and lightened, label-hued text for dark mode', () => {
    const html = renderToString(<PrLabelBadge name="bug" color="d73a4a" />);

    expect(html).toContain('--pr-label-bg-dark:rgba(215, 58, 74, 0.18)');
    // Dark-mode text is the label hue lightened for legibility on the tint.
    expect(html).toContain('--pr-label-fg-dark:hsl(354, 66%, 78%)');
    expect(html).toContain('--pr-label-border-dark:hsla(354, 66%, 78%, 0.3)');
  });

  it('accepts a color with a leading hash', () => {
    const html = renderToString(<PrLabelBadge name="bug" color="#d73a4a" />);

    expect(html).toContain('--pr-label-bg:rgb(215, 58, 74)');
  });

  it('falls back to neutral theme tokens for a malformed color', () => {
    const html = renderToString(<PrLabelBadge name="mystery" color="" />);

    expect(html).toContain('mystery');
    expect(html).toContain('bg-muted');
    expect(html).not.toContain('canopy-pr-label');
    expect(html).not.toContain('--pr-label-bg');
  });

  it('exposes the description as a tooltip', () => {
    const html = renderToString(
      <PrLabelBadge name="bug" color="d73a4a" description="Broken behavior" />,
    );

    expect(html).toContain('title="Broken behavior"');
  });
});

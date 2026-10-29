import { renderToStaticMarkup } from 'react-dom/server';
import { RefreshSpinner } from '../RefreshSpinner';

function classTokens(html: string): string[] {
  return (/class="([^"]*)"/.exec(html)?.[1] ?? '').split(/\s+/);
}

describe('RefreshSpinner', () => {
  it('inherits the surrounding ink by default and spins only when asked', () => {
    const resting = renderToStaticMarkup(<RefreshSpinner />);
    const spinning = renderToStaticMarkup(<RefreshSpinner spinning />);

    expect(classTokens(resting).some((token) => token.startsWith('fg-'))).toBe(
      false,
    );
    expect(classTokens(resting)).not.toContain('animate-spin');
    expect(classTokens(spinning)).toContain('animate-spin');
  });

  it('takes the shared spinner tones', () => {
    const tokens = classTokens(
      renderToStaticMarkup(<RefreshSpinner tone="accent" className="mr-1" />),
    );

    expect(tokens).toContain('fg-accent');
    expect(tokens).toContain('mr-1');
  });
});

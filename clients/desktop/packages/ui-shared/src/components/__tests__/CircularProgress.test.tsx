import { renderToStaticMarkup } from 'react-dom/server';
import { CircularProgress } from '../CircularProgress';
import { getUsageRingTone } from '../UsageIndicator';

function strokes(markup: string): { track?: string; arc?: string } {
  const read = (part: string): string | undefined =>
    new RegExp(`data-part="${part}"[^>]*stroke="([^"]+)"`).exec(markup)?.[1];
  return { track: read('track'), arc: read('arc') };
}

describe('CircularProgress', () => {
  it('draws the full track in the subtle surface of the arc role', () => {
    expect(
      strokes(
        renderToStaticMarkup(
          <CircularProgress percentage={50} tone="warning" />,
        ),
      ),
    ).toEqual({
      track: 'var(--bg-warning-subtle)',
      arc: 'var(--fg-warning)',
    });
    expect(
      strokes(
        renderToStaticMarkup(
          <CircularProgress percentage={50} tone="destructive" />,
        ),
      ),
    ).toEqual({
      track: 'var(--bg-destructive-subtle)',
      arc: 'var(--fg-destructive)',
    });
    expect(
      strokes(
        renderToStaticMarkup(
          <CircularProgress percentage={50} tone="accent" />,
        ),
      ),
    ).toEqual({ track: 'var(--bg-accent-subtle)', arc: 'var(--fg-accent)' });
  });

  it('keeps a neutral ring on the muted surface', () => {
    expect(
      strokes(
        renderToStaticMarkup(
          <CircularProgress percentage={50} tone="neutral" />,
        ),
      ),
    ).toEqual({ track: 'var(--bg-muted)', arc: 'var(--fg-secondary)' });
  });

  it('animates only the arc length, never every property', () => {
    const markup = renderToStaticMarkup(
      <CircularProgress percentage={50} tone="neutral" />,
    );
    expect(markup).not.toContain('transition-all');
  });
});

describe('getUsageRingTone', () => {
  it('warns from 70% and turns destructive from 90%', () => {
    expect(getUsageRingTone(10)).toBe('neutral');
    expect(getUsageRingTone(69.9)).toBe('neutral');
    expect(getUsageRingTone(70)).toBe('warning');
    expect(getUsageRingTone(89.9)).toBe('warning');
    expect(getUsageRingTone(90)).toBe('destructive');
  });
});

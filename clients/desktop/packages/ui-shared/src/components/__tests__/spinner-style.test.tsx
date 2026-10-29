/**
 * A host can draw every shared spinner as the comet ring (desktop early
 * access). The swap keeps each spinner's accessible name, test hook, and
 * footprint, and reads activity in the primary ink rather than the accent.
 */
import type { JSX } from 'react';
import { renderToString } from 'react-dom/server';
import { LoadingSpinner } from '../LoadingSpinner';
import { RunSpinner } from '../RunSpinner';
import { ThinkingSpinner } from '../ThinkingSpinner';
import { SpinnerStyleProvider } from '../spinner-style';

function inComet(element: JSX.Element): string {
  return renderToString(
    <SpinnerStyleProvider value="comet">{element}</SpinnerStyleProvider>,
  );
}

describe('shared spinner style', () => {
  it('keeps the dot grids by default', () => {
    expect(renderToString(<LoadingSpinner />)).toContain('animate-loading-dot');
    expect(renderToString(<ThinkingSpinner />)).toContain(
      'animate-thinking-dot',
    );
    expect(renderToString(<RunSpinner />)).toContain('animate-run-dot');
  });

  it('draws every shared spinner as the comet under the provider', () => {
    for (const html of [
      inComet(<LoadingSpinner />),
      inComet(<ThinkingSpinner />),
      inComet(<RunSpinner />),
    ]) {
      expect(html).toContain('data-spinner="comet"');
      expect(html).not.toMatch(/animate-(loading|thinking|run)-dot/);
    }
  });

  it('keeps names, test hooks, and the 10px footprint', () => {
    const loading = inComet(<LoadingSpinner dataTestId="busy" />);
    expect(loading).toContain('aria-label="Loading"');
    expect(loading).toContain('data-testid="busy"');
    expect(loading).toContain('width:10px');
    expect(inComet(<LoadingSpinner decorative />)).toContain(
      'aria-hidden="true"',
    );
    expect(inComet(<ThinkingSpinner />)).toContain('aria-label="Thinking"');
    expect(inComet(<RunSpinner />)).toContain('aria-label="Running"');
    expect(inComet(<LoadingSpinner sizePx={16} />)).toContain('width:16px');
  });

  it('reads the accent tone in the primary ink and keeps other tones', () => {
    const accent = inComet(<ThinkingSpinner tone="accent" />);
    expect(accent).toContain('fg-primary');
    expect(accent).not.toContain('fg-accent');
    expect(inComet(<LoadingSpinner tone="emphasis" />)).toContain(
      'fg-emphasis',
    );
    expect(inComet(<LoadingSpinner tone="warning" />)).toContain('fg-warning');
  });
});

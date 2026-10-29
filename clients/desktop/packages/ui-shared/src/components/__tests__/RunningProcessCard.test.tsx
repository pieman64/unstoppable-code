import { renderToStaticMarkup } from 'react-dom/server';
import { AnsiOutput } from '../AnsiOutput';
import { RunningProcessCard } from '../RunningProcessCard';

describe('RunningProcessCard', () => {
  it('keeps the live tail concentric: card radius minus card inset', () => {
    const markup = renderToStaticMarkup(
      <RunningProcessCard
        dataTestId="card"
        statusContent="Running build…"
        stopLabel="Stop"
        spinner={<span />}
        body={
          <AnsiOutput lines={['building']} variant="tail" maxRenderLines={12} />
        }
      />,
    );
    const card = /<div[^>]*data-testid="card"[^>]*>/.exec(markup)?.[0] ?? '';
    const tail =
      /<div[^>]*data-testid="ansi-output"[^>]*>/.exec(markup)?.[0] ?? '';

    // 12px card radius (rounded-lg) - 8px inset (p-2) = the tail's 4px radius
    // (rounded-sm). The three values change together, here and in AnsiOutput.
    expect(card).toMatch(/\brounded-lg\b/);
    expect(card).toMatch(/\bp-2\b/);
    expect(card).not.toMatch(/\bp-2\.5\b/);
    expect(tail).toMatch(/\brounded-sm\b/);
  });
});

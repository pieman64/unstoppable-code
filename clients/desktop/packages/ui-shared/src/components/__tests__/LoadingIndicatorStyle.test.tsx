/**
 * @jest-environment jsdom
 */
import type { JSX } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BusyLabel } from '../BusyLabel';
import {
  LoadingIndicator,
  LoadingIndicatorStyleProvider,
} from '../LoadingIndicatorStyle';

function inSpinnerStyle(element: JSX.Element): string {
  return renderToStaticMarkup(
    <LoadingIndicatorStyleProvider value="spinner">
      {element}
    </LoadingIndicatorStyleProvider>,
  );
}

describe('LoadingIndicator', () => {
  it('shows the loading copy by default', () => {
    expect(renderToStaticMarkup(<LoadingIndicator />)).toBe('Loading…');
    expect(renderToStaticMarkup(<LoadingIndicator text="Loading…" />)).toBe(
      'Loading…',
    );
  });

  it('shows a spinner instead under the spinner style', () => {
    const markup = inSpinnerStyle(<LoadingIndicator text="Loading…" />);
    expect(markup).toContain('aria-label="Loading"');
    expect(markup).not.toContain('Loading…');
  });
});

/** The label a reader sees: reserved labels hold room but add no text. */
function visibleText(element: JSX.Element): string {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(element);
  return container.textContent ?? '';
}

describe('BusyLabel', () => {
  it('swaps the label for the busy copy by default', () => {
    expect(visibleText(<BusyLabel busy>Load more</BusyLabel>)).toBe('Loading…');
    expect(
      visibleText(
        <BusyLabel busy busyText="Loading…">
          Load more
        </BusyLabel>,
      ),
    ).toBe('Loading…');
    expect(visibleText(<BusyLabel busy={false}>Load more</BusyLabel>)).toBe(
      'Load more',
    );
  });

  it('keeps the label hidden under a spinner under the spinner style', () => {
    const busy = inSpinnerStyle(<BusyLabel busy>Load more</BusyLabel>);
    expect(busy).toContain('class="invisible"');
    expect(busy).toContain('Load more');
    expect(busy).toContain('aria-label="Loading"');
    expect(busy).not.toContain('Loading…');

    const idle = inSpinnerStyle(<BusyLabel busy={false}>Load more</BusyLabel>);
    expect(idle).toContain('Load more');
    expect(idle).not.toContain('invisible');
    expect(idle).not.toContain('aria-label="Loading"');
  });
});

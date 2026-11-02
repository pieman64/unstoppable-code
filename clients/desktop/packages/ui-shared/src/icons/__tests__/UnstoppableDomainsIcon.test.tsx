/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { UnstoppableDomainsIcon } from '../UnstoppableDomainsIcon';

describe('UnstoppableDomainsIcon', () => {
  it('renders the official brand fills by default', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(<UnstoppableDomainsIcon />);

    expect(
      Array.from(container.querySelectorAll('path'), (path) =>
        path.getAttribute('fill'),
      ),
    ).toEqual(['#00C9FF', '#0D67FE']);
  });

  it('renders both paths in the surrounding color for mono tone', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <UnstoppableDomainsIcon tone="mono" />,
    );

    expect(
      Array.from(container.querySelectorAll('path'), (path) =>
        path.getAttribute('fill'),
      ),
    ).toEqual(['currentColor', 'currentColor']);
  });
});

/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ExternalTextLink } from '../ExternalTextLink';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('ExternalTextLink', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('opens its page outside the app without handing over the opener', () => {
    act(() => {
      root.render(
        <ExternalTextLink href="https://example.com/docs" label="Website" />,
      );
    });
    const link = container.querySelector('a');
    expect(link?.textContent).toBe('Website');
    expect(link?.getAttribute('href')).toBe('https://example.com/docs');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
